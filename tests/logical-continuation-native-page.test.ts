import { describe, expect, it, vi } from 'vitest'
import { logicalNativeHistoryPage } from '../packages/cli/src/launcher/logical-continuation-native-page.js'
import { LogicalContinuationReader } from '../packages/cli/src/launcher/logical-continuation-reader.js'
import { JsonLineRpcError } from '../packages/cli/src/providers/json-line-rpc.js'

const source = { hostId: 'local', appId: 'codex', profileId: 'p', sessionId: 'source' }

describe('logical continuation native pages', () => {
  it('retains raw item types and native pagination when the item API is available', async () => {
    const nativeRequest = vi.fn(async () => ({
      data: [{ item: { type: 'reasoning', content: ['private'] } }, { item: { type: 'agentMessage', text: 'hello' } }],
      nextCursor: 'older',
    }))
    const page = await logicalNativeHistoryPage({ nativeRequest }, source)
    expect(page.items).toEqual([{ type: 'agentMessage', text: 'hello' }, { type: 'reasoning', content: ['private'] }])
    expect(page.nextCursor).toMatch(/^logical-items-v1:/u)
    expect(page.pagination).toBe('native-items')
    expect(nativeRequest).toHaveBeenCalledWith(
      'thread/items/list',
      expect.objectContaining({ threadId: 'source', limit: 32 }),
    )
  })
  it('keeps each item associated with its native turn when reversing a page', async () => {
    const nativeRequest = vi.fn(async () => ({
      data: [
        { turnId: 'new', item: { type: 'agentMessage', text: 'new' } },
        { turnId: 'old', item: { type: 'userMessage', content: [] } },
      ],
      nextCursor: null,
    }))
    const page = await logicalNativeHistoryPage({ nativeRequest }, source)
    expect(page.turnIds).toEqual(['old', 'new'])
  })
  it('pages a long native turn and detects a changed source before advancing', async () => {
    const items = Array.from({ length: 35 }, (_, i) => ({ type: 'agentMessage', text: String(i) }))
    const nativeRequest = vi.fn(async (method: string, params: Readonly<Record<string, unknown>>) => {
      if (method === 'thread/items/list') throw new JsonLineRpcError('unsupported', -32601)
      return params.cursor === 'older'
        ? { data: [{ id: 'old', items: [{ type: 'userMessage', content: [] }] }], nextCursor: null }
        : { data: [{ id: 'new', items }], nextCursor: 'older' }
    })
    const first = await logicalNativeHistoryPage({ nativeRequest }, source)
    expect(first.items).toHaveLength(32)
    expect(first.pagination).toBe('native-turn')
    const second = await logicalNativeHistoryPage({ nativeRequest }, source, first.nextCursor)
    expect(second.items).toHaveLength(3)
    const third = await logicalNativeHistoryPage({ nativeRequest }, source, second.nextCursor)
    expect(third.items).toEqual([{ type: 'userMessage', content: [] }])
    items[0]!.text = 'changed'
    await expect(logicalNativeHistoryPage({ nativeRequest }, source, first.nextCursor)).rejects.toThrow(
      'HISTORY_CURSOR_INVALID',
    )
    await expect(logicalNativeHistoryPage({ nativeRequest }, { ...source, sessionId: 'other' }, first.nextCursor))
      .rejects.toThrow('HISTORY_CURSOR_INVALID')
  })
  it('does not fall back when the native read fails for another reason', async () => {
    const nativeRequest = vi.fn(async () => {
      throw new Error('transport failed')
    })
    await expect(logicalNativeHistoryPage({ nativeRequest }, source)).rejects.toThrow('transport failed')
    expect(nativeRequest).toHaveBeenCalledTimes(1)
  })
  it('preserves omission reporting through the authorized reader on a turn-only native backend', async () => {
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === 'thread/items/list') throw new JsonLineRpcError('unsupported', -32601)
      return {
        data: [{
          id: 'turn',
          items: [
            { type: 'reasoning', content: ['private'] },
            { type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] },
          ],
        }],
        nextCursor: null,
      }
    })
    const destination = { ...source, sessionId: 'destination' }
    const reader = new LogicalContinuationReader({
      relation: async () => ({
        operationId: 'op',
        logicalConversationId: 'logical',
        revision: 1,
        mode: 'linked',
        source,
        destination,
        historyCategories: ['user-text'],
      }),
      authorized: async () => true,
      page: (ref, cursor) => logicalNativeHistoryPage({ nativeRequest }, ref, cursor),
    })
    const result = await reader.read({ session: destination, turnId: 'active', actorKey: 'owner' }, {
      contract: 'cordisx.continuation-history-request/v1',
    })
    expect(result).toMatchObject({
      pagination: 'native-turn',
      entries: [{ category: 'user-text', text: 'hello' }],
      omitted: ['attachment', 'raw-reasoning', 'encrypted-reasoning'],
    })
  })
})
