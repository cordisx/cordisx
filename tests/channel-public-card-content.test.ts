import { expect, it, vi } from 'vitest'
import { channelPublicCardContent } from '../packages/cli/src/launcher/channel-public-card-content.js'
import { channelMessageRead } from '../packages/cli/src/launcher/channel-message-read.js'
import { channelRemoteHistory } from '../packages/cli/src/launcher/channel-remote-history.js'
import { channelThreadHistory } from '../packages/cli/src/launcher/channel-thread-history.js'
import { channelMessageSearch } from '../packages/cli/src/launcher/channel-message-search.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const content = JSON.stringify({
  config: { wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 'Review' } },
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Body' } }, {
    tag: 'action',
    actions: [{
      tag: 'button',
      text: { tag: 'plain_text', content: 'Review' },
      value: { channelGenericAction: 'private-callback-fixture', version: 1, actionId: 'review' },
    }],
  }],
})
const message = {
  message_id: 'om_notice',
  chat_id: 'oc_chat',
  thread_id: 'omt_topic',
  msg_type: 'interactive',
  create_time: '2000',
  body: { content },
}

it('keeps ordinary text and plain notices unchanged but omits generic callback values before truncation', () => {
  expect(channelPublicCardContent('text', 'raw text')).toBe('raw text')
  const notice = JSON.stringify({ elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Notice' } }] })
  expect(channelPublicCardContent('interactive', notice)).toBe(notice)
  const redacted = channelPublicCardContent('interactive', content)
  expect(redacted).toContain('Review')
  expect(redacted).toContain('Body')
  expect(redacted).not.toContain('private-callback-fixture')
  expect(redacted).not.toContain('channelGenericAction')
  expect(redacted).not.toContain('"value"')
  expect(channelPublicCardContent('interactive', 'malformed private-callback-fixture')).toBeUndefined()
  expect(channelPublicCardContent('interactive', 'x'.repeat(64001))).toBeUndefined()
})

it('redacts callback values across message-get, remote history, thread history and search detail projection', async () => {
  const get = vi.fn(async () => ({ code: 0, data: { items: [message] } }))
  const list = vi.fn(async () => ({ code: 0, data: { items: [message], has_more: false } }))
  const request = vi.fn().mockResolvedValueOnce({
    code: 0,
    data: { items: [{ meta_data: { message_id: 'om_notice' } }], has_more: false },
  }).mockResolvedValueOnce({ code: 0, data: { items: [message] } })
  const channel = { rawClient: { im: { v1: { message: { get, list } } }, request } } as never
  const event = {
    ...account,
    conversationId: 'oc_chat',
    kind: 'group' as const,
    threadId: 'oc_chat',
    semantics: 'conversation' as const,
    eventId: 'input',
  }
  const results = [
    await channelMessageRead(event, 'om_notice', channel),
    await channelRemoteHistory(account, {
      conversationId: 'oc_chat',
      kind: 'group',
      startTime: '1',
      endTime: '3',
      pageSize: 20,
      order: 'asc',
    }, channel),
    await channelThreadHistory(
      account,
      {
        conversationId: 'oc_chat',
        kind: 'group',
        threadId: 'omt_topic',
        anchorMessageId: 'om_notice',
        pageSize: 20,
        order: 'asc',
      },
      channel,
      () => {},
    ),
    await channelMessageSearch(
      account,
      { conversationId: 'oc_chat', kind: 'group', query: 'Review', startTime: '1', endTime: '3', pageSize: 20 },
      channel,
      () => {},
    ),
  ]
  for (const result of results) {
    expect(result).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(result)).toContain('Review')
    expect(JSON.stringify(result)).not.toContain('private-callback-fixture')
    expect(JSON.stringify(result)).not.toContain('channelGenericAction')
  }
})
