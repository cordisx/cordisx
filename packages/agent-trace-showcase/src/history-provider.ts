import type {
  CordisXAgentHistory,
  CordisXAgentHistoryPage,
} from 'cordisx/contracts'
import { projectAgentEvent } from './live-provider.js'
import type {
  TraceAdapterStatus,
  TraceDemoRequest,
  TraceEvent,
  TraceShowcaseStore,
  TraceSnapshot,
} from './types.js'

const WINDOW_LIMIT = 500
const HISTORY_PROTOCOL_HEAD = 'e4c1fea227cb53e3a0833a0c84c5f9f487f107c5'
const TAIL_INTERVAL_MS = 2_000

function factualKey(event: TraceEvent): string {
  const phase = event.phase ?? ''
  const chunk = event.type === 'content.chunk'
    ? `:${String(event.payload?.channel ?? '')}:${String(event.payload?.index ?? '')}`
    : ''
  if (event.messageId !== undefined) return `message:${event.messageId}:${event.semanticType}:${phase}${chunk}`
  if (event.toolCallId !== undefined) return `tool:${event.toolCallId}:${event.semanticType}:${phase}${chunk}`
  if (event.itemId !== undefined) return `item:${event.itemId}:${event.semanticType}:${phase}${chunk}`
  return `event:${event.id}`
}

function eventOrder(left: TraceEvent, right: TraceEvent): number {
  return Date.parse(left.recordedAt) - Date.parse(right.recordedAt)
    || (left.origin === right.origin ? 0 : left.origin === 'live' ? 1 : -1)
    || left.seq - right.seq
    || left.id.localeCompare(right.id)
}

/** Merge imported and public-ledger observations without publishing a second ledger. */
export function mergeTraceEvents(
  historical: readonly TraceEvent[],
  live: readonly TraceEvent[],
  windowLimit = WINDOW_LIMIT,
): readonly TraceEvent[] {
  const facts = new Map<string, TraceEvent>()
  for (const event of historical) facts.set(factualKey(event), event)
  for (const event of live) facts.set(factualKey(event), event)
  const ordered = [...facts.values()].sort(eventOrder)
  const bounded = ordered.length <= windowLimit ? ordered : ordered.slice(-windowLimit)
  return Object.freeze(bounded.map((event, index) => Object.freeze({
    ...event,
    sourceSeq: event.sourceSeq ?? event.seq,
    seq: index,
  })))
}

function historyDiagnostics(page: CordisXAgentHistoryPage): readonly string[] {
  return Object.freeze([
    `Historical coverage is ${page.coverage.state}; imported JSONL is not live observation.`,
    `History payload policy: ${page.effectivePayloadPolicy}.`,
    ...(page.coverage.compacted ? ['The source reports compaction; pre-compaction detail may be absent.'] : []),
    ...(page.diagnostics ?? []).map(item => `${item.code}: ${item.count}`),
    'Historical projection cannot prove permissions, delivery/prompt lifecycle, forwarding, or model consumption.',
  ])
}

function statusFor(
  live: TraceAdapterStatus,
  page: CordisXAgentHistoryPage | undefined,
  error: string | undefined,
): TraceAdapterStatus {
  const historyAvailable = page !== undefined && page.coverage.state !== 'unavailable'
  const liveAvailable = live.completeness !== 'unavailable'
  const origins = Object.freeze([
    ...(liveAvailable ? ['live' as const] : []),
    ...(historyAvailable ? ['historical' as const] : []),
  ])
  return Object.freeze({
    ...live,
    mode: historyAvailable ? 'partial' : live.mode,
    completeness: historyAvailable ? 'partial' : live.completeness,
    contractVersion: 'cordisx.agent-events/v2 + cordisx.agent-history/v1',
    coreHead: HISTORY_PROTOCOL_HEAD,
    payloadPolicy: page?.effectivePayloadPolicy ?? live.payloadPolicy,
    origins,
    diagnostics: Object.freeze([
      ...live.diagnostics,
      ...(page === undefined ? [] : historyDiagnostics(page)),
      ...(error === undefined ? [] : [error]),
    ]),
    ...(page === undefined ? {} : {
      historyCoverage: Object.freeze({
        state: page.coverage.state,
        compacted: page.coverage.compacted,
        corruptLines: page.coverage.corruptLines,
        oversizedLines: page.coverage.oversizedLines,
        redactedFields: page.coverage.redactedFields,
        tailAvailable: page.coverage.tailAvailable,
      }),
    }),
  })
}

function importedEvents(page: CordisXAgentHistoryPage): readonly TraceEvent[] {
  return Object.freeze(page.events
    .filter(event => event.type !== 'message.delivery' && event.type !== 'input.contribution')
    .map(event => projectAgentEvent(event, 'historical')))
}

/**
 * Consumer-side composition over two public services. Filesystem, cursors,
 * profile identity, parsing, redaction, and permission policy stay Host-owned.
 */
