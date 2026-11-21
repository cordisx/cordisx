import { describe, expect, it, vi } from 'vitest'
import {
  LogicalContinuationReader,
  type LogicalHistoryCaller,
  type LogicalHistoryRelation,
} from '../packages/cli/src/launcher/logical-continuation-reader.js'

const input = (value: Record<string, unknown>) => ({ contract: 'cordisx.continuation-history-request/v1', ...value })
const source = { hostId: 'local', appId: 'codex', profileId: 'p', sessionId: 'source' }
const destination = { ...source, sessionId: 'target' }
const caller: LogicalHistoryCaller = { session: destination, turnId: 'turn', actorKey: 'trusted-actor' }
const relation: LogicalHistoryRelation = {
  operationId: 'operation',
  logicalConversationId: 'logical',
  revision: 1,
  mode: 'linked',
  source,
  destination,
  historyCategories: ['user-text', 'assistant-text'],
}
function fixture() {
  let now = 0
  const authority = {
    relation: vi.fn(async () => structuredClone(relation)),
    authorized: vi.fn(async () => true),
    page: vi.fn(async (_source: typeof source, cursor?: string) =>
      cursor
        ? { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'older' }] }] }
        : { items: [{ type: 'agentMessage', text: 'newer' }], nextCursor: 'native-cursor' }
    ),
  }
  return {
    authority,
    reader: new LogicalContinuationReader(authority, () => now),
    advance: (value: number) => {
      now += value
    },
  }
}

describe('logical continuation source reader', () => {
  it('resolves the source from the committed relation and pages without accepting a source argument', async () => {
    const f = fixture(), first = await f.reader.read(caller, input({ limit: 1 }))
    expect(first.source).toEqual(source)
    expect(first.entries).toEqual([{ category: 'assistant-text', text: 'newer' }])
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).not.toBe('native-cursor')
    const second = await f.reader.read(caller, input({ limit: 1, cursor: first.nextCursor }))
    expect(second.entries).toEqual([{ category: 'user-text', text: 'older' }])
    expect(second.truncated).toBe(false)
    expect(f.authority.page.mock.calls.map(([ref]) => ref)).toEqual([source, source])
    await expect(f.reader.read(caller, input({ sessionId: 'different' }))).rejects.toThrow('INVALID_HISTORY_REQUEST')
  })
  it('binds a cursor to the exact destination, actor and active turn', async () => {
    const f = fixture(), page = await f.reader.read(caller, input({}))
    for (
      const changed of [
        { ...caller, actorKey: 'other' },
        { ...caller, turnId: 'other' },
        { ...caller, session: { ...destination, sessionId: 'other' } },
      ]
    ) await expect(f.reader.read(changed, input({ cursor: page.nextCursor }))).rejects.toThrow()
    f.advance(600_001)
    await expect(f.reader.read(caller, input({ cursor: page.nextCursor }))).rejects.toThrow('HISTORY_CURSOR_INVALID')
  })
  it('fails closed when consent is revoked during the native read', async () => {
    const f = fixture()
    f.authority.authorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(f.reader.read(caller, input({}))).rejects.toThrow('HISTORY_ACCESS_DENIED')
  })
  it('rejects stale native data when continuing a clipped page', async () => {
    const f = fixture()
    f.authority.page.mockResolvedValue({ items: [{ type: 'agentMessage', text: 'x'.repeat(60_010) }] })
    const page = await f.reader.read(caller, input({}))
    expect(page.truncated).toBe(true)
    f.authority.page.mockResolvedValue({ items: [{ type: 'agentMessage', text: 'y'.repeat(60_010) }] })
    await expect(f.reader.read(caller, input({ cursor: page.nextCursor }))).rejects.toThrow('HISTORY_CURSOR_INVALID')
  })
  it('refuses ambiguous relations and native pagination loops', async () => {
    const f = fixture()
    f.authority.relation.mockResolvedValueOnce({ ...relation, source: destination })
    await expect(f.reader.read(caller, input({}))).rejects.toThrow('HISTORY_ACCESS_DENIED')
    const page = await f.reader.read(caller, input({}))
    f.authority.page.mockResolvedValueOnce({ items: [], nextCursor: 'native-cursor' })
    await expect(f.reader.read(caller, input({ cursor: page.nextCursor }))).rejects.toThrow('HISTORY_PAGE_UNAVAILABLE')
  })
  it('never reads a source from another Host, app, or profile', async () => {
    for (const field of ['hostId', 'appId', 'profileId'] as const) {
      const f = fixture()
      f.authority.relation.mockResolvedValueOnce({ ...relation, source: { ...source, [field]: 'other' } })
      await expect(f.reader.read(caller, input({}))).rejects.toThrow('HISTORY_ACCESS_DENIED')
      expect(f.authority.page).not.toHaveBeenCalled()
    }
  })
  it('rejects an oversized native page instead of silently clipping or hashing it', async () => {
    const f = fixture()
    f.authority.page.mockResolvedValue({ items: [{ type: 'agentMessage', text: 'x'.repeat(2_000_001) }] })
    await expect(f.reader.read(caller, input({}))).rejects.toThrow('HISTORY_PAGE_UNAVAILABLE')
  })
})
