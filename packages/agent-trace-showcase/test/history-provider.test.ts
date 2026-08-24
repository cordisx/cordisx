import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_AGENT_EVENT_CONTRACT,
  CORDISX_AGENT_EVENT_SCHEMA_VERSION,
  CORDISX_AGENT_HISTORY_CONTRACT,
  CORDISX_AGENT_HISTORY_SCHEMA_VERSION,
  type CordisXAgentEvent,
  type CordisXAgentHistory,
  type CordisXAgentHistoryPage,
} from 'cordisx/contracts'
import { HistoricalTraceShowcaseStore, mergeTraceEvents } from '../src/history-provider.js'
import { projectAgentEvent } from '../src/live-provider.js'
import type { TraceShowcaseStore, TraceSnapshot } from '../src/types.js'

const source = Object.freeze({
  kind: 'adapter' as const, adapterId: 'codex-jsonl', adapterVersion: '1.0.0',
})

function item(input: {
  id: string
  seq: number
  time: number
  itemId?: string
  messageId?: string
  toolCallId?: string
  kind?: 'assistant-message' | 'user-message' | 'tool-call' | 'tool-result' | 'compaction'
}): CordisXAgentEvent<'item.lifecycle'> {
  return {
    contract: CORDISX_AGENT_EVENT_CONTRACT,
    schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
    eventId: input.id,
    sessionId: 'session-a',
    turnId: 'turn-1',
    stepId: 'step-1',
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    seq: input.seq,
    time: input.time,
    type: 'item.lifecycle',
    provenance: 'observed',
    source,
    data: { kind: input.kind ?? 'assistant-message', phase: 'completed' },
  }
}

function page(
  events: readonly CordisXAgentEvent[],
  input: { nextCursor?: string; tailCursor?: string; corruptLines?: number; compacted?: boolean } = {},
): CordisXAgentHistoryPage {
  return {
    contract: CORDISX_AGENT_HISTORY_CONTRACT,
    schemaVersion: CORDISX_AGENT_HISTORY_SCHEMA_VERSION,
    sessionId: 'session-a', snapshotId: 'snapshot-opaque-0001', limit: 500,
    requestedPayloadPolicy: 'summarized', effectivePayloadPolicy: 'summarized',
    source: {
      kind: 'historical', adapterId: 'codex-jsonl', adapterVersion: '1.0.0',
      hostId: 'codex-desktop-history', profileId: 'profile-opaque-0001',
    },
    coverage: {
      state: input.corruptLines === undefined ? 'complete' : 'partial',
      compacted: input.compacted ?? false,
      corruptLines: input.corruptLines ?? 0,
      oversizedLines: 0, redactedFields: 2, tailAvailable: input.tailCursor !== undefined,
    },
    ...(events[0] === undefined ? {} : { fromSeq: events[0].seq, toSeq: events.at(-1)!.seq }),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
    ...(input.tailCursor === undefined ? {} : { tailCursor: input.tailCursor }),
    events,
  }
}