export class HistoricalTraceShowcaseStore implements TraceShowcaseStore {
  private readonly listeners = new Set<() => void>()
  private historical: readonly TraceEvent[] = Object.freeze([])
  private page: CordisXAgentHistoryPage | undefined
  private nextCursor: string | undefined
  private tailCursor: string | undefined
  private operation = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private loadingEarlier = false
  private viewingLatest = true
  private error: string | undefined
  private readonly unsubscribeLive: () => void

  constructor(
    private readonly history: CordisXAgentHistory,
    private readonly live: TraceShowcaseStore,
    private readonly sessionId: string,
    private readonly options: { readonly pageSize: number; readonly windowSize: number } = {
      pageSize: WINDOW_LIMIT,
      windowSize: WINDOW_LIMIT,
    },
  ) {
    this.unsubscribeLive = live.subscribe(() => this.notify())
    this.operation = this.operation.then(() => this.initialQuery()).catch(error => this.fail(error))
  }

  getSnapshot(): TraceSnapshot {
    const live = this.live.getSnapshot()
    const events = mergeTraceEvents(this.historical, live.events, this.options.windowSize)
    return Object.freeze({
      sessionId: this.sessionId,
      status: statusFor(live.status, this.page, this.error),
      events,
      hasEarlier: this.nextCursor !== undefined,
      loadingEarlier: this.loadingEarlier,
      range: Object.freeze({
        ...(events[0] === undefined ? {} : { firstSeq: events[0].seq }),
        ...(events.at(-1) === undefined ? {} : { lastSeq: events.at(-1)!.seq }),
        loaded: events.length,
        renderedLimit: this.options.windowSize,
      }),
    })
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async loadEarlier(): Promise<void> {
    if (this.disposed || this.nextCursor === undefined || this.loadingEarlier) return
    this.loadingEarlier = true
    this.viewingLatest = false
    this.notify()
    const cursor = this.nextCursor
    this.operation = this.operation.then(async () => {
      const result = await this.history.query({
        sessionId: this.sessionId, cursor, limit: this.options.pageSize, payloadPolicy: 'summarized',
      })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (this.disposed) return
      this.page = result.value
      this.historical = Object.freeze(importedEvents(result.value).slice(0, this.options.windowSize))
      this.nextCursor = result.value.nextCursor
      this.tailCursor = result.value.tailCursor
      this.error = undefined
    }).catch(error => this.fail(error)).finally(() => {
      this.loadingEarlier = false
      this.notify()
    })
    await this.operation
  }

  async requestDemo(request: TraceDemoRequest): Promise<string> { return await this.live.requestDemo(request) }
  async cancelQueued(requestId: string): Promise<boolean> { return await this.live.cancelQueued(requestId) }
  async clearQueued(): Promise<number> { return await this.live.clearQueued() }

  async settled(): Promise<void> {
    const child = this.live as TraceShowcaseStore & { settled?: () => Promise<void> }
    await child.settled?.()
    await this.operation
  }

  /** Public for deterministic component/contract smoke; automatic tail uses the same path. */
  async refreshTail(): Promise<void> {
    if (this.disposed || this.tailCursor === undefined || !this.viewingLatest) return
    const tailCursor = this.tailCursor
    this.operation = this.operation.then(async () => {
      const result = await this.history.tail({
        sessionId: this.sessionId, tailCursor, limit: this.options.pageSize, payloadPolicy: 'summarized',
      })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (this.disposed) return
      this.page = result.value
      this.tailCursor = result.value.tailCursor ?? tailCursor
      const additions = importedEvents(result.value)
      const byId = new Map(this.historical.map(event => [event.id, event]))
      for (const event of additions) byId.set(event.id, event)
      this.historical = Object.freeze([...byId.values()].sort(eventOrder).slice(-this.options.windowSize))
      this.error = undefined
      this.notify()
    }).catch(error => this.fail(error))
    await this.operation
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribeLive()
    this.live.dispose()
    this.listeners.clear()
    this.historical = Object.freeze([])
    this.page = undefined
    this.nextCursor = undefined
    this.tailCursor = undefined
  }

  private async initialQuery(): Promise<void> {
    const result = await this.history.query({
      sessionId: this.sessionId, limit: this.options.pageSize, payloadPolicy: 'summarized',
    })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    if (this.disposed) return
    this.page = result.value
    this.historical = Object.freeze(importedEvents(result.value).slice(-this.options.windowSize))
    this.nextCursor = result.value.nextCursor
    this.tailCursor = result.value.tailCursor
    this.error = undefined
    this.notify()
    this.scheduleTail()
  }

  private scheduleTail(): void {
    if (this.disposed || this.tailCursor === undefined || !this.viewingLatest) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refreshTail().finally(() => this.scheduleTail())
    }, TAIL_INTERVAL_MS)
    const timer = this.timer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.error = `history-query-failed: ${error instanceof Error ? error.message : String(error)}`
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
