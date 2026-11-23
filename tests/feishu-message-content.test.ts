import { describe, expect, it, vi } from 'vitest'
import { normalize } from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { ChannelInboundResources } from '../packages/cli/src/launcher/channel-inbound-resources.js'
import { feishuMessageContent } from '../packages/cli/src/launcher/feishu-message-content.js'

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
const fixture = (type: string, content: unknown, includeRaw = false) =>
  normalize({
    sender: { sender_id: { open_id: 'user' }, sender_type: 'user' },
    message: {
      message_id: 'root',
      chat_id: 'chat',
      chat_type: 'p2p',
      message_type: type,
      content: JSON.stringify(content),
      create_time: '1',
    },
  }, { botIdentity: { openId: 'bot', name: 'Bot' }, includeRaw })

describe('unified Feishu message content', () => {
  it.each([
    ['share_group_chat', { chat_id: 'oc_shared', name: 'Shared group' }, 'oc_shared', '[unsupported message]'],
    ['share_user_card', { user_id: 'ou_contact', name: 'Shared contact' }, 'ou_contact', '[unsupported message]'],
    [
      'cloud_file',
      { file_key: 'doc_token', name: 'Shared document', url: 'https://example.invalid/doc' },
      'Shared document',
      '[unsupported message]',
    ],
    ['link', { title: 'Shared link', url: 'https://example.invalid/link' }, 'Shared link', '[unsupported message]'],
    [
      'card',
      { title: 'History card', elements: [{ tag: 'plain_text', content: 'Card body' }] },
      'Card body',
      '[unsupported message]',
    ],
    ['interactive', { header: { title: { tag: 'plain_text', content: 'Live card' } } }, 'Live card', 'Live card'],
    ['location', { name: 'Origin', latitude: 0, longitude: 0 }, 'content.latitude: 0', '<location'],
    [
      'calendar',
      { summary: 'Invite', start_time: '1700000000000', end_time: '1700003600000' },
      'Invite',
      '<calendar_invite>',
    ],
    ['general_calendar', { summary: 'Calendar entry' }, 'Calendar entry', '<calendar>'],
    ['share_calendar_event', { summary: 'Shared event', event_id: 'event_ref' }, 'event_ref', '<calendar_share>'],
    [
      'todo',
      { summary: { title: 'Task title', content: [[{ tag: 'text', text: 'Task body' }]] }, due_time: '1700000000000' },
      'Task body',
      '<todo>',
    ],
    ['vote', { topic: 'Lunch vote', options: ['Option A', 'Option B'] }, 'Option B', '<vote>'],
    ['folder', { file_key: 'folder_token', file_name: 'Shared folder' }, 'Shared folder', '<folder'],
    ['sticker', { file_key: 'sticker_token', emoji: 'smile', description: 'Happy face' }, 'Happy face', '<sticker'],
    ['unknown', { text: 'Unknown text', details: { label: 'Unknown detail' } }, 'Unknown detail', 'Unknown text'],
    ['future_type', { title: 'Future title', details: { count: 0 } }, 'Future title', '[unsupported message]'],
    ['share_chat', { chat_id: 'oc_alias' }, 'oc_alias', '<group_card'],
    ['share_user', { user_id: 'ou_alias' }, 'ou_alias', '<contact_card'],
  ])('covers SDK/history type %s with quoted structure', async (type, source, expected, sdkMarker) => {
    const resources = new ChannelInboundResources()
    const get = vi.fn()
    try {
      const message = await fixture(type as string, source, true)
      expect(message.content).toContain(sdkMarker as string)
      const output = JSON.stringify(await feishuMessageContent(message, event, resources, { resourceClient: { get } }))
      expect(output).toContain(expected as string)
      expect(get).not.toHaveBeenCalled()
      if (['cloud_file', 'folder', 'link'].includes(type as string)) expect(output).toContain('content not read')
      if (type === 'sticker') expect(output).toContain('sticker bytes not read')
      expect(output).not.toContain('doc_token')
      expect(output).not.toContain('sticker_token')
    } finally {
      await resources.dispose()
    }
  })
  it.each([
    'interactive',
    'share_chat',
    'share_user',
    'share_calendar_event',
    'calendar',
    'general_calendar',
    'location',
    'future_type',
  ])('preserves %s structure without actions or URL fetches', async type => {
    const resources = new ChannelInboundResources()
    const get = vi.fn()
    const source = {
      summary: 'Planning',
      latitude: 0,
      longitude: 0,
      action: { url: 'https://example.invalid/action', value: { grant: 'none' } },
    }
    try {
      const result = await feishuMessageContent(await fixture(type, source), event, resources, {
        rawContent: JSON.stringify(source),
        resourceClient: { get },
      })
      const text = JSON.stringify(result)
      expect(text).toContain('Planning')
      expect(text).toContain('content.latitude: 0')
      expect(text).toContain('example.invalid/action')
      expect(text).toContain('data')
      expect(get).not.toHaveBeenCalled()
    } finally {
      await resources.dispose()
    }
  })
  it('retains SDK card text and ingests card image and file keys through authenticated resources', async () => {
    const source = {
      header: { title: { tag: 'plain_text', content: 'Card title' } },
      body: {
        elements: [{ tag: 'img', img_key: 'img_card' }, { tag: 'file', file_key: 'file_card', file_name: 'card.txt' }],
      },
    }
    const get = vi.fn().mockImplementation(async () => ({ getReadableStream: () => Readable.from(['data']) }))
    const resources = new ChannelInboundResources()
    const ingest = vi.spyOn(resources, 'ingest').mockResolvedValue({ type: 'text', text: 'attachment' })
    try {
      const output = JSON.stringify(
        await feishuMessageContent(await fixture('interactive', source, true), event, resources, {
          resourceClient: { get },
        }),
      )
      expect(output).toContain('Card title')
      expect(output).not.toContain('img_card')
      expect(output).not.toContain('file_card')
      expect(get.mock.calls.map(call => call[0].params.type)).toEqual(['image', 'file'])
      expect(ingest.mock.calls[0]?.[0]).toEqual(event)
      expect(ingest.mock.calls[0]?.[4]).toBe('root:img_card')
    } finally {
      await resources.dispose()
    }
  })
  it('does not reinterpret folder tokens as downloadable files', async () => {
    const resources = new ChannelInboundResources()
    const get = vi.fn()
    try {
      await feishuMessageContent(await fixture('folder', { file_key: 'folder_token' }, true), event, resources, {
        resourceClient: { get },
      })
      expect(get).not.toHaveBeenCalled()
    } finally {
      await resources.dispose()
    }
  })
  it('bounds malformed, oversized and deeply nested input', async () => {
    const resources = new ChannelInboundResources()
    try {
      const message = await fixture('future_type', {})
      for (const rawContent of ['{', JSON.stringify({ text: '界'.repeat(30_001) })]) {
        expect(JSON.stringify(await feishuMessageContent(message, event, resources, { rawContent })))
          .toContain('structure unavailable')
      }
      let nested: unknown = 'hidden'
      for (let depth = 0; depth < 20; depth++) nested = { child: nested }
      expect(
        JSON.stringify(await feishuMessageContent(message, event, resources, { rawContent: JSON.stringify(nested) })),
      ).toContain('structure truncated')
    } finally {
      await resources.dispose()
    }
  })
  it('fails closed on mismatched source and dispatches forward messages', async () => {
    const resources = new ChannelInboundResources()
    const get = vi.fn().mockResolvedValue({ code: 403 })
    try {
      expect(
        JSON.stringify(
          await feishuMessageContent(
            await fixture('text', { text: 'secret' }),
            { ...event, conversationId: 'other' },
            resources,
          ),
        ),
      ).not.toContain('secret')
      expect(
        JSON.stringify(
          await feishuMessageContent(await fixture('merge_forward', {}), event, resources, { messageClient: { get } }),
        ),
      ).toContain('Forwarded messages unavailable')
      expect(get).toHaveBeenCalledTimes(1)
    } finally {
      await resources.dispose()
    }
  })
  it('contains resource response timeouts without late ingestion', async () => {
    vi.useFakeTimers()
    const resources = new ChannelInboundResources()
    const ingest = vi.spyOn(resources, 'ingest')
    try {
      const message = await fixture('file', { file_key: 'file_key' })
      const result = feishuMessageContent(message, event, resources, {
        resourceClient: { get: () => new Promise(() => {}) },
      })
      await vi.advanceTimersByTimeAsync(2501)
      expect(JSON.stringify(await result)).toContain('unavailable')
      expect(ingest).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      await resources.dispose()
    }
  })
})
