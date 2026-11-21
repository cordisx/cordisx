import { isDeepStrictEqual } from 'node:util'
import type {
  ConversationContinuationRelationV1,
  ConversationContinuationRequestV1,
} from '@cordisx/protocol/conversation-continuation/v1'
import type { ContinuationConfiguration } from './channel-continuation-config.js'
import type { LogicalHistoryCategory } from './logical-continuation-history.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'

export type LogicalContinuationRequest = ConversationContinuationRequestV1
/** The owning Host constructs this from a verified user action or authenticated Channel dispatch. */
export interface LogicalContinuationActor {
  readonly principal: string
  readonly scope: string
}
export interface LogicalContinuationEvidence {
  readonly sourceConfiguration: ContinuationConfiguration
  readonly sourceHistoryVersion: string
  readonly handoff: 'checkpoint' | 'unavailable' | 'none'
  /** Digest of the exact approved checkpoint; no checkpoint text is stored here. */
  readonly handoffDigest?: string
}
export interface LogicalContinuationIntent {
  readonly request: LogicalContinuationRequest
  readonly actor: LogicalContinuationActor
  readonly evidence: LogicalContinuationEvidence
  state: 'creating' | 'unknown' | 'rejected' | 'applied'
  destination?: LogicalSessionRef
  code?: string
}
export type LogicalContinuationRelation = ConversationContinuationRelationV1
export interface LogicalContinuationState {
  revision: number
  intents: Record<string, LogicalContinuationIntent>
  relations: Record<string, LogicalContinuationRelation>
}
/** Call during store recovery before any dispatch; an interrupted effect is never replayed. */
export function recoverLogicalContinuations(state: LogicalContinuationState): void {
  for (const intent of Object.values(state.intents)) {
    if (intent.state === 'creating') {
      intent.state = 'unknown'
      intent.code = 'NATIVE_EFFECT_UNCERTAIN'
    }
  }
}
export interface LogicalTransactionStore<State> {
  snapshot(): State
  /** Transactions operate on a draft and discard all writes if the callback throws. */
  mutate<T>(update: (state: State) => T): Promise<T>
}
export interface LogicalContinuationAdapter<State> {
  state(root: State): LogicalContinuationState
  /** Synchronous scope and policy check against this same transaction snapshot. */
  admitted(root: State, actor: LogicalContinuationActor, request: LogicalContinuationRequest): boolean
  /** Mutate only this transaction's authorized binding(s); false aborts the whole transaction. */
  bind(
    root: State,
    actor: LogicalContinuationActor,
    request: LogicalContinuationRequest,
    destination: LogicalSessionRef,
  ): boolean
  /** Checks active work, source security/history, exact target and current authorization. */
  preflight(
    actor: LogicalContinuationActor,
    request: LogicalContinuationRequest,
  ): Promise<LogicalContinuationEvidence | undefined>
  /** Must not send a business turn; explicit rejection means no native creation occurred. */
  create(request: LogicalContinuationRequest, evidence: LogicalContinuationEvidence): Promise<
    | { readonly state: 'created'; readonly destination: LogicalSessionRef }
    | { readonly state: 'rejected'; readonly code: string }
  >
  /** Read-only confirmation of exact destination identity, selected target, ancestry and security settings. */
  confirm(
    request: LogicalContinuationRequest,
    evidence: LogicalContinuationEvidence,
    destination: LogicalSessionRef,
  ): Promise<boolean>
}
type Result =
  | { readonly state: 'applied'; readonly operationId: string; readonly destination: LogicalSessionRef }
  | { readonly state: 'rejected'; readonly operationId: string; readonly code: string }
  | { readonly state: 'unknown'; readonly operationId: string; readonly destination?: LogicalSessionRef }
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const validSession = (value: LogicalSessionRef) =>
  value && [value.hostId, value.appId, value.profileId, value.sessionId].every(field => text(field))
const validDestination = (source: LogicalSessionRef, destination: LogicalSessionRef) =>
  validSession(destination) && !isDeepStrictEqual(destination, source)
  && destination.hostId === source.hostId && destination.appId === source.appId
  && destination.profileId === source.profileId
