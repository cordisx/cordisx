import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'

const target = {
  adapterId: 'lark',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'chat',
  semantics: 'conversation' as const,
  eventId: 'event',
}
const caller = { source: 'test', pluginId: 'test', generation: '1' }
const content = {
  type: 'richtext' as const,
  blocks: [{
    type: 'paragraph' as const,
    nodes: [{ type: 'mention' as const, userId: 'ou_user' }, {
      type: 'text' as const,
      text: ' review',
      style: 'plain' as const,
    }],
  }],
}
const request = {
  contract: 'cordisx.channel-message-send/v2' as const,
  schemaVersion: 2 as const,
  target,
  kind: 'reply' as const,
  idempotencyKey: 'mention',
  content,
  fallback: { mode: 'reject' as const },
}

it('requires separate mention support, never falls back on invalid evidence, and rechecks dispatch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mention-runtime-'))
  const runtime = await ChannelRuntime.open({
    storePath: path.join(directory, 'store.json'),
    permissions: { authorize: async () => 'allow' },
  })
  let valid = true
  let supported = false
  const send = vi.fn(async () => ({ externalMessageId: 'receipt' }))
  const verify = vi.fn(async () => {
    if (!valid) throw new Error('CHANNEL_MENTION_UNVERIFIED')
  })
  const activate = () =>
    runtime.activate({
      descriptor: {
        ref: target,
        kind: 'lark',
        implementationStatus: 'experimental',
        configurationRevision: 1,
        secretState: 'ready',
      },
      start: async () => ({
        outboundTypes: ['text', 'richtext'],
        richtext: { paragraphs: true, mentions: supported },
        verifyMentions: verify,
        send,
        stop: async () => {},
      }),
    }, caller)
  try {
    await activate()
    expect(await runtime.outboundCapabilitiesV2(target, caller)).toMatchObject({
      richtext: { paragraphs: true, mentions: false },
    })
    await expect(runtime.sendTypedV2(request, caller)).rejects.toThrow('fallback rejected')
    valid = false
    await expect(runtime.sendTypedV2({ ...request, fallback: { mode: 'text', text: 'fallback' } }, caller)).rejects
      .toThrow('CHANNEL_MENTION_UNVERIFIED')
    expect(send).not.toHaveBeenCalled()
    valid = true
    const fallback = await runtime.sendTypedV2({
      ...request,
      idempotencyKey: 'fallback',
      fallback: { mode: 'text', text: 'fallback' },
    }, caller)
    expect(await fallback.receipt()).toMatchObject({ effectiveType: 'text', downgraded: true })
    await fallback.cancel()
    supported = true
    const adapter = await activate()
    await expect(
      runtime.sendTyped({ ...request, contract: 'cordisx.channel-message-send/v1', schemaVersion: 1 } as never, caller),
    ).rejects.toThrow('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
    await expect(runtime.sendTyped(request as never, caller)).rejects.toThrow(
      'CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE',
    )
    const handle = await runtime.sendTypedV2(request, caller)
    valid = false
    await adapter.drainOutbound(10)
    expect(send).not.toHaveBeenCalled()
    expect(await handle.receipt()).toMatchObject({ status: 'failed' })
    valid = true
    await runtime.sendTypedV2({ ...request, idempotencyKey: 'valid' }, caller)
    await adapter.drainOutbound(10)
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
