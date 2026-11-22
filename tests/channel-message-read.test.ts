import { describe, expect, it, vi } from 'vitest'
import { channelDirectReply, channelMessageRead } from '../packages/cli/src/launcher/channel-message-read.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const source = {
  ...account,
  conversationId: 'oc_chat',
  kind: 'group' as const,
  semantics: 'reply-chain' as const,
  threadId: 'om_root',
  eventId: 'om_current',
  messageId: 'om_current',
}
const rows = {
  om_current: { message_id: 'om_current', chat_id: 'oc_chat', parent_id: 'om_parent', root_id: 'om_root' },
  om_parent: {
    message_id: 'om_parent',
    chat_id: 'oc_chat',
    parent_id: 'om_root',
    msg_type: 'text',
    body: { content: '{"text":"https://example.test/mr"}' },
    sender: { id: 'ou_alice', id_type: 'open_id', sender_type: 'user', sender_name: 'Alice' },
  },
  om_root: { message_id: 'om_root', chat_id: 'oc_chat', body: { content: '{"text":"older"}' } },
}
const sdk = (get: unknown) => ({ rawClient: { im: { v1: { message: { get } } } } }) as never

describe('referenced Channel messages', () => {
  it('reads the direct parent with sender and content, not the reply-chain root', async () => {
    const get = vi.fn(async ({ path }: { path: { message_id: keyof typeof rows } }) => ({
      code: 0,
      data: { items: [rows[path.message_id]] },
    }))
    const result = await channelDirectReply(source, sdk(get))
    expect(get.mock.calls.map(call => call[0].path.message_id)).toEqual(['om_current', 'om_parent'])
    expect(result).toMatchObject({
      status: 'ok',
      message: {
        messageId: 'om_parent',
        parentId: 'om_root',
        sender: { id: 'ou_alice', name: 'Alice' },
        content: '{"text":"https://example.test/mr"}',
      },
    })
  })
  it('does not expose other chats, deleted messages or platform error details', async () => {
    const get = async () => ({ code: 0, data: { items: [{ ...rows.om_parent, chat_id: 'oc_other' }] } })
    expect(await channelMessageRead(source, 'om_parent', sdk(get))).toEqual({
      status: 'unavailable',
      code: 'CHANNEL_MESSAGE_NOT_ACCESSIBLE',
    })
    expect(await channelMessageRead(source, 'om_parent', sdk(async () => ({ code: 230027, msg: 'private' }))))
      .toEqual({ status: 'unavailable', code: 'CHANNEL_MESSAGE_READ_FAILED' })
    expect(await channelDirectReply({ ...source, semantics: 'conversation' }, sdk(get))).toBeUndefined()
  })
  it('does not pretend a reply-chain root is the direct parent when parent metadata is missing', async () => {
    const get = vi.fn(async () => ({
      code: 0,
      data: { items: [{ message_id: 'om_current', chat_id: 'oc_chat', root_id: 'om_root' }] },
    }))
    expect(await channelDirectReply(source, sdk(get))).toEqual({
      status: 'unavailable',
      code: 'CHANNEL_PARENT_NOT_AVAILABLE',
    })
    expect(get).toHaveBeenCalledOnce()
  })
  it('fences on-demand reads to the source conversation and its parent chain', async () => {
    const readMessage = vi.fn(async (_event, id: keyof typeof rows) => ({
      status: 'ok' as const,
      message: { messageId: id, ...('parent_id' in rows[id] ? { parentId: rows[id].parent_id } : {}) },
    }))
    const access = { generation: 'one', accounts: () => [{ ref: account, state: 'ready' }], readMessage }
    const consumer = {
      agentAccess: {
        caller: () => ({ source, threadId: 'chat' }),
        hasPreparation: () => false,
        preparation: () => false,
      },
      taskSettings: { isBound: () => true },
    }
    const tools = new ChannelConversationTools(() => access as never, consumer as never)
    const input = { account, conversationId: 'oc_chat', kind: 'group', messageId: 'om_root' }
    expect(await tools.call('message-get', input, {})).toMatchObject({
      status: 'ok',
      message: { messageId: 'om_root' },
    })
    expect(readMessage.mock.calls.map(call => call[1])).toEqual(['om_current', 'om_parent', 'om_root'])
    expect(await tools.call('message-get', { ...input, conversationId: 'oc_other' }, {})).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_SOURCE_SCOPE_MISMATCH',
    })
    expect(await tools.call('message-get', { ...input, messageId: 'om_unrelated' }, {})).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_MESSAGE_NOT_IN_REPLY_CHAIN',
    })
    tools.dispose()
  })
})
