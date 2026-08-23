import type { TraceEvent, TraceLane, TracePhase, TraceTruth } from './types.js'

export type TraceOrder = 'sequence' | 'time'

export interface TraceFilters {
  readonly search: string
  readonly lane: TraceLane | 'all'
  readonly truth: TraceTruth | 'all'
  readonly source: string | 'all'
  readonly type: string | 'all'
  readonly phase: TracePhase | 'all'
}

export interface TraceStepGroup {
  readonly key: string
  readonly stepId?: string
  readonly stepNumber?: number
  readonly events: readonly TraceEvent[]
}

export interface TraceTurnGroup {
  readonly key: string
  readonly turnId?: string
  readonly turnNumber?: number
  readonly steps: readonly TraceStepGroup[]
}

export interface TraceOverviewSpan {
  readonly event: TraceEvent
  readonly left: number
  readonly width: number
}

export const EMPTY_FILTERS: TraceFilters = Object.freeze({
  search: '', lane: 'all', truth: 'all', source: 'all', type: 'all', phase: 'all',
})

function searchable(event: TraceEvent): string {
  return [
    event.id, event.type, event.semanticType, event.summary, event.truth, event.phase,
    event.source.id, event.source.label, event.plugin?.id, event.plugin?.source,
    event.permission?.capability, JSON.stringify(event.payload ?? {}),
  ].filter(Boolean).join('\n').toLocaleLowerCase()
}

export function filterTraceEvents(events: readonly TraceEvent[], filters: TraceFilters): readonly TraceEvent[] {
  const query = filters.search.trim().toLocaleLowerCase()
  return events.filter(event => (
    (filters.lane === 'all' || event.lane === filters.lane)
    && (filters.truth === 'all' || event.truth === filters.truth)
    && (filters.source === 'all' || event.source.id === filters.source || event.plugin?.source === filters.source)
    && (filters.type === 'all' || event.type === filters.type)
    && (filters.phase === 'all' || event.phase === filters.phase)
    && (query === '' || searchable(event).includes(query))
  ))
}

export function orderTraceEvents(events: readonly TraceEvent[], order: TraceOrder): readonly TraceEvent[] {
  return [...events].sort(order === 'sequence'
    ? (left, right) => left.seq - right.seq
    : (left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt) || left.seq - right.seq)
}

export function groupTraceEvents(events: readonly TraceEvent[]): readonly TraceTurnGroup[] {
  const turns: Array<{
    key: string
    turnId?: string
    turnNumber?: number
    steps: Array<{ key: string; stepId?: string; stepNumber?: number; events: TraceEvent[] }>
  }> = []
  for (const event of events) {
    const turnKey = event.turnId ?? `between:${event.seq}`
    let turn = turns.at(-1)
    if (turn?.key !== turnKey) {
      turn = {
        key: turnKey,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.turnNumber === undefined ? {} : { turnNumber: event.turnNumber }),
        steps: [],
      }
      turns.push(turn)
    }
    const stepKey = event.stepId ?? `unscoped:${event.seq}`
    let step = turn.steps.at(-1)
    if (step?.key !== stepKey) {
      step = {
        key: stepKey,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
        events: [],
      }
      turn.steps.push(step)
    }
    step.events.push(event)
  }
  return turns
}

export function deriveOverview(events: readonly TraceEvent[], order: TraceOrder): readonly TraceOverviewSpan[] {
  if (events.length === 0) return []
  if (order === 'sequence') {
    const first = events[0]!.seq
    const extent = Math.max(1, events.at(-1)!.seq - first + 1)
    return events.map(event => ({
      event,
      left: ((event.seq - first) / extent) * 100,
      width: Math.max(0.8, 72 / extent),
    }))
  }
  const starts = events.map(event => Date.parse(event.timing?.startedAt ?? event.recordedAt))
  const first = Math.min(...starts)
  const ends = events.map((event, index) => starts[index]! + Math.max(1, event.timing?.durationMs ?? 1))
  const extent = Math.max(1, Math.max(...ends) - first)
  return events.map((event, index) => ({
    event,
    left: ((starts[index]! - first) / extent) * 100,
    width: Math.max(0.8, ((Math.max(1, event.timing?.durationMs ?? 1)) / extent) * 100),
  }))
}
