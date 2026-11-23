import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelMediaPrepareRequestV1 } from '@cordisx/protocol/channel-outbound/v1'
import { ChannelOutboundRpc } from './channel-outbound-rpc.js'
import { channelOutboundRuntimeOptions } from './channel-outbound-runtime-options.js'

const outbound = new Set<ChannelOutboundRpc>()
afterEach(() => {
  for (const store of outbound) store.dispose()
  outbound.clear()
})
function fixture() {
  const store = new ChannelOutboundRpc()
  outbound.add(store)
  return { store, options: channelOutboundRuntimeOptions(store) }
}
const caller = { source: 'plugin', pluginId: 'plugin', generation: 'one' }
const target = {
  adapterId: 'feishu',
  accountId: 'test',
  tenantId: 'tenant',
  conversationId: 'oc_target',
  kind: 'group' as const,
  threadId: 'oc_target',
  semantics: 'conversation' as const,
}
const bytes = Buffer.alloc(65537, 42)
const request: ChannelMediaPrepareRequestV1 = {
  contract: 'cordisx.channel-media-prepare/v1',
  schemaVersion: 1,
  type: 'file',
  target,
  input: {
    kind: 'bytes',
    bytesBase64: bytes.toString('base64'),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: 'sample.bin',
    format: 'binary',
    mediaType: 'application/octet-stream',
  },
}

it('prepares public V2 bytes using bounded store chunks and isolates plugin identity and target', async () => {
  const f = fixture(), media = await f.options.prepareOutbound!(request, caller)
  expect(media).toMatchObject({
    contract: 'cordisx.channel-prepared-media/v1',
    filename: 'sample.bin',
    format: 'binary',
  })
  expect(Date.parse(media.expiresAt)).toBeGreaterThan(Date.now())
  expect(await f.options.resolveOutboundMedia!(media.handle, target, bytes.length)).toEqual(Uint8Array.from(bytes))
  expect(await f.options.outboundMediaDescriptor!(caller, media.handle, target)).toMatchObject({ handle: media.handle })
  for (const field of ['source', 'pluginId', 'generation']) {
    await expect(f.options.outboundMediaDescriptor!({ ...caller, [field]: 'other' }, media.handle, target)).rejects
      .toThrow('CHANNEL_MEDIA_UNAVAILABLE')
  }
  await expect(f.options.resolveOutboundMedia!(media.handle, { ...target, accountId: 'other' }, bytes.length)).rejects
    .toThrow('CHANNEL_MEDIA_UNAVAILABLE')
  f.store.dispose()
  await expect(f.options.resolveOutboundMedia!(media.handle, target, bytes.length)).rejects.toThrow(
    'CHANNEL_MEDIA_UNAVAILABLE',
  )
})

it('denies source tickets, inconsistent metadata, malformed base64 and wrong digest without path access', async () => {
  const f = fixture()
  const invalid = [
    { ...request, input: { kind: 'source', source: '/tmp/secret' } },
    { ...request, schemaVersion: 2 },
    { ...request, input: { ...request.input, mediaType: 'application/pdf' } },
    { ...request, input: { ...request.input, bytesBase64: 'Zh==' } },
    { ...request, input: { ...request.input, sha256: '0'.repeat(64) } },
  ]
  for (const input of invalid) {
    await expect(f.options.prepareOutbound!(input as ChannelMediaPrepareRequestV1, caller)).rejects.toThrow()
  }
})

it('rejects malformed input and oversized actual bytes before decoding or allocating store buffers', async () => {
  const f = fixture()
  const decode = vi.spyOn(Buffer, 'from')
  const begin = vi.spyOn(f.store.store, 'begin')
  for (const input of [null, {}, { ...request, input: null }, { ...request, input: [] }]) {
    await expect(f.options.prepareOutbound!(input as ChannelMediaPrepareRequestV1, caller)).rejects.toThrow(
      'INVALID_REQUEST',
    )
  }
  for (const patch of [{ size: 1 }, { size: 30000001 }, { size: 0 }, { filename: '../bad' }, { format: 'mp4' }]) {
    await expect(
      f.options.prepareOutbound!(
        { ...request, input: { ...request.input, ...patch } } as ChannelMediaPrepareRequestV1,
        caller,
      ),
    ).rejects.toThrow()
  }
  expect(decode).not.toHaveBeenCalled()
  expect(begin).not.toHaveBeenCalled()
  decode.mockRestore()
  await expect(
    f.options.prepareOutbound!(
      { ...request, input: { kind: 'source', source: 'source:ticket' } } as ChannelMediaPrepareRequestV1,
      caller,
    ),
  ).rejects.toThrow('CHANNEL_MEDIA_UNAVAILABLE')
})

it('enforces the public 128KiB bound and smaller target capability before decoding', async () => {
  const f = fixture()
  for (const size of [131072, 131073]) {
    const bytes = Buffer.alloc(size)
    const input = {
      ...request,
      input: {
        ...request.input,
        size,
        bytesBase64: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    } as ChannelMediaPrepareRequestV1
    if (size === 131072) expect(await f.options.prepareOutbound!(input, caller)).toMatchObject({ size })
    else {
      const decode = vi.spyOn(Buffer, 'from')
      await expect(f.options.prepareOutbound!(input, caller)).rejects.toThrow('MEDIA_SIZE_DENIED')
      expect(decode).not.toHaveBeenCalled()
      decode.mockRestore()
    }
  }
  for (const maximum of [0, 65536]) {
    const options = channelOutboundRuntimeOptions(f.store, async () => maximum)
    await expect(options.prepareOutbound!(request, caller)).rejects.toThrow('MEDIA_SIZE_DENIED')
  }
})

it('enforces serialized UTF8 bytes before capability lookup and decode, including the exact boundary', async () => {
  const f = fixture()
  const capability = vi.fn(async () => {
    throw new Error('CAPABILITY_REACHED')
  })
  const options = channelOutboundRuntimeOptions(f.store, capability)
  const base = { ...request, target: { ...target, conversationId: '' } }
  const remaining = 196608 - Buffer.byteLength(JSON.stringify(base), 'utf8')
  const exact = {
    ...base,
    target: { ...target, conversationId: '界'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3) },
  }
  expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(196608)
  expect(JSON.stringify(exact).length).toBeLessThan(196608)
  await expect(options.prepareOutbound!(exact, caller)).rejects.toThrow('CAPABILITY_REACHED')
  capability.mockClear()
  const decode = vi.spyOn(Buffer, 'from')
  await expect(
    options.prepareOutbound!({
      ...exact,
      target: { ...exact.target, conversationId: exact.target.conversationId + 'a' },
    }, caller),
  ).rejects.toThrow('CHANNEL_RPC_INPUT_TOO_LARGE')
  const cyclic = { ...request, target: { ...target } }
  Object.assign(cyclic.target, { cyclic })
  await expect(options.prepareOutbound!(cyclic, caller)).rejects.toThrow('INVALID_REQUEST')
  expect(capability).not.toHaveBeenCalled()
  expect(decode).not.toHaveBeenCalled()
  decode.mockRestore()
})
