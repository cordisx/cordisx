import { describe, expect, it } from 'vitest'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { JsonLineRpcError } from '../packages/cli/src/providers/json-line-rpc.js'
import { continuationTurnHistoryPage } from '../packages/cli/src/launcher/channel-continuation-turn-history.js'

function fixture(text = 'a'.repeat(60_000) + 'tail') {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
  const nativeRequest = async (method: string, params: Readonly<Record<string, unknown>>) => {
    calls.push({ method, params })
    if (method === 'thread/items/list') throw new JsonLineRpcError('not supported', -32601)
    expect(method).toBe('thread/turns/list')
    expect(params).toMatchObject({ threadId: 'source', limit: 1, itemsView: 'full', sortDirection: 'desc' })
    return params.cursor === 'older'
      ? { data: [{ id: 'older-turn', items: [{ type: 'agentMessage', text: 'older' }] }], nextCursor: null }
      : { data: [{ id: 'new-turn', items: [{ type: 'agentMessage', text }] }], nextCursor: 'older' }
  }
  return { calls, nativeRequest }
}

describe('continuation native turn fallback', () => {
  it('falls back only for an unsupported item method and pages one turn and bounded output at a time', async () => {
    const f = fixture()
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/work',
      nativeRequest: f.nativeRequest,
    })
    const first = await sessions.continuationHistory('source', { limit: 1 })
    expect(first).toMatchObject({ pagination: 'native-turn', truncated: true, total: null })
    expect(first.entries[0]!.text.length).toBeLessThanOrEqual(60_001)
    const head = await sessions.continuationHistory('source', { limit: 1, cursor: first.nextCursor })
    const older = await sessions.continuationHistory('source', { limit: 1, cursor: head.nextCursor })
    expect(older.entries).toEqual([{ role: 'assistant', text: 'older' }])
    expect(older.nextCursor).toBeUndefined()
    expect(f.calls.filter(call => call.method === 'thread/items/list')).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'thread/turns/list').every(call => call.params.limit === 1)).toBe(
      true,
    )
  })
  it('rejects cursors from another source or a changed turn before returning data', async () => {
    const f = fixture()
    const first = await continuationTurnHistoryPage(f, 'source', { limit: 1 })
    await expect(continuationTurnHistoryPage(f, 'other', { cursor: first.nextCursor })).rejects.toThrow(
      'cursor-invalid',
    )
    await expect(continuationTurnHistoryPage(fixture('changed'), 'source', { cursor: first.nextCursor }))
      .rejects.toThrow('cursor-invalid')
  })
  it('does not fall back for other native failures', async () => {
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/work',
      nativeRequest: async () => {
        throw new Error('transport failed')
      },
    })
    await expect(sessions.continuationHistory('source', {})).rejects.toThrow('transport failed')
  })
  it('reports the native transport size limit distinctly', async () => {
    await expect(continuationTurnHistoryPage(
      {
        nativeRequest: async () => {
          throw new JsonLineRpcError('RPC line exceeds maximum size')
        },
      },
      'source',
      {},
    )).rejects.toThrow('CONTINUATION_HISTORY_PAGE_TOO_LARGE')
  })
  it('does not silently drop an empty native page that claims more history', async () => {
    await expect(continuationTurnHistoryPage(
      {
        nativeRequest: async () => ({ data: [], nextCursor: 'next' }),
      },
      'source',
      {},
    )).rejects.toThrow('CONTINUATION_HISTORY_UNAVAILABLE')
  })
})
