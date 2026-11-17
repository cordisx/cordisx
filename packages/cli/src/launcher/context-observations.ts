import { randomUUID } from 'node:crypto'

export interface ContextObservation {
  readonly sessionId: string
  readonly sessionGeneration: number
  readonly turnId?: string
  readonly usedTokens: number
  readonly rawModelWindowTokens?: number
  readonly usableModelWindowTokens?: number
  readonly budget:
    | { readonly status: 'resolved'; readonly tokens: number }
    | { readonly status: 'unavailable'; readonly reason: 'unknown' | 'unsupported' | 'disabled' }
  readonly observedAt: number
  readonly expiresAt: number
  readonly resetEpoch: string
  readonly configEpoch: string
  /** Monotonic within a connection; never inferred from a native timestamp. */
  readonly sequence: number
}
type CloseCode = 'unsubscribed' | 'observer-failed' | 'session-replaced' | 'generation-replaced'
type Event = { readonly reason: 'crossed' | 'epoch-initial'; readonly sample: ContextObservation }
interface Watch {
  readonly ratio: number
  readonly observer: (event: Event) => void | Promise<void>
  readonly resolve: (value: { code: CloseCode }) => void
  closed: boolean
  epoch?: string
  above?: boolean
  lastExpiresAt?: number
  pending: Promise<void>
}
interface Session {
  readonly generation: number
  reset: string
  config: string
  sequence: number
  budgetSignature?: string
  sample?: ContextObservation
  readonly watches: Set<Watch>
}

/** Current-connection state only. Authorization and lifecycle ownership live in the service boundary. */
export class ContextObservations {
  private readonly sessions = new Map<string, Session>()
  private readonly sessionListeners = new Set<(sessionId: string) => void>()
  private disposed = false
  constructor(private readonly now: () => number = Date.now) {}

