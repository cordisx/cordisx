import { isDeepStrictEqual } from 'node:util'
import { parseChatExecutionSettings } from '../chat-execution-settings.js'
import type {
  ConversationContinuationPreferenceV1,
  ConversationContinuationRelationV1,
  ConversationContinuationRequestV1,
} from '@cordisx/protocol/conversation-continuation/v1'
import type { ContinuationConfiguration } from './channel-continuation-config.js'
import type { LogicalHistoryCategory } from './logical-continuation-history.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'
import { isModelReasoningEffort, type ModelReasoningEffort } from '../model-reasoning-capabilities.js'

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
  /** Explicit target effort; the separately recorded source configuration is unchanged. */
  readonly targetReasoningEffort?: ModelReasoningEffort
}
export interface LogicalContinuationIntent {
  readonly request: LogicalContinuationRequest
  readonly actor: LogicalContinuationActor
  readonly evidence: LogicalContinuationEvidence
  /** Separately authenticated participant in a jointly approved linked migration. */
  channelHistoryActor?: LogicalContinuationActor
  state: 'creating' | 'unknown' | 'rejected' | 'applied'
  destination?: LogicalSessionRef
  code?: string
  handoffJobId?: string
  /** Native acknowledgement of the reserved first turn, persisted with the job receipt. */
  handoffTurnId?: string
  orphanDestination?: LogicalSessionRef
}
export type LogicalContinuationRelation = ConversationContinuationRelationV1
export interface LogicalContinuationState {
  revision: number
  intents: Record<string, LogicalContinuationIntent>
  relations: Record<string, LogicalContinuationRelation>
  preferences?: Record<string, ConversationContinuationPreferenceV1>
  preferenceRevisions?: Record<string, number>
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
const exact = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const operationKey = (value: unknown): value is string => text(value, 128) && !Object.hasOwn(Object.prototype, value)
const validSession = (value: LogicalSessionRef) =>
  value && typeof value === 'object' && !Array.isArray(value)
  && exact(value, ['hostId', 'appId', 'profileId', 'sessionId'])
  && [value.hostId, value.appId, value.profileId, value.sessionId].every(field => text(field))
const validDestination = (source: LogicalSessionRef, destination: LogicalSessionRef) =>
  validSession(destination) && !isDeepStrictEqual(destination, source)
  && destination.hostId === source.hostId && destination.appId === source.appId
  && destination.profileId === source.profileId
const categorySet: readonly LogicalHistoryCategory[] = ['user-text', 'assistant-text', 'plan', 'command', 'tool']
function validRequest(request: LogicalContinuationRequest): boolean {
  if (
    !request || request.contract !== 'cordisx.conversation-continuation-request/v1'
    || !operationKey(request.operationId) || !text(request.logicalConversationId) || !validSession(request.source)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || request.expectedRevision >= Number.MAX_SAFE_INTEGER
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
function validEvidence(request: LogicalContinuationRequest, evidence: LogicalContinuationEvidence): boolean {
  const config = evidence?.sourceConfiguration
  if (
    !evidence || typeof evidence !== 'object' || !exact(evidence, [
      'sourceConfiguration',
      'sourceHistoryVersion',
      'handoff',
      'handoffDigest',
      'targetReasoningEffort',
    ]) || !text(evidence.sourceHistoryVersion) || !evidence.sourceConfiguration
    || evidence.targetReasoningEffort !== undefined && !isModelReasoningEffort(evidence.targetReasoningEffort)
    || !record(config) || !exact(config, [
      'providerId',
      'model',
      'cwd',
      'execution',
      'serviceTier',
      'permissions',
      'approvalsReviewer',
      'sandbox',
      'permissionProfile',
    ])
    || !text(config.providerId, 128) || !text(config.model)
    || !text(config.cwd, 4096) || !config.cwd.startsWith('/')
    || ![null, 'default', 'priority'].includes(config.serviceTier as null | string)
    || !['user', 'auto_review', 'guardian_subagent'].includes(String(config.approvalsReviewer))
    || !record(config.sandbox)
    || !['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(String(config.sandbox.type))
    || !Object.hasOwn(config, 'permissionProfile')
    || !(config.permissionProfile === null || record(config.permissionProfile))
    || (config.permissions !== undefined && !text(config.permissions))
    || !record(config.execution)
    || !['checkpoint', 'unavailable', 'none'].includes(evidence.handoff)
    || evidence.handoff === 'checkpoint'
      && (typeof evidence.handoffDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.handoffDigest))
    || evidence.handoff !== 'checkpoint' && evidence.handoffDigest !== undefined
    || request.mode !== 'linked' && evidence.handoff !== 'none'
    || request.mode === 'linked' && request.handoffConsent === 'none' && evidence.handoff !== 'none'
    || request.mode === 'linked' && request.handoffConsent === 'checkpoint'
      && !['checkpoint', 'unavailable'].includes(evidence.handoff)
  ) return false
  try {
    const execution = parseChatExecutionSettings(config.execution)
    if (
      !['untrusted', 'on-request', 'never'].includes(String(execution.approval))
      || !['default', 'plan'].includes(String(execution.workMode)) || !text(execution.effort)
      || (config.permissions === undefined
        && !['read-only', 'workspace-write', 'full-access'].includes(String(execution.execution)))
      || (config.permissions !== undefined
        && (!record(config.permissionProfile) || config.permissionProfile.id !== config.permissions))
      || (config.permissions === undefined && config.permissionProfile !== null)
    ) return false
    if (config.permissions === undefined) {
      const expected = {
        'read-only': 'readOnly',
        'workspace-write': 'workspaceWrite',
        'full-access': 'dangerFullAccess',
      }
      if (
        !execution.execution || execution.execution === 'inherit'
        || config.sandbox.type !== expected[execution.execution]
        || execution.networkAccess !== undefined && config.sandbox.networkAccess !== execution.networkAccess
      ) return false
    }
  } catch {
    return false
  }
  return true
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

/** Validate durable intent and relation pairs before an owning store resumes dispatch. */
export function parseLogicalContinuationState(value: unknown): LogicalContinuationState {
  if (
    !record(value) || !exact(value, ['revision', 'intents', 'relations', 'preferences', 'preferenceRevisions'])
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !record(value.intents) || !record(value.relations)
  ) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
  if (value.preferenceRevisions !== undefined) {
    if (!record(value.preferenceRevisions)) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
    for (const [key, revision] of Object.entries(value.preferenceRevisions)) {
      let scope: unknown
      try {
        scope = JSON.parse(key)
      } catch {
        throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
      }
      if (
        !Array.isArray(scope) || scope.length !== 2 || !['profile', 'project', 'conversation'].includes(scope[0])
        || !text(scope[1]) || JSON.stringify(scope) !== key || !Number.isSafeInteger(revision) || Number(revision) < 1
      ) {
        throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
      }
    }
  }
  if (value.preferences !== undefined) {
    if (!record(value.preferences)) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
    for (const [key, preference] of Object.entries(value.preferences)) {
      if (
        !record(preference) || !exact(preference, ['contract', 'revision', 'scope', 'mode'])
        || preference.contract !== 'cordisx.conversation-continuation-preference/v1'
        || !Number.isSafeInteger(preference.revision) || Number(preference.revision) < 1
        || !record(preference.scope) || !exact(preference.scope, ['kind', 'id'])
        || !['profile', 'project', 'conversation'].includes(String(preference.scope.kind))
        || !text(preference.scope.id) || key !== JSON.stringify([preference.scope.kind, preference.scope.id])
        || !record(value.preferenceRevisions) || value.preferenceRevisions[key] !== preference.revision
        || !['linked', 'fork', 'fresh'].includes(String(preference.mode))
      ) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
    }
  }
  const appliedRevisions = new Set<number>()
  for (const [id, raw] of Object.entries(value.intents)) {
    if (
      !record(raw)
      || !exact(raw, [
        'request',
        'actor',
        'evidence',
        'channelHistoryActor',
        'state',
        'destination',
        'code',
        'handoffJobId',
        'handoffTurnId',
        'orphanDestination',
      ])
      || !record(raw.request) || !record(raw.actor) || !record(raw.evidence)
    ) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
    const request = raw.request as unknown as LogicalContinuationRequest
    const actor = raw.actor as unknown as LogicalContinuationActor
    const evidence = raw.evidence as unknown as LogicalContinuationEvidence
    const destination = raw.destination as LogicalSessionRef | undefined
    if (
      id !== request.operationId || !validRequest(request) || !text(actor.principal) || !text(actor.scope)
      || !exact(actor, ['principal', 'scope']) || !validEvidence(request, evidence)
      || raw.channelHistoryActor !== undefined && (!record(raw.channelHistoryActor)
          || !exact(raw.channelHistoryActor, ['principal', 'scope'])
          || !text(raw.channelHistoryActor.principal) || !text(raw.channelHistoryActor.scope)
          || request.mode !== 'linked' || raw.state !== 'applied')
      || typeof raw.state !== 'string' || !['creating', 'unknown', 'rejected', 'applied'].includes(raw.state)
      || raw.code !== undefined && !text(raw.code, 128)
      || raw.handoffJobId !== undefined
        && (!text(raw.handoffJobId) || raw.state !== 'applied' || evidence.handoff !== 'checkpoint')
      || raw.handoffTurnId !== undefined && (!text(raw.handoffTurnId) || !text(raw.handoffJobId))
      || raw.orphanDestination !== undefined && (raw.state !== 'rejected' || raw.code !== 'USER_ABANDONED_UNKNOWN'
          || !validDestination(request.source, raw.orphanDestination as LogicalSessionRef))
      || destination !== undefined && !validDestination(request.source, destination)
      || raw.state === 'creating' && destination !== undefined
      || raw.state === 'rejected' && destination !== undefined
    ) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
    const committed = value.relations[id]
    if (raw.state === 'applied') {
      if (
        !destination || request.expectedRevision >= Number(value.revision)
        || appliedRevisions.has(request.expectedRevision)
        || !isDeepStrictEqual(committed, relation(request, evidence, destination))
      ) {
        throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
      }
      appliedRevisions.add(request.expectedRevision)
    } else if (committed !== undefined) throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
  }
  if (Object.keys(value.relations).some(id => !Object.hasOwn(value.intents!, id))) {
    throw new Error('INVALID_LOGICAL_CONTINUATION_STORE')
  }
  return structuredClone(value) as unknown as LogicalContinuationState
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
    // Keep old relations readable, but never create a new empty continuation.
    if (request.mode === 'fresh') return { state: 'rejected', operationId, code: 'FRESH_CONTINUATION_REMOVED' }
    const key = JSON.stringify(request.source)
    if (this.claims.has(key)) return { state: 'rejected', operationId, code: 'SESSION_BUSY' }
    this.claims.add(key)
    let reserved = false, effectStarted = false, destination: LogicalSessionRef | undefined
    try {
      const evidence = await this.adapter.preflight(actor, request)
      if (!evidence || !validEvidence(request, evidence)) {
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
        const code = text(created.code, 128) ? created.code : 'NATIVE_REJECTED'
        await this.finishUnmoved(operationId, 'rejected', code)
        return { state: 'rejected', operationId, code }
      }
      destination = created.destination
      if (
        !validDestination(request.source, destination)
        || !await this.adapter.confirm(request, evidence, destination)
        || !isDeepStrictEqual(await this.adapter.preflight(actor, request), evidence)
      ) {
        await this.finishUnmoved(operationId, 'unknown', 'NATIVE_READBACK_UNCONFIRMED', destination)
        return {
          state: 'unknown',
          operationId,
          ...(validDestination(request.source, destination) ? { destination } : {}),
        }
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
      return {
        state: 'unknown',
        operationId,
        ...(destination && validDestination(request.source, destination) ? { destination } : {}),
      }
    } finally {
      this.claims.delete(key)
    }
  }
  /** Inspect a known native destination; this never reissues a create or business turn. */
  async reconcile(actor: LogicalContinuationActor, operationId: string): Promise<Result> {
    if (
      !actor || !text(actor.principal) || !text(actor.scope) || !exact(actor, ['principal', 'scope'])
      || !operationKey(operationId)
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
      if (destination && validDestination(current.request.source, destination)) {
        current.destination = structuredClone(destination)
      }
    })
  }
}
