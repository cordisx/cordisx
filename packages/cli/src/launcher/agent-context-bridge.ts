import { randomBytes } from 'node:crypto'
import type { AgentContextSampleV1, AgentContextThresholdEventV1 } from '@cordisx/protocol/agent-context/v1'
import type { AgentContextBridge } from './agent-context-bridge-contract.js'
import { type ContextObservation, ContextObservations } from './context-observations.js'

type BridgeEvent = AgentContextThresholdEventV1
type NextResult = Awaited<ReturnType<AgentContextBridge['next']>>
interface Subscription {
  readonly sessionId: string
  readonly threshold: number
  readonly unsubscribe: () => Promise<void>
  readonly queue: BridgeEvent[]
  cursor: number
  closed?: 'unavailable' | 'generation-replaced' | 'session-replaced' | 'unsubscribed'
  pending?: (value: NextResult) => void
  timer?: ReturnType<typeof setTimeout>
}

function project(value: ContextObservation): AgentContextSampleV1 {
  const budget = value.budget.status === 'resolved'
    ? { ...value.budget, source: 'adapter-derived' as const }
    : value.budget
  return {
    contract: 'cordisx.agent-context-sample/v1',
    sessionId: value.sessionId,
    sessionGeneration: value.sessionGeneration,
    ...(value.turnId ? { turnId: value.turnId } : {}),
    usedTokens: value.usedTokens,
    measurement: { kind: 'reported-snapshot', source: 'provider', scope: 'last-request total tokens' },
    ...(value.rawModelWindowTokens === undefined ? {} : { rawModelWindowTokens: value.rawModelWindowTokens }),
    ...(value.usableModelWindowTokens === undefined ? {} : { usableModelWindowTokens: value.usableModelWindowTokens }),
    budget,
    ...(budget.status === 'resolved' ? { ratio: value.usedTokens / budget.tokens } : {}),
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    resetEpoch: value.resetEpoch,
    configEpoch: value.configEpoch,
  }
}

/** Bounded, replay-fenced event queue over one already-authenticated Host connection. */
export class HostAgentContextBridge implements AgentContextBridge {
  private readonly handles = new Map<string, Subscription>()
  private readonly closedHandles = new Map<string, NonNullable<Subscription['closed']>>()
  private disposed = false
  constructor(
    private readonly observations: ContextObservations,
    private readonly waitMs = 4_000,
    private readonly now: () => number = Date.now,
  ) {}

  async read(input: { sessionId: string }): ReturnType<AgentContextBridge['read']> {
    if (this.disposed) return { status: 'unavailable', code: 'generation-replaced' }
    if (typeof input.sessionId !== 'string' || !input.sessionId) {
      return { status: 'unavailable', code: 'invalid-request' }
    }
    const sample = this.observations.read(input.sessionId)
    if (sample) return { status: 'available', sample: project(sample) }
    return {
      status: 'unavailable',
      code: this.observations.status(input.sessionId) === 'stale' ? 'stale' : 'unavailable',
    }
  }

  async open(input: { sessionId: string; thresholdRatio: number }): ReturnType<AgentContextBridge['open']> {
    if (this.disposed) return { status: 'unavailable', code: 'generation-replaced' }
    if (
      typeof input.sessionId !== 'string' || !input.sessionId || !Number.isFinite(input.thresholdRatio)
      || input.thresholdRatio <= 0 || input.thresholdRatio > 0.95
    ) {
      return { status: 'unavailable', code: 'invalid-request' }
    }
    if (this.handles.size >= 256) return { status: 'unavailable', code: 'unavailable' }
    const handle = randomBytes(24).toString('hex')
    let entry!: Subscription
    try {
      const watch = this.observations.watch(input.sessionId, input.thresholdRatio, event => {
        if (entry.closed) return
        if (entry.queue.length >= 64) return this.finish(handle, 'unavailable')
        entry.queue.push({
          contract: 'cordisx.agent-context-threshold/v1',
          thresholdRatio: entry.threshold,
          reason: event.reason,
          sample: project(event.sample),
        })
        this.flush(entry)
      })
      entry = {
        sessionId: input.sessionId,
        threshold: input.thresholdRatio,
        unsubscribe: watch.unsubscribe,
        queue: [],
        cursor: 0,
      }
      this.handles.set(handle, entry)
      void watch.closed.then(result =>
        this.finish(handle, result.code === 'observer-failed' ? 'unavailable' : result.code)
      )
      return { status: 'open', handle, cursor: 0 }
    } catch {
      return { status: 'unavailable', code: 'unavailable' }
    }
  }

  async next(input: { handle: string; cursor: number }): ReturnType<AgentContextBridge['next']> {
    const entry = this.handles.get(input.handle)
    if (!entry) {
      const code = this.closedHandles.get(input.handle) ?? (this.disposed ? 'generation-replaced' : 'unavailable')
      this.closedHandles.delete(input.handle)
      return { status: 'closed', code }
    }
    if (!Number.isSafeInteger(input.cursor) || input.cursor !== entry.cursor || entry.pending) {
      this.finish(input.handle, 'unavailable')
      return { status: 'closed', code: 'unavailable' }
    }
    if (entry.closed) return { status: 'closed', code: entry.closed }
    return await new Promise<NextResult>(resolve => {
      entry.pending = resolve
      entry.timer = setTimeout(() => this.flush(entry, true), this.waitMs)
      this.flush(entry)
    })
  }

  async close(input: { handle: string }): Promise<void> {
    this.finish(input.handle, 'unsubscribed')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.handles.keys()) this.finish(handle, 'generation-replaced')
  }

  private flush(entry: Subscription, timedOut = false): void {
    const latest = this.observations.read(entry.sessionId)
    if (!latest || latest.budget.status !== 'resolved') entry.queue.length = 0
    else {
      const eligible = entry.queue.filter(event =>
        event.sample.resetEpoch === latest.resetEpoch
        && event.sample.configEpoch === latest.configEpoch && event.sample.expiresAt > this.now()
      )
      entry.queue.splice(0, entry.queue.length, ...eligible)
    }
    if (!entry.pending || !entry.closed && !entry.queue.length && !timedOut) return
    const resolve = entry.pending
    delete entry.pending
    if (entry.timer) clearTimeout(entry.timer)
    delete entry.timer
    if (entry.closed) return resolve({ status: 'closed', code: entry.closed })
    const events = entry.queue.splice(0)
    entry.cursor += events.length
    resolve({ status: 'events', events, cursor: entry.cursor })
  }

  private finish(handle: string, code: Subscription['closed']): void {
    const entry = this.handles.get(handle)
    if (!entry || entry.closed || !code) return
    entry.closed = code
    void entry.unsubscribe()
    this.flush(entry)
    this.handles.delete(handle)
    this.closedHandles.set(handle, code)
    if (this.closedHandles.size > 256) this.closedHandles.delete(this.closedHandles.keys().next().value!)
  }
}
