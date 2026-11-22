import { describe, expect, it, vi } from 'vitest'
import { LogicalContinuationReader } from '../packages/cli/src/launcher/logical-continuation-reader.js'
import { logicalHistoryToolCall } from '../packages/cli/src/launcher/logical-continuation-tool.js'

const source = { hostId: 'local', appId: 'codex', profileId: 'personal', sessionId: 'source' }
const destination = { ...source, sessionId: 'destination' }
const caller = { session: destination, turnId: 'turn', actorKey: 'account/tenant/chat/user' }
const call = {
  threadId: destination.sessionId,
  turnId: caller.turnId,
  callId: 'call',
  tool: 'cordisx_continuation_history',
  arguments: { limit: 1 },
}

function fixture() {
  const activeCaller = vi.fn(async () => structuredClone(caller))
  const page = vi.fn(async () => ({ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'synthetic' }] }] }))
  const reader = new LogicalContinuationReader({
    relation: async () => ({
      operationId: 'operation',
      logicalConversationId: 'logical',
      revision: 1,
      mode: 'linked',
      source,
      destination,
      historyCategories: ['user-text'],
    }),
    authorized: async () => true,
    page,
  })
  return { activeCaller, page, reader }
}

describe('logical history native tool boundary', () => {
  it('resolves the active Host identity and returns only that relation’s allowed page', async () => {
    const f = fixture()
    const result = await logicalHistoryToolCall(call, f, f.reader)
    expect(f.activeCaller).toHaveBeenCalledWith('destination', 'turn')
    expect(result.success).toBe(true)
    expect(JSON.parse(result.contentItems[0]!.text).entries).toEqual([{ category: 'user-text', text: 'synthetic' }])
  })
  it('does not let tool arguments select a source, actor, or contract', async () => {
    for (const key of ['source', 'actor', 'contract']) {
      const f = fixture()
      const result = await logicalHistoryToolCall({ ...call, arguments: { [key]: 'forged' } }, f, f.reader)
      expect(result.success).toBe(false)
      expect(f.page).not.toHaveBeenCalled()
    }
  })
  it('bounds an oversized model page request without accepting malformed limits', async () => {
    const f = fixture()
    const read = vi.spyOn(f.reader, 'read')
    expect((await logicalHistoryToolCall({ ...call, arguments: { limit: 100 } }, f, f.reader)).success).toBe(true)
    expect(read).toHaveBeenCalledWith(caller, { contract: 'cordisx.continuation-history-request/v1', limit: 32 })
    for (const limit of [0, -1, 1.5, '100']) {
      expect((await logicalHistoryToolCall({ ...call, arguments: { limit } }, f, f.reader)).success).toBe(false)
    }
  })
  it('withholds a page if the active turn ends or its actor changes during the read', async () => {
    for (const next of [undefined, { ...caller, actorKey: 'another-user' }]) {
      const f = fixture()
      let release!: () => void
      let started!: () => void
      const reading = new Promise<void>(resolve => {
        started = resolve
      })
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      f.page.mockImplementationOnce(async () => {
        started()
        await gate
        return { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'synthetic' }] }] }
      })
      const pending = logicalHistoryToolCall(call, f, f.reader)
      await reading
      f.activeCaller.mockResolvedValueOnce(next as typeof caller)
      release()
      const result = await pending
      expect(result.success).toBe(false)
      expect(JSON.stringify(result)).not.toContain('synthetic')
    }
  })
  it('fails closed for wrong tools, namespaces, turns, callers and unavailable native reads', async () => {
    const f = fixture()
    for (
      const bad of [
        { ...call, tool: 'another' },
        { ...call, namespace: 'another' },
        { ...call, threadId: 'another' },
        { ...call, turnId: 'another' },
        { ...call, callId: '' },
        { ...call, arguments: [] },
      ]
    ) expect((await logicalHistoryToolCall(bad, f, f.reader)).success).toBe(false)
    f.page.mockRejectedValueOnce(new Error('private detail'))
    const result = await logicalHistoryToolCall(call, f, f.reader)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private detail')
  })
})
