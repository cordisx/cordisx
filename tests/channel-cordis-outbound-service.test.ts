import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelAdapterDefinitionV2, ChannelRuntimeContextV2 } from '@cordisx/protocol/channel-runtime/v2'
import type { ChannelMediaPrepareRequestV1, ChannelMessageSendV1 } from '@cordisx/protocol/channel-outbound/v1'
import { bindChannelPluginContext, CordisXChannelService } from '../packages/channel-runtime/src/cordis-service.js'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const identity = { pluginId: 'consumer', source: 'file:///consumer', generation: 'generation-one' }
const target = {
  adapterId: 'feishu',
  accountId: 'bot',
  tenantId: 'tenant',
  conversationId: 'chat',
  kind: 'direct' as const,
  threadId: 'chat',
  semantics: 'conversation' as const,
}
const prepare = {
  contract: 'cordisx.channel-media-prepare/v1',
  schemaVersion: 1,
  target,
  type: 'file',
  input: { kind: 'source', source: 'source:opaque' },
} as ChannelMediaPrepareRequestV1
const send: ChannelMessageSendV1 = {
  contract: 'cordisx.channel-message-send/v1',
  schemaVersion: 1,
  target,
  kind: 'reply',
  idempotencyKey: 'operation-one',
  content: { type: 'text', text: 'hello' },
  fallback: { mode: 'reject' },
}
const definition = {
  descriptor: { ref: target, configurationRevision: 7 },
  outboundCapabilities: { types: ['text'], maxMediaBytes: 0 },
  start: vi.fn(),
} as unknown as ChannelAdapterDefinitionV2

function fixture(backend: object = {}) {
  const root = new Context()
  new CordisXChannelService(root, backend as ChannelRuntime)
  const ctx = bindChannelPluginContext(root, identity, 7) as ChannelRuntimeContextV2
  return { root, ctx }
}