const categorySet: readonly LogicalHistoryCategory[] = ['user-text', 'assistant-text', 'plan', 'command', 'tool']
const exact = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
function validRequest(request: LogicalContinuationRequest): boolean {
  if (
    !request || request.contract !== 'cordisx.conversation-continuation-request/v1'
    || !text(request.operationId, 128) || !text(request.logicalConversationId) || !validSession(request.source)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || !text(request.target?.providerId, 128) || !text(request.target?.model)
    || !exact(request.source, ['hostId', 'appId', 'profileId', 'sessionId'])
    || !exact(request.target, ['providerId', 'model'])
  ) return false
  const common = [
    'contract',
    'operationId',
    'logicalConversationId',
    'source',
    'expectedRevision',
    'target',
    'mode',
    'historyConsent',
  ]
  if (request.mode === 'linked') {
    return request.historyConsent === 'on-demand'
      && exact(request, [...common, 'handoffConsent', 'historyCategories'])
      && ['checkpoint', 'none'].includes(request.handoffConsent) && Array.isArray(request.historyCategories)
      && request.historyCategories.length > 0 && request.historyCategories.every(category =>
        categorySet.includes(category)
      )
      && new Set(request.historyCategories).size === request.historyCategories.length
  }
  return exact(request, common) && (request.mode === 'fork' && request.historyConsent === 'inherit'
    || request.mode === 'fresh' && request.historyConsent === 'none')
}
function relation(
  request: LogicalContinuationRequest,
  evidence: LogicalContinuationEvidence,
  destination: LogicalSessionRef,
): LogicalContinuationRelation {
  const common = {
    contract: 'cordisx.conversation-continuation-relation/v1' as const,
    operationId: request.operationId,
    logicalConversationId: request.logicalConversationId,
    revision: request.expectedRevision + 1,
    source: structuredClone(request.source),
    destination: structuredClone(destination),
    target: structuredClone(request.target),
  }
  if (request.mode === 'linked') {
    return {
      ...common,
      mode: 'linked',
      historyAccess: 'on-demand',
      handoff: evidence.handoff,
      historyCategories: structuredClone(request.historyCategories),
    }
  }
  if (request.mode === 'fork') return { ...common, mode: 'fork', historyAccess: 'inherited', handoff: 'none' }
  return { ...common, mode: 'fresh', historyAccess: 'none', handoff: 'none' }
}

