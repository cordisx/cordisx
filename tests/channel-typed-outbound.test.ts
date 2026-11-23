import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime, UncertainChannelSendError } from '../packages/channel-runtime/src/runtime.js'
import { validateOutboundContent, validateOutboundFallback } from '../packages/channel-runtime/src/outbound-content.js'
import { validOutboundFilename } from '../packages/channel-runtime/src/outbound-media.js'
import { renderFeishuTypedContent } from '../packages/cli/src/launcher/feishu-outbound-media.js'

const target = {
  adapterId: 'lark',
  accountId: 'test',
  tenantId: 'test',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'thread',
  semantics: 'topic' as const,
}
const caller = { source: 'test', pluginId: 'test', generation: '1' }
it('counts public astral text and filename limits as Unicode code points', () => {
  const blocks = Array.from({ length: 128 }, () => ({ text: '😀'.repeat(4096), style: 'plain' as const }))
  expect(validateOutboundContent({ type: 'richtext', blocks })).toEqual({ type: 'richtext', blocks })
  expect(() => validateOutboundContent({ type: 'richtext', blocks: [{ text: '😀'.repeat(4097), style: 'plain' }] }))
    .toThrow('Invalid outbound text')
  expect(validOutboundFilename('😀'.repeat(255))).toBe(true)
  expect(validOutboundFilename('😀'.repeat(256))).toBe(false)
  const text = '😀'.repeat(65536)
  expect(validateOutboundContent({ type: 'text', text })).toEqual({ type: 'text', text })
  expect(() => validateOutboundContent({ type: 'text', text: text + '😀' })).toThrow()
  expect(validateOutboundFallback({ mode: 'text', text })).toEqual({ mode: 'text', text })
  expect(() => validateOutboundFallback({ mode: 'text', text: text + '😀' })).toThrow()
  const card = { type: 'card' as const, title: '😀'.repeat(256), body: '😀'.repeat(16384) }
  expect(validateOutboundContent(card)).toEqual(card)
  expect(() => validateOutboundContent({ ...card, title: card.title + '😀' })).toThrow()
  expect(() => validateOutboundContent({ ...card, body: card.body + '😀' })).toThrow()
})
const request = {
  contract: 'cordisx.channel-message-send/v1' as const,
  schemaVersion: 1 as const,
  target,
  kind: 'reply' as const,
  idempotencyKey: 'test',
  content: { type: 'card' as const, title: 'Title', body: 'Body' },
  fallback: { mode: 'reject' as const },
}