describe('Protocol V2 Cordis outbound service', () => {
  it('adds outboundV2 without replacing frozen services and binds exact caller authority', async () => {
    const backend = {
      outboundCapabilitiesV2: vi.fn().mockResolvedValue({ richtext: { paragraphs: true, mentions: true } }),
      sendTypedV2: vi.fn().mockResolvedValue({ deliveryId: 'mention' }),
    }
    const { ctx, root } = fixture(backend)
    const channel = (ctx as unknown as import('@cordisx/protocol/channel-runtime/v3').ChannelRuntimeContextV3).channel
    const request = { ...send, contract: 'cordisx.channel-message-send/v2' as const, schemaVersion: 2 as const }
    expect(Object.isFrozen(channel.outboundV2)).toBe(true)
    await channel.outboundV2.capabilities(target)
    await channel.outboundV2.send(request)
    expect(backend.outboundCapabilitiesV2).toHaveBeenCalledWith(target, identity)
    expect(backend.sendTypedV2).toHaveBeenCalledWith(request, identity)
    await expect(channel.outboundV2.send(send as never)).rejects.toThrow('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
    const unbound = root as unknown as import('@cordisx/protocol/channel-runtime/v3').ChannelRuntimeContextV3
    await expect(unbound.channel.outboundV2.send(request)).rejects.toThrow('launcher-bound')
  })
  it('registers and sends through real Runtime V2 with a durable receipt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-cordis-v2-'))
    const runtime = await ChannelRuntime.open({
      storePath: path.join(directory, 'store.json'),
      permissions: { authorize: async () => 'allow' },
    })
    const { ctx } = fixture(runtime)
    const sendMessage = vi.fn().mockResolvedValue({ externalMessageId: 'external-one' })
    try {
      const adapter = await ctx.channel.adaptersV2.register({
        descriptor: {
          ref: target,
          kind: 'feishu',
          implementationStatus: 'experimental',
          configurationRevision: 7,
          secretState: 'ready',
        },
        outboundCapabilities: { types: ['text'], maxMediaBytes: 0 },
        start: async () => ({ send: async () => ({ externalMessageId: 'legacy' }), sendMessage, stop: async () => {} }),
      })
      expect(await ctx.channel.outbound.capabilities(target)).toMatchObject({ types: ['text'], maxMediaBytes: 0 })
      const handle = await ctx.channel.outbound.send(send)
      expect(await handle.receipt()).toMatchObject({ status: 'queued', requestedType: 'text' })
      await adapter.drainOutbound()
      expect(await handle.receipt()).toMatchObject({ status: 'sent', externalMessageId: 'external-one' })
      expect(sendMessage).toHaveBeenCalledTimes(1)
      await expect(ctx.channel.outbound.prepare(prepare)).rejects.toThrow('Prepared media broker unavailable')
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('forwards exact requests and launcher-stamped identity to runtime authority', async () => {
    const capabilities = { types: ['text'], maxMediaBytes: 0 }
    const prepared = { handle: 'media:opaque' }
    const handle = { deliveryId: 'delivery:one', receipt: vi.fn(), cancel: vi.fn() }
    const backend = {
      outboundCapabilities: vi.fn().mockResolvedValue(capabilities),
      prepareOutbound: vi.fn().mockResolvedValue(prepared),
      sendTyped: vi.fn().mockResolvedValue(handle),
    }
    const { ctx } = fixture(backend)
    expect(Object.isFrozen(ctx.channel.outbound)).toBe(true)
    expect(await ctx.channel.outbound.capabilities(target)).toBe(capabilities)
    expect(await ctx.channel.outbound.prepare(prepare)).toBe(prepared)
    expect(await ctx.channel.outbound.send(send)).toBe(handle)
    expect(backend.outboundCapabilities).toHaveBeenCalledWith(target, identity)
    expect(backend.prepareOutbound).toHaveBeenCalledWith(prepare, identity)
    expect(backend.sendTyped).toHaveBeenCalledWith(send, identity)
  })
  it('rejects unbound callers before runtime access', async () => {
    const sendTyped = vi.fn()
    const { root } = fixture({ sendTyped })
    const unbound = root as ChannelRuntimeContextV2
    await expect(unbound.channel.outbound.send(send)).rejects.toThrow('launcher-bound')
    expect(sendTyped).not.toHaveBeenCalled()
  })
  it('uses distinct bound identities and retains runtime receiver for borrowed facade calls', async () => {
    const backend = {
      sendTyped: vi.fn(function(this: object) {
        expect(this).toBe(backend)
        return Promise.reject(new Error('GENERATION_FENCED'))
      }),
    }
    const { root, ctx } = fixture(backend)
    const secondIdentity = { ...identity, pluginId: 'other', generation: 'generation-two' }
    const second = bindChannelPluginContext(root, secondIdentity, 7) as ChannelRuntimeContextV2
    const borrowed = ctx.channel.outbound
    await expect(borrowed.send(send)).rejects.toThrow('GENERATION_FENCED')
    await expect(second.channel.outbound.send(send)).rejects.toThrow('GENERATION_FENCED')
    expect(backend.sendTyped.mock.calls).toEqual([[send, identity], [send, secondIdentity]])
  })
  it.each([
    { content: { type: 'text', text: 'typed' } },
    { fallback: { mode: 'text', text: 'fallback' } },
    { content: { type: 'card', title: 'Title', body: 'Body' }, fallback: { mode: 'reject' } },
  ])('rejects typed fields on frozen V1 messages.send: %j', async fields => {
    const notify = vi.fn()
    const sendTyped = vi.fn()
    const { ctx } = fixture({ notify, sendTyped })
    const notification = { target, kind: 'reply', text: 'legacy', ...fields }
    await expect(ctx.channel.messages.send(notification as Parameters<typeof ctx.channel.messages.send>[0]))
      .rejects.toThrow('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
    expect(notify).not.toHaveBeenCalled()
    expect(sendTyped).not.toHaveBeenCalled()
  })
  it('keeps V1 media rejected and does not route it through V2 preparation', async () => {
    const prepareOutbound = vi.fn()
    const notify = vi.fn()
    const { ctx } = fixture({ prepareOutbound, notify })
    const notification = { target, kind: 'reply', text: 'legacy', media: { handle: 'media:opaque' } }
    await expect(ctx.channel.messages.send(notification as unknown as Parameters<typeof ctx.channel.messages.send>[0]))
      .rejects.toThrow('CHANNEL_MEDIA_PROTOCOL_UNAVAILABLE')
    expect(prepareOutbound).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
  it.each(['POLICY_DENIED', 'GENERATION_FENCED', 'SOURCE_SCOPE_MISMATCH', 'MEDIA_BYTES_LIMIT'])(
    'does not bypass prepare authority failure %s',
    async code => {
      const prepareOutbound = vi.fn().mockRejectedValue(new Error(code))
      const { ctx } = fixture({ prepareOutbound })
      await expect(ctx.channel.outbound.prepare(prepare)).rejects.toThrow(code)
      expect(prepareOutbound).toHaveBeenCalledTimes(1)
    },
  )
  it('passes bytes preparation unchanged without local filesystem or URL resolution', async () => {
    const prepareOutbound = vi.fn().mockRejectedValue(new Error('INVALID_BYTES'))
    const { ctx } = fixture({ prepareOutbound })
    const request = {
      ...prepare,
      input: {
        kind: 'bytes',
        bytesBase64: 'invalid',
        format: 'binary',
        filename: 'file.bin',
        mediaType: 'application/octet-stream',
        size: 1,
        sha256: 'bad',
      },
    } as ChannelMediaPrepareRequestV1
    await expect(ctx.channel.outbound.prepare(request)).rejects.toThrow('INVALID_BYTES')
    expect(prepareOutbound).toHaveBeenCalledWith(request, identity)
  })
  it('registers V2 adapter with Host revision and ties cleanup to caller lifecycle', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const adapterHandle = { dispose }
    const activateV2 = vi.fn().mockResolvedValue(adapterHandle)
    const { ctx } = fixture({ activateV2 })
    const effect = vi.spyOn(ctx, 'effect')
    expect(Object.isFrozen(ctx.channel.adaptersV2)).toBe(true)
    expect(await ctx.channel.adaptersV2.register(definition)).toBe(adapterHandle)
    expect(activateV2).toHaveBeenCalledWith(definition, identity)
    const cleanup = effect.mock.calls[0]?.[0] as () => () => Promise<void>
    await cleanup()()
    expect(dispose).toHaveBeenCalledTimes(1)
    await expect(
      ctx.channel.adaptersV2.register({
        ...definition,
        descriptor: { ...definition.descriptor, configurationRevision: 8 },
      }),
    ).rejects.toThrow('Host stamp')
    expect(activateV2).toHaveBeenCalledTimes(1)
  })
})
