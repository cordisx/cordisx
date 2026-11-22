import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ChannelInboundResources } from '../packages/cli/src/launcher/channel-inbound-resources.js'
import { createFeishuAdapterDefinition } from '../packages/cli/src/launcher/feishu-adapter.js'

const target = {
  adapterId: 'lark',
  accountId: 'synthetic',
  tenantId: 'synthetic',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'thread',
  semantics: 'topic' as const,
}
const source = { ...target, eventId: 'message', messageId: 'message' }
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe('scoped media production adapter composition', () => {
  it.each(['image', 'audio'])('uploads %s and preserves reply UUID/receipts, rejects scope changes', async type => {
    const resources = new ChannelInboundResources()
    const bytes = type === 'image' ? png : Buffer.alloc(47)
    if (type === 'audio') {
      bytes.write('OggS')
      bytes[5] = 2
      bytes[26] = 1
      bytes[27] = 19
      bytes.write('OpusHead', 28)
    }
    const block = await resources.ingest(source, Readable.from([bytes]), type, undefined, 'synthetic-key')
    if (block.type !== 'attachment') throw new Error('missing attachment')
    const media = await resources.grantOutbound(block.handle, source, target)
    await expect(resources.grantOutbound(block.handle, { ...source, eventId: 'other' }, target)).rejects.toThrow(
      'SOURCE_DENIED',
    )
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'synthetic-receipt' } }))
    const image = vi.fn(async () => ({ image_key: 'synthetic-image' }))
    const file = vi.fn(async () => ({ file_key: 'synthetic-audio' }))
    const definition = createFeishuAdapterDefinition({
      connection: { ref: target, adapterKind: 'lark', enabled: true, transport: { mode: 'websocket' } },
      configurationRevision: 1,
      source: 'synthetic',
      resources,
      resolveSecret: async () => 'synthetic',
      createChannel: () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          on: () => () => {},
          send: async () => ({ messageId: 'fallback' }),
          rawClient: { im: { v1: { message: { reply }, image: { create: image }, file: { create: file } } } },
        }) as never,
    })
    const active = await definition.start({
      ref: target,
      generation: 1,
      receive: async () => ({ recordId: 'synthetic', duplicate: false, status: 'queued' }),
      drainInbound: async () => 0,
      drainOutbound: async () => 0,
    })
    try {
      const delivery = {
        deliveryId: 'delivery:synthetic',
        target,
        media,
        kind: 'reply' as const,
        text: '',
        createdAt: '2026-11-22T00:00:00Z',
      }
      expect(await active.send(delivery)).toEqual({
        externalMessageId: 'synthetic-receipt',
        recallHandle: 'synthetic-receipt',
      })
      await active.send(delivery)
      expect(reply.mock.calls[0]?.[0]).toEqual(reply.mock.calls[1]?.[0])
      expect(reply.mock.calls[0]?.[0]).toMatchObject({ data: { msg_type: type, reply_in_thread: true } })
      const uploads = type === 'image' ? image : file
      const before = uploads.mock.calls.length
      await expect(active.send({ ...delivery, target: { ...target, conversationId: 'other' } })).rejects.toThrow(
        'SOURCE_DENIED',
      )
      expect(uploads.mock.calls).toHaveLength(before)
      await expect(resources.resolve(media.handle, target, 1)).rejects.toThrow('SOURCE_DENIED')
    } finally {
      await active.stop('disposed')
    }
    await expect(resources.resolve(media.handle, target, bytes.length)).rejects.toThrow('SOURCE_DENIED')
  })
})
