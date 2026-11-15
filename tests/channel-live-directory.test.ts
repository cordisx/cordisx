import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelLiveDirectory } from '../packages/cli/src/launcher/channel-live-directory.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const account = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'test' }
const observed = {
  source: { event: { ...account, kind: 'direct', conversationId: 'oc_observed' } },
} as ChannelUserInput

describe('configured live Channel directory', () => {
  it('reads current group members using the live SDK, pages by open ID and does not treat stale observations as current members', async () => {
    const directory = new ChannelLiveDirectory()
    const event = {
      ...account,
      kind: 'group',
      conversationId: 'oc_members',
      semantics: 'conversation',
      threadId: 'oc_members',
      eventId: 'om_members',
    } as ChannelEventRef
    directory.observe({ source: { event } } as ChannelUserInput, {
      mentions: [{ key: '@_user_1', userId: 'ou_stale', name: 'Stale' }],
    })
    const get = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id_type: 'open_id', member_id: 'ou_one', name: 'Same' }],
          has_more: true,
          page_token: 'next',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ member_id_type: 'open_id', member_id: 'ou_two', name: 'Same' }], has_more: false },
      })
    directory.connected(account, { rawClient: { im: { v1: { chatMembers: { get } } } } } as never)
    try {
      expect(directory.replyCapabilities(event)).toEqual({ reply: true, thread: true })
      expect(directory.replyCapabilities({ ...event, kind: 'direct' })).toEqual({ reply: true, thread: false })
      expect(await directory.users(event)).toEqual({
        complete: true,
        users: [{ id: 'ou_one', name: 'Same' }, { id: 'ou_two', name: 'Same' }],
      })
      expect(get).toHaveBeenNthCalledWith(2, {
        path: { chat_id: 'oc_members' },
        params: { member_id_type: 'open_id', page_size: 100, page_token: 'next' },
      })
      expect(await directory.users({ ...event, accountId: 'other' })).toEqual({
        users: [],
        complete: false,
        code: 'CHANNEL_DIRECTORY_UNAVAILABLE',
      })
      directory.connected(account, undefined)
      expect(directory.replyCapabilities(event)).toEqual({ reply: false, thread: false })
    } finally {
      directory.clear()
    }
  })
  it('reports incomplete member lists without trusting security limits, repeated pages or private errors', async () => {
    const directory = new ChannelLiveDirectory()
    const event = { ...account, kind: 'group', conversationId: 'oc_members' } as ChannelEventRef
    const get = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id_type: 'open_id', member_id: 'ou_one', name: 'One' }],
          has_more: false,
          trigger_security_conf_limit: true,
        },
      })
      .mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'repeat' } })
      .mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'repeat' } })
      .mockRejectedValueOnce({ response: { status: 403, data: { code: 99991672, msg: 'private' } } })
    directory.connected(account, { rawClient: { im: { v1: { chatMembers: { get } } } } } as never)
    try {
      expect(await directory.users(event)).toMatchObject({
        complete: false,
        code: 'CHANNEL_DIRECTORY_PERMISSION_DENIED',
        users: [{ id: 'ou_one' }],
      })
      expect(await directory.users(event)).toMatchObject({ complete: false, code: 'CHANNEL_DIRECTORY_INVALID_PAGE' })
      const denied = await directory.users(event)
      expect(denied).toEqual({ complete: false, code: 'CHANNEL_DIRECTORY_PERMISSION_DENIED', users: [] })
      expect(JSON.stringify(denied)).not.toContain('private')
    } finally {
      directory.clear()
    }
  })
  it('keeps observed chats and exposes only safe platform permission metadata through ordinary tools', async () => {
    const directory = new ChannelLiveDirectory()
    directory.observe(observed)
    const list = vi.fn(async () => {
      throw {
        response: { status: 400, data: { code: 99991672, msg: 'private response' } },
        config: { headers: { Authorization: 'private-token' } },
      }
    })
    directory.connected(account, { rawClient: { im: { v1: { chat: { list } } } } } as never)
    const tools = new ChannelConversationTools(() => ({
      generation: 'test',
      runtime: {} as never,
      accounts: () => [{ ref: account, state: 'ready' }],
      conversations: ref => directory.conversations(ref),
      drain: async () => {},
    }))
    try {
      const result = await tools.call('conversations', { account })
      expect(result).toEqual({
        status: 'partial',
        generation: 'test',
        complete: false,
        conversations: [{ id: 'oc_observed', name: 'oc_observed', kind: 'direct' }],
        code: 'CHANNEL_DIRECTORY_PERMISSION_DENIED',
        diagnostic: { stage: 'directory', httpStatus: 400, platformCode: 99991672 },
      })
      expect(list).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result)).not.toMatch(/private|Authorization|headers|response/u)
    } finally {
      tools.dispose()
      directory.clear()
    }
  })

  it('merges a complete directory, reports a later-page failure as partial, and retains observations offline', async () => {
    const directory = new ChannelLiveDirectory()
    directory.observe(observed)
    const list = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ chat_id: 'oc_group', name: 'Group' }], has_more: true, page_token: 'next' },
      })
      .mockResolvedValueOnce({ code: 99991672 })
      .mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: 'oc_group', name: 'Group' }], has_more: false } })
    directory.connected(account, { rawClient: { im: { v1: { chat: { list } } } } } as never)
    try {
      const partial = await directory.conversations(account)
      expect(partial).toMatchObject({ complete: false, code: 'CHANNEL_DIRECTORY_PERMISSION_DENIED' })
      expect(partial.conversations.map(row => row.id)).toEqual(['oc_observed', 'oc_group'])
      expect(list).toHaveBeenNthCalledWith(2, { params: { page_size: 100, page_token: 'next' } })
      expect(await directory.conversations(account)).toMatchObject({
        complete: true,
        conversations: partial.conversations,
      })
      directory.connected(account, undefined)
      expect(await directory.conversations(account)).toEqual({
        complete: false,
        code: 'CHANNEL_DIRECTORY_UNAVAILABLE',
        conversations: [{ id: 'oc_observed', name: 'oc_observed', kind: 'direct' }],
      })
    } finally {
      directory.clear()
    }
  })
})
