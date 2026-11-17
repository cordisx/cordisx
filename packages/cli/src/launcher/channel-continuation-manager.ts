import { randomUUID } from 'node:crypto'
import {
  continuationBrief,
  type ContinuationCheckpoint,
  continuationCheckpoint,
  type ContinuationPolicy,
  continuationPolicy,
} from './channel-continuation.js'
import type {
  ChannelConversationState,
  ChannelConversationStore,
  ChannelTaskSetting,
} from './channel-conversation-store.js'
import type { ContinuationConfiguration } from './channel-continuation-config.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { channelMessageContext } from './channel-message-context.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { continuationDefaultsOperation } from './channel-continuation-defaults.js'

export interface ContinuationReservation {
  readonly operationId: string
  readonly source: string
  readonly checkpoint: ContinuationCheckpoint
  readonly configuration: ContinuationConfiguration
  readonly policyRevision: number
  readonly taskSetting?: ChannelTaskSetting
}

/** All durable mutation happens in the existing serialized Channel store. */
export class ChannelContinuationManager {
  private idleOffset = 0
  constructor(
    private readonly store: ChannelConversationStore,
    private readonly native: () => ChannelNativeSessions | undefined,
    private readonly sessionClaims = new Set<string>(),
  ) {}

  defaultsOperation(operation: string, args: Record<string, unknown>) {
    return continuationDefaultsOperation(this.store, operation, args)
  }

  async turnActive(threadId: string, turnId: string) {
    return await this.native()?.continuationTurnActive(threadId, turnId) === true
  }

