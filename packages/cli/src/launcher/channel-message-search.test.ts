import { describe, expect, it, vi } from 'vitest'
import { channelMessageSearch } from './channel-message-search.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const input = {
  conversationId: 'oc_source',
  kind: 'group' as const,
  query: 'project',
  startTime: '1',
  endTime: '3',
  pageSize: 50,
}
const hit = { message_id: 'om_hit', chat_id: 'oc_source', create_time: '2000', body: { content: 'hello' } }
const search = { code: 0, data: { items: [{ meta_data: { message_id: 'om_hit' } }], has_more: false } }
const details = { code: 0, data: { items: [hit] } }
const channel = (request: unknown) => ({ rawClient: { request } }) as never

describe('bounded remote message search', () => {
  it('uses exact conversation/time filters and discloses authoritative details only', async () => {
    const request = vi.fn().mockResolvedValueOnce(search).mockResolvedValueOnce(details)
    const result = await channelMessageSearch(account, input, channel(request), () => {})
    expect(result).toMatchObject({
      status: 'ok',
      hasMore: false,
      messages: [{ messageId: 'om_hit', content: 'hello' }],
    })
    expect(request.mock.calls[0]?.[0]).toEqual({
      method: 'POST',
      url: '/open-apis/im/v1/messages/search',
      params: { page_size: 50 },
      data: {
        query: 'project',
        filter: {
          chat_ids: ['oc_source'],
          time_range: {
            start_time: '1970-01-01T00:00:01.000Z',
            end_time: '1970-01-01T00:00:03.000Z',
          },
        },
      },
    })
    expect(request.mock.calls[1]?.[0]).toEqual({
      method: 'GET',
      url: '/open-apis/im/v1/messages/mget',
      params: { message_ids: ['om_hit'], user_id_type: 'open_id' },
      paramsSerializer: expect.any(Function),
    })
    expect(request.mock.calls[1]?.[0].paramsSerializer()).toBe('message_ids=om_hit&user_id_type=open_id')
  })
  it('does not disclose cross-chat, missing, duplicate, or out-of-window details', async () => {
    for (
      const items of [
        [],
        [hit, hit],
        [{ ...hit, chat_id: 'oc_other' }],
        [{ ...hit, message_id: 'om_other' }],
        [{ ...hit, create_time: undefined }],
        [{ ...hit, create_time: '3000' }],
        [{ ...hit, create_time: '999' }],
      ]
    ) {
      const request = vi.fn().mockResolvedValueOnce(search).mockResolvedValueOnce({ code: 0, data: { items } })
      expect(await channelMessageSearch(account, input, channel(request), () => {})).not.toHaveProperty('messages')
    }
  })
  it('distinguishes valid empty results from failed reads without an ID-only fallback', async () => {
    const empty = vi.fn(async () => ({ code: 0, data: { items: [], has_more: false } }))
    expect(await channelMessageSearch(account, input, channel(empty), () => {})).toMatchObject({
      status: 'ok',
      messages: [],
    })
    expect(empty).toHaveBeenCalledTimes(1)
    const failure = vi.fn().mockResolvedValueOnce(search).mockResolvedValueOnce({ code: 999 })
    expect(await channelMessageSearch(account, input, channel(failure), () => {})).toMatchObject({
      status: 'unavailable',
    })
  })
  it('rejects invalid filters, malformed pages and nonadvancing cursors', async () => {
    const request = vi.fn(async () => search)
    for (
      const changed of [{ query: '  ' }, { startTime: '3' }, { endTime: '-1' }, { pageSize: 51 }, { pageToken: '\n' }]
    ) {
      expect(await channelMessageSearch(account, { ...input, ...changed }, channel(request), () => {}))
        .toMatchObject({ status: 'rejected' })
    }
    expect(request).not.toHaveBeenCalled()
    for (
      const data of [{ items: search.data.items, has_more: true }, {
        items: search.data.items,
        has_more: true,
        page_token: 'same',
      }, { items: [search.data.items[0], search.data.items[0]], has_more: false }]
    ) {
      const malformed = vi.fn(async () => ({ code: 0, data }))
      expect(await channelMessageSearch(account, { ...input, pageToken: 'same' }, channel(malformed), () => {}))
        .not.toHaveProperty('messages')
      expect(malformed).toHaveBeenCalledTimes(1)
    }
  })
  it('rechecks authorization before detail reads and before disclosure', async () => {
    for (const revokedAt of [2, 4, 5]) {
      let checks = 0
      const request = vi.fn().mockResolvedValueOnce(search).mockResolvedValueOnce(details)
      expect(
        await channelMessageSearch(account, input, channel(request), () => {
          if (++checks === revokedAt) throw new Error('CHANNEL_POLICY_DENIED')
        }),
      ).toMatchObject({ status: 'unavailable', code: 'CHANNEL_POLICY_DENIED' })
      expect(request).toHaveBeenCalledTimes(revokedAt === 2 ? 1 : 2)
    }
  })
  it('cannot start detail reads after a timed-out search resolves late', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (response: unknown) => void
      const request = vi.fn(() =>
        new Promise(done => {
          resolve = done
        })
      )
      const pending = channelMessageSearch(account, input, channel(request), () => {})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toMatchObject({ status: 'unavailable', code: 'CHANNEL_SEARCH_TIMEOUT' })
      resolve(search)
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps timed-out unsettled calls bounded until their underlying requests settle', async () => {
    vi.useFakeTimers()
    try {
      const resolvers: Array<(value: unknown) => void> = []
      const request = vi.fn(() =>
        new Promise(resolve => {
          resolvers.push(resolve)
        })
      )
      const sdk = channel(request)
      const pending = Array.from({ length: 8 }, () => channelMessageSearch(account, input, sdk, () => {}))
      expect(await channelMessageSearch(account, input, sdk, () => {})).toMatchObject({ code: 'CHANNEL_SEARCH_BUSY' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await Promise.all(pending)).every(result => result.status === 'unavailable')).toBe(true)
      expect(await channelMessageSearch(account, input, sdk, () => {})).toMatchObject({ code: 'CHANNEL_SEARCH_BUSY' })
      for (const resolve of resolvers) resolve(search)
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledTimes(8)
      request.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: false } }))
      expect(await channelMessageSearch(account, input, sdk, () => {})).toMatchObject({ status: 'ok' })
    } finally {
      vi.useRealTimers()
    }
  })
})