  open(sessionId: string, generation: number): { resetEpoch: string; configEpoch: string } {
    if (this.disposed || !sessionId || !Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid')
    const old = this.sessions.get(sessionId)
    if (old?.generation === generation) return { resetEpoch: old.reset, configEpoch: old.config }
    if (old) { for (const watch of old.watches) this.close(old, watch, 'session-replaced') }
    const current: Session = { generation, reset: randomUUID(), config: randomUUID(), sequence: -1, watches: new Set() }
    this.sessions.set(sessionId, current)
    for (const listener of this.sessionListeners) {
      try {
        listener(sessionId)
      } catch { /* Observation listeners cannot block native input. */ }
    }
    return { resetEpoch: current.reset, configEpoch: current.config }
  }

  onSession(listener: (sessionId: string) => void): () => void {
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  invalidate(sessionId: string, kind: 'reset' | 'config'): { resetEpoch: string; configEpoch: string } | undefined {
    const current = this.sessions.get(sessionId)
    if (!current || this.disposed) return undefined
    current[kind] = randomUUID()
    delete current.sample
    if (kind === 'config') delete current.budgetSignature
    return { resetEpoch: current.reset, configEpoch: current.config }
  }

  observe(sample: ContextObservation): boolean {
    const current = this.sessions.get(sample.sessionId), budget = sample.budget
    if (
      this.disposed || !current || sample.sessionGeneration !== current.generation
      || sample.resetEpoch !== current.reset || sample.configEpoch !== current.config
      || !Number.isSafeInteger(sample.sequence) || sample.sequence <= current.sequence
      || !Number.isSafeInteger(sample.usedTokens) || sample.usedTokens < 0
      || !Number.isSafeInteger(sample.observedAt) || sample.observedAt > this.now()
      || !Number.isSafeInteger(sample.expiresAt)
      || sample.expiresAt <= sample.observedAt
      || budget.status === 'resolved' && (!Number.isSafeInteger(budget.tokens) || budget.tokens <= 0)
    ) return false
    if (budget.status === 'resolved') {
      const signature = JSON.stringify([budget.tokens, sample.rawModelWindowTokens, sample.usableModelWindowTokens])
      if (current.budgetSignature !== undefined && signature !== current.budgetSignature) {
        this.invalidate(sample.sessionId, 'config')
        return false
      }
      current.budgetSignature = signature
    }
    current.sequence = sample.sequence
    current.sample = structuredClone(sample)
    for (const watch of current.watches) this.evaluate(current, watch, current.sample)
    return true
  }

  read(sessionId: string): ContextObservation | undefined {
    const sample = this.sessions.get(sessionId)?.sample
    return sample && sample.observedAt <= this.now() && sample.expiresAt > this.now()
      ? structuredClone(sample)
      : undefined
  }

  status(sessionId: string): 'available' | 'stale' | 'unavailable' {
    const sample = this.sessions.get(sessionId)?.sample
    return !sample ? 'unavailable' : sample.observedAt > this.now() || sample.expiresAt <= this.now()
      ? 'stale'
      : 'available'
  }

  retire(sessionId: string): void {
    const current = this.sessions.get(sessionId)
    if (!current) return
    for (const watch of current.watches) this.close(current, watch, 'session-replaced')
    this.sessions.delete(sessionId)
  }

  unavailable(sessionId: string): void {
    const current = this.sessions.get(sessionId)
    if (!current) return
    delete current.sample
    for (const watch of current.watches) delete watch.above
  }

  watch(sessionId: string, ratio: number, observer: (event: Event) => void | Promise<void>) {
    if (this.disposed || !Number.isFinite(ratio) || ratio <= 0 || ratio > 0.95 || typeof observer !== 'function') {
      throw new Error('invalid')
    }
    const current = this.sessions.get(sessionId)
    if (!current) throw new Error('unavailable')
    let resolve!: (value: { code: CloseCode }) => void
    const closed = new Promise<{ code: CloseCode }>(done => {
      resolve = done
    })
    const watch: Watch = { ratio, observer, resolve, closed: false, pending: Promise.resolve() }
    current.watches.add(watch)
    if (current.sample) this.evaluate(current, watch, current.sample)
    return { closed, unsubscribe: async () => this.close(current, watch, 'unsubscribed') }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.sessions.values()) {
      for (const watch of session.watches) {
        this.close(session, watch, 'generation-replaced')
      }
    }
    this.sessions.clear()
    this.sessionListeners.clear()
  }

  private evaluate(session: Session, watch: Watch, sample: ContextObservation): void {
    const now = this.now(), epoch = `${sample.resetEpoch}:${sample.configEpoch}`
    if (watch.closed) return
    if (sample.observedAt > now || sample.expiresAt <= now || sample.budget.status !== 'resolved') {
      if (watch.epoch === epoch) delete watch.above
      return
    }
    const above = sample.usedTokens / sample.budget.tokens >= watch.ratio
    const newEpoch = watch.epoch !== epoch
    const stale = watch.lastExpiresAt !== undefined && watch.lastExpiresAt <= sample.observedAt
    const previous = stale ? undefined : watch.above
    watch.epoch = epoch
    watch.above = above
    watch.lastExpiresAt = sample.expiresAt
    const reason = newEpoch && above ? 'epoch-initial' : previous === false && above ? 'crossed' : undefined
    if (!reason) return
    const event: Event = { reason, sample: structuredClone(sample) }
    watch.pending = watch.pending.then(async () => {
      if (
        watch.closed || this.sessions.get(sample.sessionId) !== session
        || session.reset !== sample.resetEpoch || session.config !== sample.configEpoch
        || sample.expiresAt <= this.now()
      ) return
      try {
        await watch.observer(event)
      } catch {
        this.close(session, watch, 'observer-failed')
      }
    })
  }

  private close(session: Session, watch: Watch, code: CloseCode): void {
    if (watch.closed) return
    watch.closed = true
    session.watches.delete(watch)
    watch.resolve({ code })
  }
}
