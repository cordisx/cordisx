import { describe, expect, it } from 'vitest'
import {
  type AgentBridgeCodexAuthority,
  codexConversationSummary,
  createCodexBridgeHandler,
} from '../packages/cli/src/launcher/agent-bridge.js'
import {
  codexRecentEntries,
  codexTranscriptPage,
  codexTurn,
} from '../packages/cli/src/launcher/agent-bridge-codex-history.js'

/** Native metadata and opaque item cursors, with full hydration forbidden. */
function history(texts: readonly string[]) {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
  const authority: AgentBridgeCodexAuthority = {
    catalog: async () => [],
    nativeRequest: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/read') {
        expect(params.includeTurns).toBe(false)
        return { thread: { id: params.threadId, name: 'history', historyMode: 'paginated' } }
      }
      if (method === 'thread/items/list') {
        expect(params.sortDirection).toBe('desc')
        const start = params.cursor === undefined ? texts.length : Number(String(params.cursor).slice(7))
        const end = Math.max(0, start - Number(params.limit))
        return {
          data: texts.slice(end, start).toReversed().map(text => ({
            turnId: 'turn',
            item: { type: 'agentMessage', text },
          })),
          nextCursor: end === 0 ? null : `native:${end}`,
        }
      }
      throw new Error('unexpected method')
    },
  }
  return { authority, calls }
}

describe('native Codex transcript paging', () => {
  it('passes bounded native limits and cursors while returning every message exactly once', async () => {
    const f = history(Array.from({ length: 7 }, (_, index) => `message${index}`))
    const handler = createCodexBridgeHandler(f.authority)
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await handler('read_session', { sessionId: 'thread', limit: 2, cursor }) as {
        transcript: Array<{ text: string }>
        nextCursor?: string
        transcriptTotal: number | null
      }
      expect(page.transcriptTotal).toBeNull()
      seen.push(...page.transcript.map(entry => entry.text))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    expect(seen).toEqual(['message5', 'message6', 'message3', 'message4', 'message1', 'message2', 'message0'])
    expect(f.calls.filter(call => call.method === 'thread/items/list').map(call => call.params.cursor))
      .toEqual([undefined, 'native:5', 'native:3', 'native:1'])
    expect(f.calls.every(call => call.params.includeTurns !== true)).toBe(true)
    expect(f.calls.filter(call => call.method === 'thread/items/list').every(call => call.params.limit === 2)).toBe(
      true,
    )
  })

  it('preserves a clipped message head before advancing to older native items', async () => {
    const text = 'a'.repeat(60_000) + 'b'.repeat(60_000) + 'tail'
    const f = history(['older', text])
    const first = await codexTranscriptPage(f.authority, 'thread', { limit: 1 })
    const middle = await codexTranscriptPage(f.authority, 'thread', { limit: 1, cursor: first.nextCursor })
    const head = await codexTranscriptPage(f.authority, 'thread', { limit: 1, cursor: middle.nextCursor })
    const older = await codexTranscriptPage(f.authority, 'thread', { limit: 1, cursor: head.nextCursor })
    const restored = [head, middle, first].map(page => page.entries[0]!.text.replace(/^…/u, '')).join('')
    expect(restored).toBe(text)
    expect(older.entries).toEqual([{ role: 'assistant', text: 'older' }])
    expect(older.nextCursor).toBeUndefined()
    expect(f.calls.map(call => call.params.cursor)).toEqual([undefined, undefined, undefined, 'native:1'])
  })

  it('rejects cross-thread or changed-page cursors before returning a misleading transcript', async () => {
    const f = history(['old', 'x'.repeat(80_000)])
    const first = await codexTranscriptPage(f.authority, 'thread', { limit: 1 })
    await expect(codexTranscriptPage(f.authority, 'other', { cursor: first.nextCursor })).rejects.toThrow(
      'cursor-invalid',
    )
    const changed = history(['old', 'y'.repeat(80_000)])
    await expect(codexTranscriptPage(changed.authority, 'thread', { cursor: first.nextCursor }))
      .rejects.toThrow('cursor-invalid')
  })

  it('continues through image-only pages with no text and reports the history scan boundary', async () => {
    const calls: unknown[] = []
    const authority: AgentBridgeCodexAuthority = {
      catalog: async () => [],
      nativeRequest: async (_method, params) => {
        calls.push(params)
        return {
          data: [{ turnId: 't', item: { type: 'userMessage', content: [{ type: 'image', url: 'private-data' }] } }],
          nextCursor: `next${calls.length}`,
        }
      },
    }
    const page = await codexTranscriptPage(authority, 'thread')
    expect(page.entries).toEqual([])
    expect(page.nextCursor).toBeDefined()
    const recent = await codexRecentEntries(authority, 'thread')
    expect(recent).toMatchObject({ entries: [], capped: true, reason: 'history-page-limit' })
    expect(calls).toHaveLength(9)
  })

  it('checks completion only for the matching turn using item-free paginated turn metadata', async () => {
    const calls: unknown[] = []
    const authority: AgentBridgeCodexAuthority = {
      catalog: async () => [],
      nativeRequest: async (method, params) => {
        expect(method).toBe('thread/turns/list')
        expect(params.itemsView).toBe('notLoaded')
        calls.push(params)
        return params.cursor === undefined
          ? { data: [{ id: 'other', status: 'completed', items: [] }], nextCursor: 'older' }
          : { data: [{ id: 'wanted', status: 'inProgress', items: [] }], nextCursor: null }
      },
    }
    expect(await codexTurn(authority, 'thread', 'wanted')).toMatchObject({ id: 'wanted', status: 'inProgress' })
    expect(calls).toEqual([
      { threadId: 'thread', limit: 32, itemsView: 'notLoaded', sortDirection: 'desc' },
      { threadId: 'thread', limit: 32, itemsView: 'notLoaded', sortDirection: 'desc', cursor: 'older' },
    ])
  })

  it('scans older native pages for a body match and reports a bounded summary without full hydration', async () => {
    const messages = Array.from({ length: 70 }, (_, index) => index === 1 ? 'body needle' : `message${index}`)
    const f = history(messages)
    const native = f.authority.nativeRequest
    f.authority.nativeRequest = async (method, params) =>
      method === 'thread/list'
        ? { data: [{ id: 'thread', name: 'history' }] }
        : native(method, params)
    const listed = await createCodexBridgeHandler(f.authority)('list_sessions', { searchTerm: 'needle' })
    expect(listed).toMatchObject({
      sessions: [{ sessionId: 'thread', match: { excerpt: 'body needle' }, matchedIn: 'messages' }],
      scan: { capped: false, scanned: 1 },
    })
    expect(f.calls.filter(call => call.method === 'thread/items/list')).toHaveLength(3)
    expect(await codexConversationSummary(f.authority, 'thread')).toContain('message69')
    const long = history(Array.from({ length: 400 }, (_, index) => `message${index}`))
    const summary = await codexConversationSummary(long.authority, 'thread')
    expect(summary).toContain('Recent history only; older pages were not scanned.')
    expect(summary!.length).toBeLessThanOrEqual(4000)
  })
})