  async startManual(threadId: string) {
    if (this.sessionClaims.has(threadId)) return { status: 'unavailable', code: 'SESSION_BUSY' }
    this.sessionClaims.add(threadId)
    let reservation: ContinuationReservation | undefined
    try {
      const native = this.native()
      if (!native) return { status: 'unavailable', code: 'NATIVE_BACKEND_UNAVAILABLE' }
      const state = this.store.snapshot()
      const prior = Object.values(state.jobs).filter(job =>
        job.sessionId === threadId && job.state === 'completed'
        && job.bindingId && state.bindings[job.bindingId]?.state === 'active' && state.inputs[job.recordId]
      )
        .sort((a, b) => state.inputs[b.recordId]!.sequence - state.inputs[a.recordId]!.sequence)[0]
      if (!prior) return { status: 'unavailable', code: 'CONTINUATION_CONTEXT_UNAVAILABLE' }
      reservation = await this.reserve(threadId, 'manual')
      if (!reservation) return { status: 'unavailable', code: 'CONTINUATION_NOT_READY' }
      const result = await native.startContinuation(
        reservation.operationId,
        this.brief(reservation),
        reservation.configuration,
        state.inputs[prior.recordId]!.input.source.event,
      )
      const sourceCurrent = result.state === 'running' && await this.sourceCurrent(reservation)
      return await this.store.mutate(state => {
        if (
          sourceCurrent && result.state === 'running' && result.sessionId && result.turnId
          && this.finish(state, reservation!, result.sessionId)
        ) {
          return { status: 'ok', sessionId: result.sessionId, turnId: result.turnId }
        }
        this.uncertain(state, reservation!, result)
        return {
          status: 'reconciliation-required',
          code: 'CONTINUATION_EFFECT_UNCERTAIN',
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.turnId ? { turnId: result.turnId } : {}),
        }
      })
    } catch (error) {
      if (reservation) await this.store.mutate(state => this.uncertain(state, reservation!))
      throw error
    } finally {
      this.sessionClaims.delete(threadId)
    }
  }

  /** Continue an opted-in task after its last Channel turn, even without another input. */
  async pumpIdle(signal: AbortSignal): Promise<void> {
    const snapshot = this.store.snapshot()
    if (!snapshot.policy.enabled || signal.aborted) return
    const candidates = Object.entries(snapshot.continuations)
      .filter(([, entry]) => entry.policy?.enabled && entry.checkpoint?.continueAtIdle && !entry.intent)
      .map(([source]) => source)
    const offset = candidates.length ? this.idleOffset % candidates.length : 0
    const sources = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, 8)
    this.idleOffset = offset + sources.length
    for (const source of sources) {
      if (signal.aborted || this.sessionClaims.has(source)) continue
      const state = this.store.snapshot()
      if (Object.values(state.jobs).some(job => job.sessionId === source && job.state === 'queued')) continue
      const prior = Object.values(state.jobs).filter(job =>
        job.sessionId === source && job.state === 'completed'
        && job.bindingId && state.bindings[job.bindingId]?.state === 'active' && state.inputs[job.recordId]
      )
        .sort((a, b) => state.inputs[b.recordId]!.sequence - state.inputs[a.recordId]!.sequence)[0]
      const record = prior && state.inputs[prior.recordId]
      if (!prior || !record || !channelPolicyAllows(state.policy, 'dispatch', record.input.source.event)) continue
      this.sessionClaims.add(source)
      let reservation: ContinuationReservation | undefined
      const jobId = `continuation:${randomUUID()}`
      try {
        const native = this.native()
        if (!native) continue
        reservation = await this.reserve(source, 'auto')
        if (!reservation) continue
        await this.store.mutate(current => {
          current.jobs[jobId] = {
            id: jobId,
            recordId: prior.recordId,
            bindingId: prior.bindingId!,
            autoCreate: false,
            sessionId: source,
            state: 'dispatching',
            finalDeliveryEnabled: false,
            replyDefaults: { mode: 'none', fallbackMode: 'none' },
          }
        })
        const message = {
          ...record.input,
          content: [{
            type: 'text' as const,
            text: 'Continue the checkpointed task. No new Channel message was received for this handoff.',
          }] as const,
        }
        const result = await native.start(
          jobId,
          message,
          undefined,
          signal,
          { enabled: false, mode: 'none', fallbackMode: 'none' },
          channelMessageContext(message, record.addressing),
          undefined,
          undefined,
          {
            operationId: reservation.operationId,
            brief: this.brief(reservation),
            configuration: reservation.configuration,
          },
        )
        const sourceCurrent = result.state === 'running' && await this.sourceCurrent(reservation)
        await this.store.mutate(current => {
          if (
            !this.finishDispatch(
              current,
              reservation!,
              jobId,
              sourceCurrent ? result : { ...result, state: 'reconciliation-required' },
            )
          ) return
          const job = current.jobs[jobId]!
          job.state = 'running'
          job.turnId = result.turnId!
        })
      } catch (error) {
        if (reservation) await this.store.mutate(current => this.failDispatch(current, reservation!, jobId))
        throw error
      } finally {
        this.sessionClaims.delete(source)
      }
    }
  }

  read(threadId: string) {
    const state = this.store.snapshot()
    if (!Object.values(state.bindings).some(binding => binding.sessionId === threadId)) {
      throw new Error('CHANNEL_TARGET_NOT_BOUND')
    }
    return state.continuations[threadId] ?? {}
  }

  async history(threadId: string, options: { readonly limit?: number; readonly cursor?: unknown }) {
    const state = this.store.snapshot()
    if (!Object.values(state.bindings).some(binding => binding.sessionId === threadId && binding.state === 'active')) {
      throw new Error('CHANNEL_TARGET_NOT_BOUND')
    }
    const matches = Object.entries(state.continuations).filter(([, entry]) =>
      entry.intent?.state === 'completed' && entry.intent.targetThreadId === threadId
    )
    const native = this.native()
    if (matches.length !== 1 || !native) throw new Error('CONTINUATION_HISTORY_UNAVAILABLE')
    const source = matches[0]![0]
    return { source, ...await native.continuationHistory(source, options) }
  }

  async setCheckpoint(threadId: string, value: unknown, expectedRevision: number) {
    return await this.store.mutate(state => {
      if (
        !Object.values(state.bindings).some(binding => binding.sessionId === threadId && binding.state === 'active')
      ) {
        throw new Error('CHANNEL_TARGET_NOT_BOUND')
      }
      const entry = state.continuations[threadId] ??= {}
      if ((entry.checkpoint?.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT')
      if (entry.intent) throw new Error('CONTINUATION_ALREADY_RESERVED')
      const checkpoint = continuationCheckpoint(value, threadId, expectedRevision + 1)
      entry.checkpoint = checkpoint
      return checkpoint
    })
  }

  async setPolicy(threadId: string, value: unknown): Promise<ContinuationPolicy> {
    const policy = continuationPolicy(value)
    return await this.store.mutate(state => {
      if (
        !Object.values(state.bindings).some(binding => binding.sessionId === threadId && binding.state === 'active')
      ) {
        throw new Error('CHANNEL_TARGET_NOT_BOUND')
      }
      const entry = state.continuations[threadId] ??= {}
      if (entry.intent) throw new Error('CONTINUATION_ALREADY_RESERVED')
      entry.policy = policy
      return policy
    })
  }

  /** Unknown outcomes remain reserved across restarts and are never automatically retried. */
  async reserve(
    source: string,
    mode: 'auto' | 'manual',
    operationId: string = randomUUID(),
  ): Promise<ContinuationReservation | undefined> {
    const native = this.native(), entry = this.store.snapshot().continuations[source]
    if (!native || !entry?.checkpoint || entry.intent) return undefined
    if (mode === 'auto' && (!entry.policy || !native.continuationEligible(source, entry.policy))) return undefined
    const configuration = await native.continuationConfiguration(source)
    if (!configuration) return undefined
    if (
      !await native.idle(source)
      || mode === 'auto' && (!entry.policy || !native.continuationEligible(source, entry.policy))
    ) {
      return undefined
    }
    const revision = entry.checkpoint.revision
    return await this.store.mutate(state => {
      const current = state.continuations[source]
      if (!current?.checkpoint || current.checkpoint.revision !== revision || current.intent) return undefined
      if (mode === 'auto' && JSON.stringify(current.policy) !== JSON.stringify(entry.policy)) return undefined
      if (!Object.values(state.bindings).some(binding => binding.sessionId === source && binding.state === 'active')) {
        return undefined
      }
      if (
        Object.values(state.jobs).some(job =>
          job.sessionId === source
          && ['dispatching', 'running', 'replying', 'reconciliation-required'].includes(job.state)
        )
      ) return undefined
      if (
        Object.values(state.taskRequests).some(request =>
          request.threadId === source
          && ['pending', 'queued', 'applying', 'submitted'].includes(request.state)
        )
      ) return undefined
      const taskSetting = state.taskSettings[source]
      if (taskSetting && (taskSetting.application !== 'applied' || taskSetting.pending || taskSetting.pendingPatch)) {
        return undefined
      }
      current.intent = { operationId, checkpointRevision: revision, state: 'dispatching' }
      return {
        operationId,
        source,
        checkpoint: current.checkpoint,
        configuration,
        policyRevision: state.policyRevision,
        ...(taskSetting ? { taskSetting: structuredClone(taskSetting) } : {}),
      }
    })
  }

  brief(reservation: ContinuationReservation): string {
    return continuationBrief(reservation.checkpoint)
  }

  async sourceCurrent(reservation: ContinuationReservation): Promise<boolean> {
    const current = await this.native()?.continuationConfiguration(reservation.source)
    return current !== undefined && JSON.stringify(current) === JSON.stringify(reservation.configuration)
  }

  /** Move every relationship and undispatched job in the same durable commit. */
  finish(state: ChannelConversationState, reservation: ContinuationReservation, target: string): boolean {
    const entry = state.continuations[reservation.source]
    if (
      !entry?.intent || entry.intent.operationId !== reservation.operationId || entry.intent.state !== 'dispatching'
      || entry.checkpoint?.revision !== reservation.checkpoint.revision || target === reservation.source
      || state.continuations[target] || Object.values(state.bindings).some(binding => binding.sessionId === target)
      || state.taskSettings[target]
      || state.policyRevision !== reservation.policyRevision
      || !Object.values(state.bindings).some(binding =>
        binding.sessionId === reservation.source && binding.state === 'active'
      )
      || JSON.stringify(state.taskSettings[reservation.source]) !== JSON.stringify(reservation.taskSetting)
      || Object.values(state.taskRequests).some(request =>
        request.threadId === reservation.source
        && ['pending', 'queued', 'applying', 'submitted'].includes(request.state)
      )
    ) return false
    for (const [id, binding] of Object.entries(state.bindings)) {
      if (binding.sessionId === reservation.source) state.bindings[id] = { ...binding, sessionId: target }
    }
    for (const job of Object.values(state.jobs)) {
      if (job.sessionId === reservation.source && job.state === 'queued') job.sessionId = target
    }
    if (entry.policy) state.continuations[target] = { policy: entry.policy }
    const sourceSettings = state.taskSettings[reservation.source]
    if (sourceSettings) {
      state.taskSettings[target] = structuredClone(sourceSettings)
    }
    entry.intent = { ...entry.intent, state: 'completed', targetThreadId: target }
    return true
  }

  uncertain(
    state: ChannelConversationState,
    reservation: ContinuationReservation,
    result?: { readonly sessionId?: string; readonly turnId?: string },
  ): void {
    const intent = state.continuations[reservation.source]?.intent
    if (intent?.operationId === reservation.operationId && intent.state === 'dispatching') {
      intent.state = 'unknown'
      if (result?.sessionId) intent.targetThreadId = result.sessionId
      if (result?.turnId) intent.targetTurnId = result.turnId
    }
  }

  finishDispatch(
    state: ChannelConversationState,
    reservation: ContinuationReservation,
    jobId: string,
    result: { readonly state: string; readonly sessionId?: string; readonly turnId?: string },
  ): boolean {
    const current = state.jobs[jobId]
    if (!current) return false
    if (
      result.state === 'running' && result.sessionId && result.turnId
      && this.finish(state, reservation, result.sessionId)
    ) {
      current.sessionId = result.sessionId
      return true
    }
    this.failDispatch(state, reservation, jobId)
    const intent = state.continuations[reservation.source]?.intent
    if (intent?.operationId === reservation.operationId) {
      if (result.sessionId) intent.targetThreadId = result.sessionId
      if (result.turnId) intent.targetTurnId = result.turnId
    }
    if (result.sessionId) current.sessionId = result.sessionId
    if (result.turnId) current.turnId = result.turnId
    return false
  }

  failDispatch(state: ChannelConversationState, reservation: ContinuationReservation, jobId: string): void {
    this.uncertain(state, reservation)
    const current = state.jobs[jobId]
    if (current) {
      current.state = 'reconciliation-required'
      current.code = 'CONTINUATION_EFFECT_UNCERTAIN'
    }
  }
}
