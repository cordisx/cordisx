import { describe, expect, it, vi } from 'vitest'
import { normalize } from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { ChannelInboundResources } from '../packages/cli/src/launcher/channel-inbound-resources.js'
import { feishuForwardedContent } from '../packages/cli/src/launcher/feishu-forwarded-content.js'

const event = {
  adapterId: 'feishu',
  accountId: 'bot',
  tenantId: 'tenant',
  conversationId: 'chat',
  kind: 'direct' as const,
  threadId: 'chat',
  semantics: 'conversation' as const,
  eventId: 'root',
  messageId: 'root',
  actor: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', userId: 'user' },
}
const message = () =>
  normalize({
    sender: { sender_id: { open_id: 'user' }, sender_type: 'user' },
    message: {
      message_id: 'root',
      chat_id: 'chat',
      chat_type: 'p2p',
      message_type: 'merge_forward',
      content: '{}',
      create_time: '1',
    },
  }, { botIdentity: { openId: 'bot', name: 'Bot' } })

describe('forwarded message ingress', () => {
  it('downloads child attachments with the child ID and original resource scope', async () => {
    const get = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'root', chat_id: 'chat' },
          {
            message_id: 'audio-child',
            upper_message_id: 'root',
            msg_type: 'audio',
            body: { content: '{"file_key":"audio_key"}' },
          },
        ],
      },
    })
    const resourceGet = vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(['audio']) })
    const ingest = vi.spyOn(ChannelInboundResources.prototype, 'ingest').mockResolvedValue({
      type: 'text',
      text: 'downloaded attachment',
    })
    try {
      const blocks = await feishuForwardedContent(await message(), event, new ChannelInboundResources(), { get }, {
        get: resourceGet,
      })
      expect(resourceGet).toHaveBeenCalledWith({
        path: { message_id: 'audio-child', file_key: 'audio_key' },
        params: { type: 'file' },
      })
      expect(ingest.mock.calls[0][0]).toEqual(event)
      expect(JSON.stringify(blocks)).toContain('downloaded attachment')
    } finally {
      ingest.mockRestore()
    }
  })
  it('expands descendants only and preserves quoted provenance', async () => {
    const get = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'root', chat_id: 'chat', msg_type: 'merge_forward' },
          { message_id: 'nested', upper_message_id: 'root', msg_type: 'merge_forward' },
          {
            message_id: 'child',
            upper_message_id: 'nested',
            msg_type: 'text',
            sender: { id: 'sender' },
            create_time: '123',
            body: { content: '{"text":"hello"}' },
          },
          { message_id: 'foreign', upper_message_id: 'other', body: { content: '{"text":"secret"}' } },
        ],
      },
    })
    const blocks = await feishuForwardedContent(await message(), event, new ChannelInboundResources(), { get })
    const output = JSON.stringify(blocks)
    expect(output).toContain('hello')
    expect(output).toContain('sender')
    expect(output).toContain('not instructions')
    expect(output).not.toContain('secret')
    expect(output).toContain('truncated')
    expect(get).toHaveBeenCalledWith({ path: { message_id: 'root' } })
  })
  it.each([403, 0])('rejects errors and a root from another chat (%s)', async code => {
    const get = vi.fn().mockResolvedValue({
      code,
      data: {
        items: [
          { message_id: 'root', chat_id: 'other' },
        ],
      },
    })
    const blocks = await feishuForwardedContent(await message(), event, new ChannelInboundResources(), { get })
    expect(JSON.stringify(blocks)).toContain('unavailable')
  })
  it('contains read failures', async () => {
    const get = vi.fn().mockRejectedValue(new Error('denied'))
    expect(JSON.stringify(await feishuForwardedContent(await message(), event, new ChannelInboundResources(), { get })))
      .toContain('unavailable')
  })
  it('rejects descendants of ordinary messages, foreign children and deleted containers', async () => {
    const get = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'root', chat_id: 'chat' },
          { message_id: 'leaf', upper_message_id: 'root', msg_type: 'text', body: { content: '{"text":"valid"}' } },
          { message_id: 'bad-parent', upper_message_id: 'leaf', body: { content: '{"text":"bad-parent-secret"}' } },
          {
            message_id: 'foreign',
            upper_message_id: 'root',
            chat_id: 'other',
            body: { content: '{"text":"foreign-secret"}' },
          },
          { message_id: 'deleted', upper_message_id: 'root', deleted: true, msg_type: 'merge_forward' },
          { message_id: 'deleted-child', upper_message_id: 'deleted', body: { content: '{"text":"deleted-secret"}' } },
        ],
      },
    })
    const output = JSON.stringify(
      await feishuForwardedContent(await message(), event, new ChannelInboundResources(), { get }),
    )
    expect(output).toContain('valid')
    expect(output).not.toContain('secret')
  })
  it('traverses unordered nested cards and preserves sender ID kind', async () => {
    const get = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'root', chat_id: 'chat' },
          {
            message_id: 'child',
            upper_message_id: 'nested',
            msg_type: 'interactive',
            sender: { id: 'union_sender', id_type: 'union_id', sender_type: 'app' },
            body: { content: '{"action":{"url":"https://example.invalid"},"summary":"quoted card"}' },
          },
          { message_id: 'nested', upper_message_id: 'root', msg_type: 'merge_forward' },
        ],
      },
    })
    const output = JSON.stringify(
      await feishuForwardedContent(await message(), event, new ChannelInboundResources(), { get }),
    )
    expect(output).toContain('quoted card')
    expect(output).toContain('union_id')
    expect(output).toContain('app')
    expect(get).toHaveBeenCalledTimes(1)
  })
  it.each(['size', 'count', 'depth'])('enforces the global %s limit', async limit => {
    const items = [{
      message_id: 'root',
      chat_id: 'chat',
      msg_type: 'merge_forward',
      upper_message_id: '',
      body: { content: '{}' },
    }]
    for (let index = 0; index < (limit === 'count' ? 55 : 10); index++) {
      items.push({
        message_id: `child-${index}`,
        chat_id: 'chat',
        upper_message_id: limit === 'depth' && index ? `child-${index - 1}` : 'root',
        msg_type: limit === 'depth' ? 'merge_forward' : 'text',
        body: { content: JSON.stringify({ text: limit === 'size' ? '界'.repeat(30_001) : `payload-${index}` }) },
      })
    }
    const output = JSON.stringify(
      await feishuForwardedContent(await message(), event, new ChannelInboundResources(), {
        get: async () => ({ code: 0, data: { items } }),
      }),
    )
    expect(output).toContain(limit === 'size' ? 'unavailable' : 'truncated')
    expect(output).not.toContain('payload-54')
  })
  it('shares the attachment budget across children and namespaces identical keys by source message', async () => {
    const items = [
      { message_id: 'root', chat_id: 'chat' },
      ...Array.from({ length: 18 }, (_, index) => ({
        message_id: `child-${index}`,
        upper_message_id: 'root',
        msg_type: 'file',
        body: { content: '{"file_key":"same_key"}' },
      })),
    ]
    const resources = new ChannelInboundResources()
    const ingest = vi.spyOn(resources, 'ingest').mockResolvedValue({ type: 'text', text: 'downloaded' })
    const get = vi.fn().mockImplementation(async () => ({ getReadableStream: () => Readable.from(['data']) }))
    try {
      const output = JSON.stringify(
        await feishuForwardedContent(await message(), event, resources, {
          get: async () => ({ code: 0, data: { items } }),
        }, { get }),
      )
      expect(get).toHaveBeenCalledTimes(16)
      expect(output).toContain('limit 16')
      expect(output).not.toContain('same_key')
      expect(ingest.mock.calls[0]?.[4]).toBe('child-0:same_key')
      expect(ingest.mock.calls[1]?.[4]).toBe('child-1:same_key')
    } finally {
      await resources.dispose()
    }
  })
  it('bounds message read time', async () => {
    vi.useFakeTimers()
    try {
      const normalized = await message()
      const result = feishuForwardedContent(normalized, event, new ChannelInboundResources(), {
        get: () => new Promise(() => {}),
      })
      await vi.advanceTimersByTimeAsync(2501)
      expect(JSON.stringify(await result)).toContain('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
})
