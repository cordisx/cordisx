import { describe, expect, it, vi } from 'vitest'
import { channelThreadHistory } from '../packages/cli/src/launcher/channel-thread-history.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const request = {
  conversationId: 'oc_chat',
  kind: 'group' as const,
  threadId: 'omt_topic',
  anchorMessageId: 'om_anchor',
  pageSize: 2,
  order: 'asc' as const,
}
const anchor = { message_id: 'om_anchor', chat_id: 'oc_chat', thread_id: 'omt_topic' }
const sibling = {
  message_id: 'om_sibling',
  chat_id: 'oc_chat',
  thread_id: 'omt_topic',
  msg_type: 'text',
  body: { content: 'sibling' },
  sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user', sender_name: 'Sender' },
}
const sdk = (get: unknown, list: unknown) => ({ rawClient: { im: { v1: { message: { get, list } } } } }) as never
const get = () => vi.fn(async () => ({ code: 0, data: { items: [anchor] } }))
const page = (items: unknown[] = [sibling]) => ({ code: 0, data: { items, has_more: true, page_token: 'next' } })

describe('scoped thread history', () => {
  it('reads actual siblings with pagination, identities and no time filters', async () => {
    const read = get(), list = vi.fn(async () => page()), authorize = vi.fn()
    const result = await channelThreadHistory(
      account,
      { ...request, pageToken: 'previous' },
      sdk(read, list),
      authorize,
    )
    expect(read).toHaveBeenCalledWith({ path: { message_id: 'om_anchor' }, params: { user_id_type: 'open_id' } })
    expect(list).toHaveBeenCalledWith({
      params: {
        container_id_type: 'thread',
        container_id: 'omt_topic',
        page_size: 2,
        sort_type: 'ByCreateTimeAsc',
        with_sender_name: true,
        page_token: 'previous',
      },
    })
    expect(result).toMatchObject({
      status: 'ok',
      hasMore: true,
      pageToken: 'next',
      messages: [{ messageId: 'om_sibling', content: 'sibling', sender: { name: 'Sender' } }],
    })
    expect(result).not.toHaveProperty('startTime')
    expect(authorize).toHaveBeenCalledTimes(3)
  })
  it('never lists another chat or a guessed thread', async () => {
    for (
      const invalid of [{ ...anchor, chat_id: 'oc_other' }, { ...anchor, thread_id: 'omt_other' }, {
        ...anchor,
        deleted: true,
      }, { ...anchor, thread_id: undefined }]
    ) {
      const list = vi.fn(async () => page())
      expect(
        await channelThreadHistory(
          account,
          request,
          sdk(async () => ({ code: 0, data: { items: [invalid] } }), list),
          () => {},
        ),
      )
        .toMatchObject({ code: 'CHANNEL_THREAD_SOURCE_MISMATCH' })
      expect(list).not.toHaveBeenCalled()
    }
  })
  it('rejects mixed pages, missing identity and broken cursors without disclosure', async () => {
    for (
      const response of [
        page([{ ...sibling, chat_id: 'oc_other' }]),
        page([{ ...sibling, thread_id: 'omt_other' }]),
        page([{ ...sibling, chat_id: undefined }]),
        { code: 0, data: { items: [sibling], has_more: true } },
        { code: 0, data: { items: [sibling], has_more: true, page_token: 'x'.repeat(2049) } },
        page([{ ...sibling, body: { content: 'x'.repeat(1_048_576) } }]),
      ]
    ) {
      expect(await channelThreadHistory(account, request, sdk(get(), async () => response), () => {}))
        .toEqual({ status: 'rejected', code: 'CHANNEL_THREAD_HISTORY_INVALID_PAGE' })
    }
  })
  it('fences revocation before listing and before disclosure', async () => {
    for (const failureAt of [2, 3]) {
      let checks = 0
      const list = vi.fn(async () => page())
      expect(
        await channelThreadHistory(account, request, sdk(get(), list), () => {
          if (++checks === failureAt) throw new Error('CHANNEL_GENERATION_CHANGED')
        }),
      ).toEqual({ status: 'unavailable', code: 'CHANNEL_GENERATION_CHANGED' })
      expect(list).toHaveBeenCalledTimes(failureAt === 2 ? 0 : 1)
    }
  })
  it('does not start a late list after an anchor timeout and bounds overlapping reads', async () => {
    vi.useFakeTimers()
    try {
      let resolveAnchor!: (value: unknown) => void
      const list = vi.fn(async () => page())
      const channel = sdk(() =>
        new Promise(resolve => {
          resolveAnchor = resolve
        }), list)
      const result = channelThreadHistory(account, request, channel, () => {})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toMatchObject({ code: 'CHANNEL_THREAD_HISTORY_TIMEOUT' })
      resolveAnchor({ code: 0, data: { items: [anchor] } })
      await vi.advanceTimersByTimeAsync(0)
      expect(list).not.toHaveBeenCalled()
      const blocked = sdk(() => new Promise(() => {}), list)
      const reads = Array.from({ length: 8 }, () => channelThreadHistory(account, request, blocked, () => {}))
      expect(await channelThreadHistory(account, request, blocked, () => {}))
        .toMatchObject({ code: 'CHANNEL_THREAD_HISTORY_BUSY' })
      await vi.advanceTimersByTimeAsync(10_000)
      await Promise.all(reads)
    } finally {
      vi.useRealTimers()
    }
  })
  it('validates the source, bounds, policy and generation in the production RPC path', async () => {
    const source = { ...account, conversationId: 'oc_chat', kind: 'group' }
    const history = vi.fn(async () => ({ status: 'ok' }))
    let allowed = true, generation = 'one'
    const access = { generation: 'one', accounts: () => [{ ref: account, state: 'ready' }], threadHistory: history }
    const consumer = {
      agentAccess: {
        caller: () => ({ source, threadId: 'chat' }),
        hasPreparation: () => false,
        preparation: () => false,
      },
      taskSettings: { isBound: () => true },
      commandAllowed: () => allowed,
    }
    const tools = new ChannelConversationTools(() => ({ ...access, generation }) as never, consumer as never)
    expect(await tools.call('thread-history', { account, ...request }, {})).toEqual({ status: 'ok' })
    for (const change of [{ conversationId: 'oc_other' }, { pageSize: 51 }, { startTime: '1' }]) {
      expect(await tools.call('thread-history', { account, ...request, ...change }, {}))
        .toMatchObject({ status: 'rejected' })
    }
    allowed = false
    expect(await tools.call('thread-history', { account, ...request }, {}))
      .toMatchObject({ code: 'CHANNEL_POLICY_DENIED' })
    allowed = true
    history.mockImplementationOnce(async () => {
      generation = 'two'
      return { status: 'ok', messages: ['private'] }
    })
    expect(await tools.call('thread-history', { account, ...request }, {}))
      .toMatchObject({ code: 'CHANNEL_GENERATION_CHANGED' })
    tools.dispose()
  })
})
