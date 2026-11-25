import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createChannelThreadForwardService } from './channel-thread-forward-service.js'
import { threadForwardCodec } from './channel-thread-forward-validation.js'
import { ChannelForwardStore } from './channel-forward-store.js'

const source = {
  adapterId: 'feishu',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'oc_source',
  kind: 'group' as const,
}
const request = {
  contract: 'cordisx.channel-thread-forward/v1' as const,
  schemaVersion: 1 as const,
  operation: 'thread-forward' as const,
  operationId: 'stable',
  source,
  target: { ...source, conversationId: 'oc_target' },
  threadId: 'omt_topic',
  anchorMessageId: 'om_anchor',
}
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'thread-forward-test-'))
  directories.push(directory)
  const filename = path.join(directory, 'ledger.json')
  const get = vi.fn(async () => ({
    code: 0,
    data: { items: [{ message_id: 'om_anchor', chat_id: 'oc_source', thread_id: 'omt_topic' }] },
  }))
  const forward = vi.fn(async (_input: unknown) => ({
    code: 0,
    data: { message_id: 'om_native', chat_id: 'oc_target' },
  }))
  const channel = {
    rawClient: {
      im: {
        v1: {
          message: { get },
          thread: { forward },
          chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
        },
      },
    },
  } as never
  const factory = () =>
    createChannelThreadForwardService({ filename, channel: () => channel, active: () => true, supported: () => true })
  return { filename, get, forward, factory }
}

describe('durable whole-topic operation identity', () => {
  it('coalesces duplicates and retains the full topic fingerprint across restarts', async () => {
    const { factory, forward } = await setup()
    const service = factory()
    const results = await Promise.all([
      service(request, 'caller', false, () => {}),
      service(request, 'caller', false, () => {}),
    ])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ state: 'sent', operationId: 'stable' })
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward.mock.calls[0]?.[0]).toMatchObject({ params: { uuid: expect.stringMatching(/^[a-f0-9]{32}$/u) } })
    expect(await factory()(request, 'caller', true, () => {})).toEqual(results[0])
    expect(forward).toHaveBeenCalledTimes(1)
    await expect(service({ ...request, threadId: 'omt_changed' }, 'caller', false, () => {}))
      .rejects.toThrow('FORWARD_OPERATION_CONFLICT')
  })
  it('does not expose or replay another caller operation and reauthorizes receipt reads', async () => {
    const { factory, forward } = await setup()
    const service = factory()
    await service(request, 'caller', false, () => {})
    expect(await service(request, 'other-caller', true, () => {})).toBeUndefined()
    await expect(service(request, 'caller', true, () => {
      throw new Error('DENIED')
    })).rejects.toThrow('DENIED')
    expect(forward).toHaveBeenCalledTimes(1)
  })
  it('turns interrupted sending into durable unknown without any platform replay', async () => {
    const { filename, factory, forward } = await setup()
    const identity = createHash('sha256').update(JSON.stringify(['caller', 'stable'])).digest('hex')
    await writeFile(filename, JSON.stringify({ [identity]: { request, receipt: threadForwardCodec.pending(request) } }))
    const receipt = await factory()(request, 'caller', true, () => {})
    expect(receipt).toMatchObject({ state: 'unknown', code: 'FORWARD_INTERRUPTED' })
    expect(await factory()(request, 'caller', false, () => {})).toEqual(receipt)
    expect(forward).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(filename, 'utf8'))[identity].receipt.state).toBe('unknown')
  })
  it('refuses malformed receipt state and never upgrades it to sent', async () => {
    const { filename } = await setup()
    const store = new ChannelForwardStore(filename, threadForwardCodec)
    const perform = vi.fn(async () => ({ ...threadForwardCodec.pending(request), state: 'sent' }) as never)
    expect(await store.run('caller', request, perform)).toMatchObject({
      state: 'unknown',
      code: 'FORWARD_RECEIPT_INVALID',
    })
    expect(await store.run('caller', request, perform)).toMatchObject({ state: 'unknown' })
    expect(perform).toHaveBeenCalledTimes(1)
  })
})
