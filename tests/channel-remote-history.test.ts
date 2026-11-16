import { describe, expect, it, vi } from 'vitest'
import { channelRemoteHistory } from '../packages/cli/src/launcher/channel-remote-history.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const request = {
  conversationId: 'oc_chat',
  kind: 'group' as const,
  startTime: '100',
  endTime: '200',
  pageSize: 2,
  order: 'asc' as const,
}
const sdk = (list: unknown) => ({ rawClient: { im: { v1: { message: { list } } } } }) as never

describe('remote Channel history', () => {
  it('reads one page with names and preserves message, thread, sender and mention identities', async () => {
    const list = vi.fn(async () => ({
      code: 0,
      data: {
        has_more: true,
        page_token: 'next',
        items: [{
          message_id: 'om_one',
          chat_id: 'oc_chat',
          thread_id: 'omt_one',
          msg_type: 'text',
          body: { content: '{"text":"hello"}' },
          sender: { id: 'ou_alice', id_type: 'open_id', sender_type: 'user', sender_name: 'Alice' },
          mentions: [{ key: '@_1', id: 'ou_bob', id_type: 'open_id', name: 'Bob' }],
        }],
      },
    }))
    const result = await channelRemoteHistory(account, request, sdk(list))
    expect(list).toHaveBeenCalledWith({
      params: {
        container_id_type: 'chat',
        container_id: 'oc_chat',
        start_time: '100',
        end_time: '200',
        page_size: 2,
        sort_type: 'ByCreateTimeAsc',
        with_sender_name: true,
      },
    })
    expect(result).toMatchObject({
      status: 'ok',
      source: 'remote',
      account,
      hasMore: true,
      pageToken: 'next',
      messages: [{
        messageId: 'om_one',
        threadId: 'omt_one',
        sender: { id: 'ou_alice', idType: 'open_id', name: 'Alice' },
        mentions: [{ id: 'ou_bob', name: 'Bob' }],
      }],
    })
  })
  it('reports missing permissions and invalid pages without leaking API messages', async () => {
    expect(await channelRemoteHistory(account, request, sdk(async () => ({ code: 99991672, msg: 'private' }))))
      .toMatchObject({ status: 'rejected', code: 'CHANNEL_REMOTE_HISTORY_PERMISSION_DENIED' })
    expect(
      await channelRemoteHistory(account, request, sdk(async () => ({ code: 0, data: { items: [], has_more: true } }))),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_REMOTE_HISTORY_INVALID_PAGE' })
    expect(await channelRemoteHistory(account, request, undefined)).toMatchObject({ status: 'unavailable' })
  })
  it('rejects a page with another conversation and accepts an omitted optional chat id', async () => {
    const page = (chat_id?: string) => ({
      code: 0,
      data: { has_more: false, items: [{ message_id: 'om_one', ...(chat_id === undefined ? {} : { chat_id }) }] },
    })
    expect(await channelRemoteHistory(account, request, sdk(async () => page('oc_other')))).toEqual({
      status: 'rejected',
      code: 'CHANNEL_REMOTE_HISTORY_INVALID_PAGE',
    })
    expect(await channelRemoteHistory(account, request, sdk(async () => page()))).toMatchObject({
      status: 'ok',
      messages: [{ messageId: 'om_one' }],
    })
  })
  it('bounds slow platform calls without issuing unlimited overlapping requests', async () => {
    vi.useFakeTimers()
    try {
      const list = vi.fn(() => new Promise(() => {}))
      const channel = sdk(list)
      const reads = Array.from({ length: 8 }, () => channelRemoteHistory(account, request, channel))
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await Promise.all(reads)).every(result => result.code === 'CHANNEL_REMOTE_HISTORY_TIMEOUT')).toBe(true)
      expect(await channelRemoteHistory(account, request, channel)).toMatchObject({
        code: 'CHANNEL_REMOTE_HISTORY_BUSY',
      })
      expect(list).toHaveBeenCalledTimes(8)
    } finally {
      vi.useRealTimers()
    }
  })
  it('validates the page bounds and fences incoming requests to their actual source', async () => {
    const source = { ...account, conversationId: 'oc_chat', kind: 'group' }
    const history = vi.fn(async () => ({ status: 'ok' }))
    const access = { generation: 'one', accounts: () => [{ ref: account, state: 'ready' }], remoteHistory: history }
    const consumer = {
      agentAccess: { caller: () => ({ source, threadId: 'chat' }) },
      taskSettings: { isBound: () => true },
    }
    const tools = new ChannelConversationTools(() => access as never, consumer as never)
    const input = { account, ...request }
    expect(await tools.call('remote-history', input, {})).toEqual({ status: 'ok' })
    expect(await tools.call('remote-history', { ...input, conversationId: 'oc_other' }, {})).toEqual({
      status: 'rejected',
      code: 'CHANNEL_SOURCE_SCOPE_MISMATCH',
    })
    expect(await tools.call('remote-history', { ...input, pageSize: 51 }, {})).toEqual({
      status: 'rejected',
      code: 'INVALID_REQUEST',
    })
    expect(await tools.call('remote-history', { ...input, startTime: '201' }, {})).toEqual({
      status: 'rejected',
      code: 'INVALID_TIME_RANGE',
    })
    expect(history).toHaveBeenCalledOnce()
    tools.dispose()
  })
})
