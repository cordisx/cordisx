import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  ChannelConversationJob,
  ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'
import { effectiveLivePolicy } from './channel-live-policy.js'

export interface LiveTakeoverIntent {
  readonly operationId: string
  readonly source: string
  readonly sourceTurn: string
  readonly sourceJob: string
  readonly tokenHash: string
  readonly fence: string
  state: 'preparing' | 'ready' | 'interrupting' | 'committed' | 'abandoned' | 'unknown'
  target?: string
  targetTurn?: string
  catchup?: string
}

export interface LiveTakeoverNative {
  /** Creates a fresh, read-only preparation session with all side-effecting tools fenced. */
  prepare(
    input: { operationId: string; source: string; sourceTurn: string; token: string },
  ): Promise<{ sessionId: string; turnId: string }>
  turnState(sessionId: string, turnId: string): Promise<'active' | 'completed' | 'failed' | 'unknown'>
  /** Only returns interrupted after an exact-turn interrupt is accepted and terminal state is verified. */
  interruptExact(sessionId: string, turnId: string): Promise<'interrupted' | 'already-completed' | 'uncertain'>
  /** Reads a bounded final source-history delta after terminal confirmation. */
  catchup(sessionId: string, turnId: string): Promise<{ delta: string } | undefined>
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const sameToken = (token: string, digest: string): boolean => {
  const left = Buffer.from(hash(token), 'hex'), right = Buffer.from(digest, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Prevent a stale native readback from completing or sending an interrupted source turn. */
export function mayFinishChannelJob(state: ChannelConversationState, observed: ChannelConversationJob): boolean {
  const current = state.jobs[observed.id]
  const takeover = observed.sessionId ? state.liveTakeovers[observed.sessionId] : undefined
  return current?.state === 'running' && current.sessionId === observed.sessionId && current.turnId === observed.turnId
    && (!takeover || ['preparing', 'ready', 'abandoned'].includes(takeover.state))
}

/** Snapshot every relationship and setting whose concurrent change must fence transfer. */
function fence(state: ChannelConversationState, source: string): string {
  const bindings = Object.values(state.bindings).filter(binding => binding.sessionId === source)
    .sort((a, b) => a.id.localeCompare(b.id))
  const entry = state.continuations[source]
  return JSON.stringify({
    bindings,
    policyRevision: state.policyRevision,
    defaults: state.continuationDefaults,
    livePolicy: entry?.livePolicy,
    legacy: entry?.policy,
    checkpoint: entry?.checkpoint,
    taskSetting: state.taskSettings[source],
    taskRequests: Object.values(state.taskRequests).filter(request => request.threadId === source)
      .sort((a, b) => a.id.localeCompare(b.id)),
  })
}

/** Durable target-readiness and exact-source-turn handoff. Never retries an uncertain effect. */
export class ChannelLiveTakeover {
  constructor(private readonly store: ChannelConversationStore, private readonly native: LiveTakeoverNative) {}

  async begin(input: { source: string; sourceTurn: string; sourceJob: string }): Promise<boolean> {
    if (!id(input.source) || !id(input.sourceTurn) || !id(input.sourceJob)) return false
    const operationId = randomUUID(), token = randomBytes(32).toString('hex')
    const reserved = await this.store.mutate(state => {
      const job = state.jobs[input.sourceJob], entry = state.continuations[input.source]
      const policy = effectiveLivePolicy(state.continuationDefaults, entry)
      if (
        !policy.policy.enabled || entry?.intent || state.liveTakeovers[input.source]
        || !job || job.sessionId !== input.source || job.turnId !== input.sourceTurn || job.state !== 'running'
        || !job.bindingId || state.bindings[job.bindingId]?.state !== 'active'
        || state.bindings[job.bindingId]?.sessionId !== input.source
        || Object.values(state.jobs).some(other =>
          other.id !== job.id && other.sessionId === input.source
          && ['dispatching', 'running', 'replying', 'reconciliation-required'].includes(other.state)
        )
        || Object.values(state.taskRequests).some(request =>
          request.threadId === input.source
          && ['pending', 'queued', 'applying', 'submitted'].includes(request.state)
        )
      ) return false
      const setting = state.taskSettings[input.source]
      if (setting && (setting.application !== 'applied' || setting.pending || setting.pendingPatch)) return false
      state.liveTakeovers[input.source] = {
        operationId,
        source: input.source,
        sourceTurn: input.sourceTurn,
        sourceJob: input.sourceJob,
        tokenHash: hash(token),
        fence: fence(state, input.source),
        state: 'preparing',
      }
      return true
    })
    if (!reserved) return false
    try {
      if (await this.native.turnState(input.source, input.sourceTurn) !== 'active') {
        throw new Error('source unavailable')
      }
      const target = await this.native.prepare({
        operationId,
        source: input.source,
        sourceTurn: input.sourceTurn,
        token,
      })
      if (!id(target.sessionId) || !id(target.turnId) || target.sessionId === input.source) {
        throw new Error('target unavailable')
      }
      return await this.store.mutate(state => {
        const current = state.liveTakeovers[input.source]
        if (!current || current.operationId !== operationId || current.state !== 'preparing') return false
        if (
          fence(state, input.source) !== current.fence
          || Object.values(state.bindings).some(binding => binding.sessionId === target.sessionId)
          || Object.values(state.jobs).some(job => job.sessionId === target.sessionId)
        ) {
          current.state = 'abandoned'
          return false
        }
        current.target = target.sessionId
        current.targetTurn = target.turnId
        current.state = 'ready'
        return true
      })
    } catch {
      await this.unknown(input.source, operationId)
      return false
    }
  }

  async ready(input: { source: string; target: string; targetTurn: string; token: string }): Promise<boolean> {
    if (!id(input.source) || !id(input.target) || !id(input.targetTurn) || !id(input.token)) return false
    const snapshot = this.store.snapshot().liveTakeovers[input.source]
    if (
      !snapshot || snapshot.state !== 'ready' || snapshot.target !== input.target
      || snapshot.targetTurn !== input.targetTurn || !sameToken(input.token, snapshot.tokenHash)
    ) return false
    let armedByThisCall = false
    try {
      const sourceState = await this.native.turnState(snapshot.source, snapshot.sourceTurn)
      if (sourceState !== 'active') {
        if (sourceState === 'completed') {
          await this.native.catchup(snapshot.source, snapshot.sourceTurn).catch(() => undefined)
        }
        await this.abandon(input.source, snapshot.operationId)
        return false
      }
      if (await this.native.turnState(input.target, input.targetTurn) !== 'active') {
        await this.abandon(input.source, snapshot.operationId)
        return false
      }
      const armed = await this.store.mutate(state => {
        const current = state.liveTakeovers[input.source], job = state.jobs[snapshot.sourceJob]
        if (
          !current || current.operationId !== snapshot.operationId || current.state !== 'ready'
          || current.target !== input.target || current.targetTurn !== input.targetTurn
          || !job || job.state !== 'running' || job.sessionId !== snapshot.source || job.turnId !== snapshot.sourceTurn
          || fence(state, input.source) !== current.fence
        ) return false
        current.state = 'interrupting'
        return true
      })
      if (!armed) {
        await this.abandon(input.source, snapshot.operationId)
        return false
      }
      armedByThisCall = true
      const interrupted = await this.native.interruptExact(snapshot.source, snapshot.sourceTurn)
      if (interrupted === 'already-completed') {
        await this.native.catchup(snapshot.source, snapshot.sourceTurn).catch(() => undefined)
        await this.abandon(input.source, snapshot.operationId, true)
        return false
      }
      if (interrupted !== 'interrupted') {
        await this.unknown(input.source, snapshot.operationId)
        return false
      }
      const catchup = await this.native.catchup(snapshot.source, snapshot.sourceTurn)
      if (!catchup || typeof catchup.delta !== 'string' || catchup.delta.length > 16_000) {
        await this.unknown(input.source, snapshot.operationId)
        return false
      }
      return await this.store.mutate(state => this.commit(state, snapshot, catchup.delta))
    } catch {
      if (armedByThisCall) await this.unknown(input.source, snapshot.operationId)
      else await this.abandon(input.source, snapshot.operationId)
      return false
    }
  }

  private commit(state: ChannelConversationState, snapshot: LiveTakeoverIntent, catchup: string): boolean {
    const current = state.liveTakeovers[snapshot.source], target = snapshot.target
    const job = state.jobs[snapshot.sourceJob]
    if (
      !current || current.operationId !== snapshot.operationId || current.state !== 'interrupting' || !target
      || !job || job.state !== 'running' || job.sessionId !== snapshot.source || job.turnId !== snapshot.sourceTurn
      || fence(state, snapshot.source) !== snapshot.fence
      || state.continuations[target] || state.taskSettings[target]
      || Object.values(state.bindings).some(binding => binding.sessionId === target)
      || Object.values(state.jobs).some(other => other.sessionId === target)
    ) {
      if (current?.operationId === snapshot.operationId) current.state = 'unknown'
      return false
    }
    for (const [key, binding] of Object.entries(state.bindings)) {
      if (binding.sessionId === snapshot.source) state.bindings[key] = { ...binding, sessionId: target }
    }
    for (const queued of Object.values(state.jobs)) {
      if (queued.sessionId === snapshot.source && queued.state === 'queued') queued.sessionId = target
    }
    const entry = state.continuations[snapshot.source]
    if (entry?.policy || entry?.livePolicy) {
      state.continuations[target] = {
        ...(entry.policy ? { policy: structuredClone(entry.policy) } : {}),
        ...(entry.livePolicy ? { livePolicy: structuredClone(entry.livePolicy) } : {}),
      }
    }
    if (state.taskSettings[snapshot.source]) {
      state.taskSettings[target] = structuredClone(state.taskSettings[snapshot.source]!)
    }
    job.sessionId = target
    delete job.turnId
    job.state = 'reconciliation-required'
    job.code = 'CONTINUATION_BUSINESS_TURN_PENDING'
    current.catchup = catchup
    current.state = 'committed'
    return true
  }

  private async unknown(source: string, operationId: string): Promise<void> {
    await this.store.mutate(state => {
      const current = state.liveTakeovers[source]
      if (current?.operationId === operationId && current.state !== 'committed') {
        current.state = ['preparing', 'ready', 'abandoned'].includes(current.state) ? 'abandoned' : 'unknown'
      }
    })
  }

  private async abandon(source: string, operationId: string, alreadyCompleted = false): Promise<void> {
    await this.store.mutate(state => {
      const current = state.liveTakeovers[source]
      if (
        current?.operationId === operationId
        && (['preparing', 'ready'].includes(current.state) || alreadyCompleted && current.state === 'interrupting')
      ) {
        current.state = 'abandoned'
      }
    })
  }
}