class LiveStub implements TraceShowcaseStore {
  readonly dispose = vi.fn()
  private readonly listeners = new Set<() => void>()
  constructor(private readonly events: readonly ReturnType<typeof projectAgentEvent>[] = []) {}
  getSnapshot(): TraceSnapshot {
    return {
      sessionId: 'session-a', events: this.events, hasEarlier: false, loadingEarlier: false,
      status: {
        mode: 'partial', completeness: 'partial', contractVersion: 'cordisx.agent-events/v2',
        diagnostics: ['Current connection unavailable.'], supportedOperations: [],
        payloadPolicy: 'inline', origins: ['live'],
      },
      range: { loaded: this.events.length, renderedLimit: 500 },
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async loadEarlier(): Promise<void> {}
  async requestDemo(): Promise<string> { throw new Error('unavailable') }
  async cancelQueued(): Promise<boolean> { return false }
  async clearQueued(): Promise<number> { return 0 }
}

function history(
  first: CordisXAgentHistoryPage | { readonly deny: true },
  tails: readonly CordisXAgentHistoryPage[] = [],
): CordisXAgentHistory & { query: ReturnType<typeof vi.fn>; tail: ReturnType<typeof vi.fn> } {
  let tailIndex = 0
  return {
    status: () => ({
      hostId: 'codex-desktop-history', hostName: 'Codex Desktop history', mode: 'available',
      adapterId: 'codex-jsonl', adapterVersion: '1.0.0', profileId: 'profile-opaque-0001',
      defaultPayloadPolicy: 'referenced', diagnostics: [], filesystemExposed: false, rawBridgeExposed: false,
    }),
    query: vi.fn(async () => 'deny' in first
      ? { ok: false as const, error: { code: 'permission-denied' as const, message: 'Denied.' } }
      : { ok: true as const, value: first }),
    tail: vi.fn(async () => ({ ok: true as const, value: tails[Math.min(tailIndex++, tails.length - 1)]! })),
  }
}

describe('Agent Trace historical provider', () => {
  it('projects only public historical evidence and exposes coverage without paths', async () => {
    const imported = page([
      item({ id: 'hist-user', seq: 0, time: 1_000, itemId: 'item-user', messageId: 'message-user', kind: 'user-message' }),
      item({ id: 'hist-tool', seq: 1, time: 2_000, itemId: 'item-tool', toolCallId: 'tool-1', kind: 'tool-call' }),
      item({ id: 'hist-compaction', seq: 2, time: 3_000, itemId: 'item-compaction', kind: 'compaction' }),
    ], { corruptLines: 1, compacted: true })
    const service = history(imported)
    const live = new LiveStub()
    const store = new HistoricalTraceShowcaseStore(service, live, 'session-a')
    await store.settled()

    expect(service.query).toHaveBeenCalledWith({
      sessionId: 'session-a', limit: 500, payloadPolicy: 'summarized',
    })
    expect(store.getSnapshot()).toMatchObject({
      status: {
        mode: 'partial', completeness: 'partial', origins: ['live', 'historical'],
        payloadPolicy: 'summarized',
        historyCoverage: { state: 'partial', compacted: true, corruptLines: 1, redactedFields: 2 },
      },
      range: { loaded: 3, renderedLimit: 500 },
    })
    expect(store.getSnapshot().events.map(event => [event.origin, event.semanticType])).toEqual([
      ['historical', 'item.user-message'],
      ['historical', 'item.tool-call'],
      ['historical', 'item.compaction'],
    ])
    expect(JSON.stringify(store.getSnapshot())).not.toMatch(/Users|CODEX_HOME|\.jsonl/)
    store.dispose()
    expect(live.dispose).toHaveBeenCalledOnce()
  })

  it('prefers a native-id live observation and assigns one continuous display sequence', () => {
    const historical = projectAgentEvent(item({
      id: 'historical-id', seq: 99, time: 1_000, itemId: 'shared-item', messageId: 'shared-message',
    }), 'historical')
    const live = projectAgentEvent(item({
      id: 'live-id', seq: 4, time: 1_001, itemId: 'shared-item', messageId: 'shared-message',
    }), 'live')
    expect(mergeTraceEvents([historical], [live])).toEqual([
      expect.objectContaining({ id: 'live-id', origin: 'live', seq: 0, sourceSeq: 4 }),
    ])
  })

  it('applies the configured Host page size and bounded merged window', async () => {
    const service = history(page([
      item({ id: 'hist-configured', seq: 0, time: 1_000, itemId: 'configured' }),
    ]))
    const store = new HistoricalTraceShowcaseStore(service, new LiveStub(), 'session-a', {
      pageSize: 75,
      windowSize: 150,
    })
    await store.settled()
    expect(service.query).toHaveBeenCalledWith({
      sessionId: 'session-a', limit: 75, payloadPolicy: 'summarized',
    })
    expect(store.getSnapshot().range.renderedLimit).toBe(150)
    store.dispose()
  })

  it('enforces one 500-row merged UI boundary for oversized imported windows', () => {
    const imported = Array.from({ length: 620 }, (_, index) => projectAgentEvent(item({
      id: `large-${index}`, seq: index, time: 1_000 + index, itemId: `item-${index}`,
    }), 'historical'))
    const merged = mergeTraceEvents(imported, [])
    expect(merged).toHaveLength(500)
    expect(merged[0]).toMatchObject({ id: 'large-120', seq: 0, sourceSeq: 120 })
    expect(merged.at(-1)).toMatchObject({ id: 'large-619', seq: 499, sourceSeq: 619 })
  })

  it('moves through opaque earlier pages and incrementally tails without duplicates', async () => {
    const newest = page([item({ id: 'hist-new', seq: 2, time: 3_000, itemId: 'new' })], { nextCursor: 'opaque-earlier-cursor-0001' })
    const older = page([item({ id: 'hist-old', seq: 0, time: 1_000, itemId: 'old' })])
    const service = history(newest)
    service.query.mockResolvedValueOnce({ ok: true, value: newest }).mockResolvedValueOnce({ ok: true, value: older })
    const store = new HistoricalTraceShowcaseStore(service, new LiveStub(), 'session-a')
    await store.settled()
    expect(store.getSnapshot().hasEarlier).toBe(true)
    await store.loadEarlier()
    expect(store.getSnapshot().events.map(event => event.id)).toEqual(['hist-old'])
    expect(service.query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'opaque-earlier-cursor-0001' }))
    store.dispose()

    const tailStart = page([item({ id: 'tail-old', seq: 0, time: 1_000, itemId: 'old' })], { tailCursor: 'opaque-tail-cursor-0001' })
    const tailNext = page([
      item({ id: 'tail-old', seq: 0, time: 1_000, itemId: 'old' }),
      item({ id: 'tail-new', seq: 1, time: 2_000, itemId: 'new' }),
    ], { tailCursor: 'opaque-tail-cursor-0002' })
    const tailService = history(tailStart, [tailNext])
    const tailStore = new HistoricalTraceShowcaseStore(tailService, new LiveStub(), 'session-a')
    await tailStore.settled()
    await tailStore.refreshTail()
    expect(tailStore.getSnapshot().events.map(event => event.id)).toEqual(['tail-old', 'tail-new'])
    expect(tailService.tail).toHaveBeenCalledWith(expect.objectContaining({ tailCursor: 'opaque-tail-cursor-0001' }))
    tailStore.dispose()
  })

  it('fails closed on history denial while retaining the independently sourced live status', async () => {
    const store = new HistoricalTraceShowcaseStore(history({ deny: true }), new LiveStub(), 'session-a')
    await store.settled()
    expect(store.getSnapshot()).toMatchObject({
      events: [], status: { origins: ['live'], mode: 'partial' },
    })
    expect(store.getSnapshot().status.diagnostics.at(-1)).toContain('permission-denied')
    store.dispose()
  })
})
