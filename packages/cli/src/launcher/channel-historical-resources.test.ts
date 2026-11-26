import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { ChannelHistoricalResources } from './channel-historical-resources.js'

const source: ChannelEventRef = {
  adapterId: 'feishu',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'oc_chat',
  kind: 'group',
  threadId: 'oc_chat',
  semantics: 'conversation',
  eventId: 'incoming',
  messageId: 'om_incoming',
  actor: { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant', userId: 'ou_actor' },
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])
const item = { message_id: 'om_old', chat_id: 'oc_chat', msg_type: 'image', body: { content: '{"image_key":"key"}' } }
const channel = (get = vi.fn(async () => ({ code: 0, data: { items: [item] } }))) => {
  const download = vi.fn(async () => ({ getReadableStream: () => Readable.from([png]) }))
  const value = { rawClient: { im: { v1: { message: { get }, messageResource: { get: download } } } } }
  return { get, download, value: value as unknown as Parameters<ChannelHistoricalResources['read']>[5] }
}

describe('historical resource SDK acquisition and consumption', () => {
  it('redacts SDK and filesystem diagnostics from the public result', async () => {
    const service = new ChannelHistoricalResources(), sdk = channel()
    sdk.get.mockRejectedValueOnce(new Error('GET https://private.example/secret local /tmp/private token'))
    try {
      expect(await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {}))
        .toEqual({ status: 'unavailable', code: 'HISTORICAL_RESOURCE_READ_FAILED' })
      sdk.get.mockRejectedValueOnce(new Error('RESOURCE_PRIVATE_DIAGNOSTIC_TOKEN'))
      expect(await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {}))
        .toEqual({ status: 'unavailable', code: 'HISTORICAL_RESOURCE_READ_FAILED' })
      sdk.download.mockRejectedValueOnce(new Error('CHANNEL_PRIVATE_DIAGNOSTIC_TOKEN'))
      expect(await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {}))
        .toEqual({ status: 'unavailable', code: 'HISTORICAL_RESOURCE_READ_FAILED' })
    } finally {
      await service.dispose()
    }
  })
  it('keeps separate live generations isolated and cancels an active download stream', async () => {
    const service = new ChannelHistoricalResources(), next = new ChannelHistoricalResources(), sdk = channel()
    try {
      await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {})
      expect(await next.read(source, 'om_old', 0, false, 'session', sdk.value, () => {}))
        .toMatchObject({ resource: { state: 'not-prepared' } })
      const stream = new Readable({ read() {} }), controller = new AbortController()
      let started!: () => void
      const ready = new Promise<void>(resolve => {
        started = resolve
      })
      sdk.download.mockImplementationOnce(async () => ({
        getReadableStream: () => {
          started()
          return stream
        },
      }))
      const operation = next.read(
        source,
        'om_old',
        0,
        true,
        'session',
        sdk.value,
        () => {},
        undefined,
        controller.signal,
      )
        .catch(error => error.message)
      await ready
      controller.abort()
      expect(await operation).toBe('HISTORICAL_RESOURCE_TIMEOUT')
      expect(stream.destroyed).toBe(true)
    } finally {
      await service.dispose()
      await next.dispose()
    }
  })
  it('verifies association and prepares/reads bounded bytes without paths or keys', async () => {
    const service = new ChannelHistoricalResources(), sdk = channel()
    try {
      const prepared = await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {})
      expect(prepared).toMatchObject({ status: 'ok', resource: { state: 'ready' } })
      const result = await service.read(
        { ...source, eventId: 'next-turn', messageId: 'om_next' },
        'om_old',
        0,
        false,
        'session',
        sdk.value,
        () => {},
        { offset: 0, length: 8 },
      )
      expect(result).toMatchObject({
        chunk: { base64: png.subarray(0, 8).toString('base64'), nextOffset: 8, hasMore: true },
      })
      const final = await service.read(source, 'om_old', 0, false, 'session', sdk.value, () => {}, {
        offset: 8,
        length: 65536,
      })
      expect(final).toMatchObject({
        chunk: { base64: png.subarray(8).toString('base64'), nextOffset: 10, hasMore: false },
      })
      expect(sdk.get).toHaveBeenCalledTimes(3)
      expect(sdk.download).toHaveBeenCalledExactlyOnceWith({
        path: { message_id: 'om_old', file_key: 'key' },
        params: { type: 'image' },
      })
      expect(JSON.stringify(result)).not.toContain('file_key')
      expect(JSON.stringify(result)).not.toContain('/tmp/')
    } finally {
      await service.dispose()
    }
  })
  it('does not transfer caller, actor, source or generation ownership', async () => {
    const service = new ChannelHistoricalResources(), sdk = channel()
    try {
      await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {})
      expect(await service.read(source, 'om_old', 0, false, 'other-session', sdk.value, () => {}))
        .toMatchObject({ resource: { state: 'not-prepared' } })
      expect(
        await service.read(
          { ...source, actor: { ...source.actor!, userId: 'ou_other' } },
          'om_old',
          0,
          false,
          'session',
          sdk.value,
          () => {},
        ),
      ).toMatchObject({ resource: { state: 'not-prepared' } })
      await expect(
        service.read(source, 'om_old', 0, false, 'other-session', sdk.value, () => {}, { offset: 0, length: 1 }),
      )
        .rejects.toThrow('RESOURCE_NOT_READY')
    } finally {
      await service.dispose()
    }
    expect(await service.read(source, 'om_old', 0, false, 'session', sdk.value, () => {})).toMatchObject({
      status: 'unavailable',
    })
  })
  it('rejects conflicting remote association before download', async () => {
    const service = new ChannelHistoricalResources()
    const sdk = channel(vi.fn(async () => ({ code: 0, data: { items: [{ ...item, chat_id: 'oc_other' }] } })))
    try {
      await expect(service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {}))
        .rejects.toThrow('HISTORICAL_RESOURCE_SOURCE_MISMATCH')
      expect(sdk.download).not.toHaveBeenCalled()
    } finally {
      await service.dispose()
    }
  })
  it('keeps unsettled SDK capacity reserved and fences late downloads after timeout', async () => {
    vi.useFakeTimers()
    let resolve!: (value: { code: number; data: { items: typeof item[] } }) => void
    const pending = new Promise<{ code: number; data: { items: typeof item[] } }>(done => {
      resolve = done
    })
    const sdk = channel(vi.fn(() => pending)), service = new ChannelHistoricalResources()
    try {
      const calls = Array.from(
        { length: 4 },
        () =>
          service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {})
            .catch(error => error.message),
      )
      await vi.advanceTimersByTimeAsync(2501)
      expect(await Promise.all(calls)).toEqual(Array(4).fill('HISTORICAL_RESOURCE_TIMEOUT'))
      expect(await service.read(source, 'om_old', 0, true, 'session', sdk.value, () => {}))
        .toEqual({ status: 'unavailable', code: 'HISTORICAL_RESOURCE_BUSY' })
      resolve({ code: 0, data: { items: [item] } })
      await vi.advanceTimersByTimeAsync(1)
      expect(sdk.download).not.toHaveBeenCalled()
    } finally {
      await service.dispose()
      vi.useRealTimers()
    }
  })
  it('rechecks authorization after SDK response and before consumption', async () => {
    const service = new ChannelHistoricalResources(), sdk = channel()
    let permitted = true
    const authorize = () => {
      if (!permitted) throw new Error('CHANNEL_POLICY_DENIED')
    }
    try {
      sdk.get.mockImplementationOnce(async () => {
        permitted = false
        return { code: 0, data: { items: [item] } }
      })
      await expect(service.read(source, 'om_old', 0, true, 'session', sdk.value, authorize)).rejects.toThrow(
        'CHANNEL_POLICY_DENIED',
      )
      expect(sdk.download).not.toHaveBeenCalled()
    } finally {
      await service.dispose()
    }
  })
})
