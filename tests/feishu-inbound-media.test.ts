import { normalize } from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  channelAttachmentTicket,
  ChannelInboundResources,
  channelNativeResourceInput,
} from '../packages/cli/src/launcher/channel-inbound-resources.js'
import { feishuInboundContent } from '../packages/cli/src/launcher/feishu-inbound-media.js'
import { createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'

const event = {
  adapterId: 'lark',
  accountId: 'synthetic',
  tenantId: 'synthetic',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'thread',
  semantics: 'topic' as const,
  eventId: 'message',
  messageId: 'message',
  actor: { adapterId: 'lark', accountId: 'synthetic', tenantId: 'synthetic', userId: 'sender' },
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mUAAAAASUVORK5CYII=',
  'base64',
)
const fixture = async (type: string, content: unknown) =>
  normalize({
    sender: { sender_id: { open_id: 'sender' }, sender_type: 'user' },
    message: {
      message_id: 'message',
      chat_id: 'chat',
      chat_type: 'group',
      message_type: type,
      content: JSON.stringify(content),
      create_time: '1795305600000',
      root_id: 'thread',
    },
  }, { botIdentity: { openId: 'bot' } })
function input(content: Awaited<ReturnType<typeof feishuInboundContent>>) {
  return {
    contract: 'cordisx.channel-user-input/v1' as const,
    schemaVersion: 1 as const,
    role: 'user' as const,
    content,
    source: { kind: 'channel' as const, event },
    receivedAt: '2026-11-22T00:00:00Z',
  }
}

describe('SDK normalization through Channel native input', () => {
  it.each(['image', 'post'])('delivers %s bytes as real localImage, not an image-key prompt', async type => {
    const message = await fixture(
      type,
      type === 'image'
        ? { image_key: 'img_v3_synthetic' }
        : {
          en_us: {
            title: 'Synthetic',
            content: [[{ tag: 'text', text: 'Look here' }, { tag: 'img', image_key: 'img_v3_synthetic' }]],
          },
        },
    )
    const resources = new ChannelInboundResources()
    const get = vi.fn(async () => ({ getReadableStream: () => Readable.from([png]) }))
    try {
      expect(message.resources[0]?.fileKey).toBe('img_v3_synthetic')
      const content = await feishuInboundContent(message, event, resources, { get })
      expect(await feishuInboundContent(message, event, resources, { get })).toEqual(content)
      expect(get).toHaveBeenCalledWith({
        path: { message_id: 'message', file_key: 'img_v3_synthetic' },
        params: { type: 'image' },
      })
      expect(JSON.stringify(content)).not.toContain('img_v3_synthetic')
      const ticket = await channelAttachmentTicket(input(content))
      const native = channelNativeResourceInput('Original text and source', ticket)
      const image = native.find(block => block.type === 'localImage') as { type: string; path: string }
      expect(await readFile(image.path)).toEqual(png)
      const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
      const bridge = createCodexBridgeHandler({
        catalog: async () => [],
        nativeRequest: async (method, params) => {
          calls.push({ method, params })
          if (method === 'thread/read') return { thread: { id: 'synthetic-thread', status: { type: 'idle' } } }
          if (method === 'turn/start') return { turn: { id: 'synthetic-turn' } }
          return {}
        },
      })
      await bridge('send_message', {
        operationId: `synthetic-${type}`,
        sessionId: 'synthetic-thread',
        prompt: 'Original text',
        channelAttachmentTicket: await channelAttachmentTicket(input(content)),
      })
      expect(JSON.stringify(calls.find(call => call.method === 'turn/start')?.params.input)).toContain('localImage')
      expect(() => channelNativeResourceInput('retry', ticket)).toThrow('TICKET_INVALID')
      const mismatch = {
        ...input(content),
        source: { kind: 'channel' as const, event: { ...event, conversationId: 'other' } },
      }
      expect(channelNativeResourceInput('text', await channelAttachmentTicket(mismatch))).toHaveLength(1)
    } finally {
      await resources.dispose()
    }
  })
  it.each(['audio', 'file', 'media'])(
    'retains %s as accessible attachment without invented model capability',
    async type => {
      const message = await fixture(type, { file_key: 'file_synthetic', file_name: 'sample.bin', duration: 1000 })
      const resources = new ChannelInboundResources()
      try {
        const content = await feishuInboundContent(message, event, resources, {
          get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('synthetic data')]) }),
        })
        expect(content.some(block => block.type === 'attachment')).toBe(true)
        const native = channelNativeResourceInput('text', await channelAttachmentTicket(input(content)))
        expect(native).toHaveLength(1)
        expect(JSON.stringify(native)).toContain('localFile')
        expect(JSON.stringify(native)).toContain('No automatic transcription or video understanding')
      } finally {
        await resources.dispose()
      }
    },
  )
  it.each(['interactive', 'location', 'system', 'unknown', 'sticker'])('explicitly falls back for %s', async type => {
    const resources = new ChannelInboundResources()
    try {
      const content = await feishuInboundContent(
        await fixture(type, { text: 'synthetic', file_key: 'sticker_synthetic' }),
        event,
        resources,
      )
      expect(JSON.stringify(content)).toContain('fallback')
      expect(content.every(block => block.type === 'text')).toBe(true)
    } finally {
      await resources.dispose()
    }
  })
  it('rejects oversized streams, invalid images, and stale handles', async () => {
    const resources = new ChannelInboundResources()
    const message = await fixture('image', { image_key: 'img_v3_synthetic' })
    try {
      for (const bytes of [Buffer.alloc(10_000_001), Buffer.from('<svg/>')]) {
        const content = await feishuInboundContent(message, event, resources, {
          get: async () => ({ getReadableStream: () => Readable.from([bytes]) }),
        })
        expect(content.every(block => block.type === 'text')).toBe(true)
        expect(JSON.stringify(content)).toContain('unavailable')
      }
      const content = await feishuInboundContent(message, event, resources, {
        get: async () => ({ getReadableStream: () => Readable.from([png]) }),
      })
      await resources.dispose()
      expect(JSON.stringify(channelNativeResourceInput('text', await channelAttachmentTicket(input(content)))))
        .toContain('unavailable')
    } finally {
      await resources.dispose()
    }
  })
  it('preserves plain text and refuses unavailable authenticated resources', async () => {
    const resources = new ChannelInboundResources()
    try {
      const get = vi.fn(async () => {
        throw new Error('SOURCE_DENIED')
      })
      expect(
        await feishuInboundContent(await fixture('text', { text: 'Hello synthetic world' }), event, resources, { get }),
      )
        .toEqual([{ type: 'text', text: 'Hello synthetic world' }])
      expect(get).not.toHaveBeenCalled()
      const content = await feishuInboundContent(
        await fixture('image', { image_key: 'img_v3_synthetic' }),
        event,
        resources,
        { get },
      )
      expect(JSON.stringify(content)).toContain('unavailable')
      expect(content.every(block => block.type === 'text')).toBe(true)
    } finally {
      await resources.dispose()
    }
  })
})