it('rejects unsupported types, fixes explicit downgrade, and sends once through durable outbox', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'typed-outbound-'))
  const runtime = await ChannelRuntime.open({
    storePath: path.join(directory, 'store.json'),
    permissions: { authorize: async () => 'allow' },
  })
  const send = vi.fn(async (_delivery: unknown) => ({ externalMessageId: 'receipt' }))
  try {
    const adapter = await runtime.activate({
      descriptor: {
        ref: target,
        kind: 'lark',
        implementationStatus: 'experimental',
        configurationRevision: 1,
        secretState: 'ready',
      },
      start: async () => ({ outboundTypes: ['text'], send, stop: async () => {} }),
    }, caller)
    await expect(runtime.sendTyped(request, caller)).rejects.toThrow('fallback rejected')
    await expect(runtime.sendTyped({ ...request, idempotencyKey: '😀'.repeat(257) }, caller)).rejects.toThrow(
      'Invalid typed send request',
    )
    const unicode = await runtime.sendTyped({
      ...request,
      idempotencyKey: '😀'.repeat(256),
      content: { type: 'text', text: 'Unicode' },
    }, caller)
    expect(await unicode.cancel()).toBe('cancelled')
    const fallbackRequest = { ...request, fallback: { mode: 'text' as const, text: 'Explicit fallback' } }
    const handle = await runtime.sendTyped(fallbackRequest, caller)
    expect(await handle.receipt()).toMatchObject({
      requestedType: 'card',
      effectiveType: 'text',
      downgraded: true,
      status: 'queued',
    })
    await runtime.sendTyped(fallbackRequest, caller)
    await expect(runtime.sendTyped({ ...fallbackRequest, content: { ...request.content, body: 'Changed' } }, caller))
      .rejects.toThrow('Operation conflict')
    await adapter.drainOutbound(10)
    await runtime.sendTyped(fallbackRequest, caller)
    await adapter.drainOutbound(10)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      content: { type: 'text', text: 'Explicit fallback' },
      requestedType: 'card',
      effectiveType: 'text',
    })
    expect(await handle.receipt()).toMatchObject({ status: 'sent', externalMessageId: 'receipt' })
    expect(runtime.deliverySnapshot(handle.deliveryId, caller)).toMatchObject({
      state: 'sent',
      requestedType: 'card',
      effectiveType: 'text',
      downgraded: true,
      externalMessageId: 'receipt',
    })
    const legacy = await runtime.notifyOnce({ target, kind: 'reply', text: 'Legacy' }, caller, 'delivery:legacy')
    await adapter.drainOutbound(10)
    expect(runtime.deliverySnapshot(legacy.deliveryId, caller)).toEqual({
      deliveryId: 'delivery:legacy',
      state: 'sent',
      attempts: 1,
      target,
      externalMessageId: 'receipt',
    })
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([new UncertainChannelSendError('NETWORK_TIMEOUT'), new Error('KNOWN_REJECTION')])(
  'persists uncertain versus known failure and never automatically replays either',
  async error => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'typed-uncertain-'))
    const runtime = await ChannelRuntime.open({
      storePath: path.join(directory, 'store.json'),
      permissions: { authorize: async () => 'allow' },
    })
    const send = vi.fn(async () => {
      throw error
    })
    try {
      const adapter = await runtime.activate({
        descriptor: {
          ref: target,
          kind: 'lark',
          implementationStatus: 'experimental',
          configurationRevision: 1,
          secretState: 'ready',
        },
        start: async () => ({ outboundTypes: ['card'], send, stop: async () => {} }),
      }, caller)
      const handle = await runtime.sendTyped(request, caller)
      await adapter.drainOutbound(10)
      await runtime.sendTyped(request, caller)
      await adapter.drainOutbound(10)
      expect(send).toHaveBeenCalledTimes(1)
      expect(await handle.receipt()).toMatchObject({
        status: error instanceof UncertainChannelSendError ? 'unknown' : 'failed',
        code: error instanceof UncertainChannelSendError ? 'NETWORK_TIMEOUT' : 'ERROR',
      })
      expect(await handle.cancel()).toBe(error instanceof UncertainChannelSendError ? 'irreversible' : 'not-found')
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it('accepts all 128 protocol richtext blocks without an aggregate limit', () => {
  const content = {
    type: 'richtext' as const,
    blocks: Array.from({ length: 128 }, () => ({ text: 'x'.repeat(4096), style: 'plain' as const })),
  }
  expect(validateOutboundContent(content)).toEqual(content)
})

it('routes V2 through outbox with caller descriptor and delivery-scoped media resolution', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'typed-v2-'))
  const bytes = Buffer.from([0, 1, 2])
  const { createHash } = await import('node:crypto')
  const media = {
    type: 'file' as const,
    format: 'binary' as const,
    handle: 'media:test',
    filename: 'x.bin',
    size: 3,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const descriptor = vi.fn(async () => media)
  const resolve = vi.fn(async () => bytes)
  const runtime = await ChannelRuntime.open({
    storePath: path.join(directory, 'store.json'),
    permissions: { authorize: async () => 'allow' },
    outboundMediaDescriptor: descriptor,
    resolveOutboundMedia: resolve,
  })
  const sendMessage = vi.fn()
  const types: Array<'file' | 'text'> = ['file']
  try {
    const adapter = await runtime.activateV2({
      descriptor: {
        ref: target,
        kind: 'lark',
        implementationStatus: 'experimental',
        configurationRevision: 1,
        secretState: 'ready',
      },
      outboundCapabilities: { types, maxMediaBytes: 100 },
      start: async host => ({
        stop: async () => {},
        send: async () => ({ externalMessageId: 'legacy' }),
        sendMessage: async delivery => {
          sendMessage(delivery)
          await expect(host.media.resolve(media.handle as never, 'delivery:other')).rejects.toThrow('scope denied')
          expect((await host.media.resolve(media.handle as never, delivery.deliveryId)).bytes).toEqual(bytes)
          return { externalMessageId: 'confirmed' }
        },
      }),
    }, caller)
    types.splice(0, 1, 'text')
    expect((await runtime.outboundCapabilities(target, caller)).types).toEqual(['file'])
    const handle = await runtime.sendOutbound(
      { ...request, content: { type: 'file', handle: media.handle as never } },
      caller,
    )
    expect(descriptor).toHaveBeenCalledWith(caller, media.handle, target)
    expect(sendMessage).not.toHaveBeenCalled()
    await adapter.drainOutbound(10)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          idempotencyKey: request.idempotencyKey,
          content: { type: 'file', handle: media.handle },
        }),
      }),
    )
    expect(await handle.receipt()).toMatchObject({ status: 'sent', externalMessageId: 'confirmed' })
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('renders richtext styles and static card fields without interpreting raw JSON or markdown', () => {
  expect(
    renderFeishuTypedContent({
      type: 'richtext',
      blocks: [{ text: 'Strong', style: 'strong' }, { text: 'Code', style: 'code' }],
    }),
  ).toEqual({
    msg_type: 'post',
    content: {
      en_us: {
        title: '',
        content: [[{ tag: 'text', text: 'Strong', style: ['bold'] }], [{ tag: 'code_block', text: 'Code' }]],
      },
    },
  })
  expect(() => renderFeishuTypedContent({ type: 'image', handle: 'media:test' })).toThrow('REQUIRES_MEDIA_UPLOAD')
  expect(renderFeishuTypedContent({ type: 'card', title: 'Title', body: '**literal**' })).toMatchObject({
    msg_type: 'interactive',
    content: {
      header: { title: { tag: 'plain_text', content: 'Title' } },
      elements: [{ text: { tag: 'plain_text', content: '**literal**' } }],
    },
  })
})