/** Native creation is never replayed after an unknown effect. Store and binding commit are one transaction. */
export class LogicalContinuationControl<State> {
  private readonly claims = new Set<string>()
  constructor(
    private readonly store: LogicalTransactionStore<State>,
    private readonly adapter: LogicalContinuationAdapter<State>,
  ) {}
  async start(actor: LogicalContinuationActor, request: LogicalContinuationRequest): Promise<Result> {
    const operationId = request?.operationId ?? ''
    if (
      !actor || !text(actor.principal) || !text(actor.scope) || !exact(actor, ['principal', 'scope'])
      || !validRequest(request)
    ) {
      return { state: 'rejected', operationId, code: 'INVALID_REQUEST' }
    }
    const prior = this.adapter.state(this.store.snapshot()).intents[operationId]
    if (prior) {
      if (!isDeepStrictEqual(prior.request, request) || !isDeepStrictEqual(prior.actor, actor)) {
        return { state: 'rejected', operationId, code: 'OPERATION_ID_CONFLICT' }
      }
      if (prior.state === 'applied' && prior.destination) {
        return { state: 'applied', operationId, destination: prior.destination }
      }
      if (prior.state === 'rejected') return { state: 'rejected', operationId, code: prior.code ?? 'NATIVE_REJECTED' }
      return { state: 'unknown', operationId, ...(prior.destination ? { destination: prior.destination } : {}) }
    }
    const key = JSON.stringify(request.source)
    if (this.claims.has(key)) return { state: 'rejected', operationId, code: 'SESSION_BUSY' }
    this.claims.add(key)
    let reserved = false, effectStarted = false, destination: LogicalSessionRef | undefined
    try {
      const evidence = await this.adapter.preflight(actor, request)
      if (
        !evidence || !text(evidence.sourceHistoryVersion)
        || evidence.handoff === 'checkpoint'
          && (typeof evidence.handoffDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.handoffDigest))
        || evidence.handoff !== 'checkpoint' && evidence.handoffDigest !== undefined
        || request.mode !== 'linked' && evidence.handoff !== 'none'
        || request.mode === 'linked' && request.handoffConsent === 'none' && evidence.handoff !== 'none'
        || request.mode === 'linked' && request.handoffConsent === 'checkpoint'
          && !['checkpoint', 'unavailable'].includes(evidence.handoff)
      ) {
        return { state: 'rejected', operationId, code: 'PREFLIGHT_UNAVAILABLE' }
      }
      const stored = await this.store.mutate(root => {
        const state = this.adapter.state(root)
        if (
          state.revision !== request.expectedRevision || state.intents[operationId] || state.relations[operationId]
          || Object.values(state.intents).some(intent =>
            isDeepStrictEqual(intent.request.source, request.source)
            && ['creating', 'unknown'].includes(intent.state)
          ) || !this.adapter.admitted(root, actor, request)
        ) return false
        state.intents[operationId] = {
          request: structuredClone(request),
          actor: structuredClone(actor),
          evidence: structuredClone(evidence),
          state: 'creating',
        }
        return true
      })
      if (!stored) return { state: 'rejected', operationId, code: 'SOURCE_CHANGED_OR_BUSY' }
      reserved = true
      const before = await this.adapter.preflight(actor, request)
      const currentRoot = this.store.snapshot()
      const currentIntent = this.adapter.state(currentRoot).intents[operationId]
      if (
        !isDeepStrictEqual(before, evidence) || !currentIntent || currentIntent.state !== 'creating'
        || !this.adapter.admitted(currentRoot, actor, request)
      ) {
        await this.finishUnmoved(operationId, 'rejected', 'PREFLIGHT_CHANGED')
        return { state: 'rejected', operationId, code: 'PREFLIGHT_CHANGED' }
      }
      effectStarted = true
      const created = await this.adapter.create(request, evidence)
      if (created.state === 'rejected') {
        await this.finishUnmoved(operationId, 'rejected', created.code)
        return { state: 'rejected', operationId, code: created.code }
      }
      destination = created.destination
      if (
        !validDestination(request.source, destination)
        || !await this.adapter.confirm(request, evidence, destination)
        || !isDeepStrictEqual(await this.adapter.preflight(actor, request), evidence)
      ) {
        await this.finishUnmoved(operationId, 'unknown', 'NATIVE_READBACK_UNCONFIRMED', destination)
        return { state: 'unknown', operationId, ...(validSession(destination) ? { destination } : {}) }
      }
      const applied = await this.store.mutate(root => {
        const state = this.adapter.state(root), current = state.intents[operationId]
        if (
          !current || current.state !== 'creating' || state.revision !== request.expectedRevision
          || state.relations[operationId]
          || !isDeepStrictEqual(current.request, request) || !isDeepStrictEqual(current.actor, actor)
          || !isDeepStrictEqual(current.evidence, evidence) || !this.adapter.admitted(root, actor, request)
        ) return false
        if (!this.adapter.bind(root, actor, request, destination!)) throw new Error('BINDING_COMMIT_REJECTED')
        state.revision += 1
        state.relations[operationId] = relation(request, evidence, destination!)
        current.state = 'applied'
        current.destination = structuredClone(destination!)
        return true
      })
      if (applied) return { state: 'applied', operationId, destination }
      await this.finishUnmoved(operationId, 'unknown', 'SOURCE_CHANGED', destination)
      return { state: 'unknown', operationId, destination }
    } catch {
      if (!reserved) return { state: 'rejected', operationId, code: 'PREFLIGHT_UNAVAILABLE' }
      if (!effectStarted) {
        await this.finishUnmoved(operationId, 'rejected', 'PREFLIGHT_UNAVAILABLE').catch(() => {})
        return { state: 'rejected', operationId, code: 'PREFLIGHT_UNAVAILABLE' }
      }
      await this.finishUnmoved(operationId, 'unknown', 'NATIVE_EFFECT_UNCERTAIN', destination).catch(() => {})
      return { state: 'unknown', operationId, ...(destination && validSession(destination) ? { destination } : {}) }
    } finally {
      this.claims.delete(key)
    }
  }
  /** Inspect a known native destination; this never reissues a create or business turn. */
  async reconcile(actor: LogicalContinuationActor, operationId: string): Promise<Result> {
    if (
      !actor || !text(actor.principal) || !text(actor.scope) || !exact(actor, ['principal', 'scope'])
      || !text(operationId, 128)
    ) {
      return { state: 'rejected', operationId, code: 'INVALID_REQUEST' }
    }
    const intent = this.adapter.state(this.store.snapshot()).intents[operationId]
    if (!intent || !isDeepStrictEqual(intent.actor, actor)) {
      return { state: 'rejected', operationId, code: 'OPERATION_NOT_FOUND' }
    }
    if (intent.state === 'applied' && intent.destination) {
      return { state: 'applied', operationId, destination: intent.destination }
    }
    if (intent.state === 'rejected') return { state: 'rejected', operationId, code: intent.code ?? 'NATIVE_REJECTED' }
    if (
      intent.state !== 'unknown' || !intent.destination || !validDestination(intent.request.source, intent.destination)
    ) {
      return { state: 'unknown', operationId }
    }
    const { request, evidence, destination } = intent
    const key = JSON.stringify(request.source)
    if (this.claims.has(key)) return { state: 'unknown', operationId, destination }
    this.claims.add(key)
    try {
      if (
        !isDeepStrictEqual(await this.adapter.preflight(actor, request), evidence)
        || !await this.adapter.confirm(request, evidence, destination)
        || !isDeepStrictEqual(await this.adapter.preflight(actor, request), evidence)
      ) return { state: 'unknown', operationId, destination }
      const applied = await this.store.mutate(root => {
        const state = this.adapter.state(root), current = state.intents[operationId]
        if (
          !current || !isDeepStrictEqual(current, intent) || state.revision !== request.expectedRevision
          || state.relations[operationId]
          || !this.adapter.admitted(root, actor, request)
        ) return false
        if (!this.adapter.bind(root, actor, request, destination)) throw new Error('BINDING_COMMIT_REJECTED')
        state.revision += 1
        state.relations[operationId] = relation(request, evidence, destination)
        current.state = 'applied'
        delete current.code
        return true
      })
      return applied ? { state: 'applied', operationId, destination } : { state: 'unknown', operationId, destination }
    } catch {
      return { state: 'unknown', operationId, destination }
    } finally {
      this.claims.delete(key)
    }
  }
  private async finishUnmoved(
    id: string,
    status: 'unknown' | 'rejected',
    code: string,
    destination?: LogicalSessionRef,
  ) {
    await this.store.mutate(root => {
      const current = this.adapter.state(root).intents[id]
      if (!current || current.state !== 'creating') return
      current.state = status
      current.code = code
      if (destination && validSession(destination)) current.destination = structuredClone(destination)
    })
  }
}
