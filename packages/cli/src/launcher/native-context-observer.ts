import { ContextObservations } from './context-observations.js'
import type { NativeContextBudget } from './native-context-budget.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512

/** Projects only the current authenticated connection's native usage notifications. */
export class NativeContextObserver {
  private readonly sessions = new Map<string, { generation: number; sequence: number; budget: NativeContextBudget }>()
  constructor(
    readonly observations: ContextObservations,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs = 120_000,
  ) {}

  /** The caller owns session admission and the evidence behind any resolved budget. */
  track(sessionId: string, generation: number, budget: NativeContextBudget): void {
    if (!validId(sessionId)) throw new Error('invalid')
    this.observations.open(sessionId, generation)
    const old = this.sessions.get(sessionId)
    if (old?.generation === generation) {
      if (JSON.stringify(old.budget) !== JSON.stringify(budget)) this.observations.invalidate(sessionId, 'config')
      old.budget = budget
    } else this.sessions.set(sessionId, { generation, sequence: 0, budget })
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  disconnect(): void {
    for (const sessionId of this.sessions.keys()) this.observations.retire(sessionId)
    this.sessions.clear()
  }

  notification(method: string, value: unknown): void {
    const params = object(value), sessionId = params.threadId
    if (!validId(sessionId)) return
    const current = this.sessions.get(sessionId)
    if (!current) return
    if (method === 'thread/closed') {
      this.sessions.delete(sessionId)
      this.observations.retire(sessionId)
      return
    }
    if (method === 'thread/settings/updated') {
      current.budget = { status: 'unavailable', reason: 'unknown' }
      this.observations.invalidate(sessionId, 'config')
      return
    }
    if (
      method === 'thread/compacted'
      || (['item/started', 'item/completed'].includes(method) && object(params.item).type === 'contextCompaction')
    ) {
      this.observations.invalidate(sessionId, 'reset')
      return
    }
    if (method !== 'thread/tokenUsage/updated') return
    const usage = object(params.tokenUsage), total = object(usage.last).totalTokens
    const window = usage.modelContextWindow
    if (!validId(params.turnId) || !Number.isSafeInteger(total) || Number(total) < 0) {
      this.observations.unavailable(sessionId)
      return
    }
    const observedAt = this.now()
    if (
      !Number.isSafeInteger(observedAt) || !Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs <= 0
      || !Number.isSafeInteger(observedAt + this.maxAgeMs)
    ) return
    const budget = current.budget.status === 'resolved' && window === current.budget.usableWindow
      ? { status: 'resolved' as const, tokens: current.budget.tokens }
      : {
        status: 'unavailable' as const,
        reason: current.budget.status === 'resolved' ? 'unknown' as const : current.budget.reason,
      }
    const epoch = this.observations.open(sessionId, current.generation)
    this.observations.observe({
      sessionId,
      sessionGeneration: current.generation,
      turnId: params.turnId,
      usedTokens: Number(total),
      ...(current.budget.status === 'resolved' && budget.status === 'resolved'
        ? { rawModelWindowTokens: current.budget.rawWindow, usableModelWindowTokens: current.budget.usableWindow }
        : {}),
      budget,
      observedAt,
      expiresAt: observedAt + this.maxAgeMs,
      sequence: ++current.sequence,
      ...epoch,
    })
  }

  dispose(): void {
    this.disconnect()
    this.observations.dispose()
  }
}

/** Bind the observer to one authenticated native control connection at a time. */
export function attachNativeContextObserver(
  subscribe: (listener: (method: string, value: unknown) => void) => () => void,
  observer: NativeContextObserver,
): () => void {
  let generation = 1
  return subscribe((method, value) => {
    if (method === 'cordisx/connection/closed') {
      observer.disconnect()
      generation += 1
      return
    }
    const params = object(value)
    if (method === 'thread/tokenUsage/updated' && validId(params.threadId) && !observer.has(params.threadId)) {
      observer.track(params.threadId, generation, { status: 'unavailable', reason: 'unknown' })
    }
    observer.notification(method, value)
  })
}
