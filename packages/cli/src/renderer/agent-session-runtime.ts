import { Context, Service } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentAcquireResult,
  AgentCancelOptions,
  AgentCreateOptions,
  AgentDefinitionIdentity,
  AgentDetailReference,
  AgentDisposeOptions,
  AgentHandle,
  AgentIdleResult,
  AgentLiveEvent,
  AgentLiveEventObserver,
  AgentLiveSubscribeResult,
  AgentMessageDiscardResult,
  AgentMutationResult,
  AgentOptions,
  AgentRegistry,
  AgentResumeOptions,
  AgentRuntimeCapability,
  AgentSetup,
  AgentStatus,
  AgentStatusObservation,
} from '@cordisx/protocol/agents/v1'
import type {
  ApprovalAnswerer,
  ApprovalAnswererHandle,
  ApprovalDecision,
  ApprovalQuestion,
  ApprovalService,
} from '@cordisx/protocol/approval/v1'
import type {
  ApprovalOutcome,
  AgentCancelCause,
  MessageId,
  PluginOwnerIdentity,
  Session,
  SessionEvent,
  SessionEventDataMap,
  SessionEventObserver,
  SessionHeader,
  SessionReadRequest,
  SessionRegistry,
  SessionSnapshotResult,
  SessionSubscribeRequest,
  SessionSubscribeResult,
  SessionSubscription,
  SessionSubscriptionClosed,
  SessionSubscriptionCloseCode,
  UserMessage,
} from '@cordisx/protocol/sessions/v1'
import type {
  EntityAgentAcquireResult,
  EntityAgentCreateOptions,
  EntityAgentResumeOptions,
  EntityBackedAgentRegistry,
  EntityDefinitionResolution,
  EntityRegistry,
  EntitySessionDefinitionBinding,
} from '@cordisx/protocol/entities/v1'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { generationFromContext } from './ownership.js'
import {
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  type CordisXAgentRegistryV1,
  type CordisXAgentSessionLegacyAcquireRequestV1,
  type CordisXAgentSessionLegacyAcquireResultV1,
} from '../agent-session-migration-contracts.js'
import { resolveAgentDefinitionCatalog, type CordisXResolvedAgentDefinition } from './agent-loop.js'
import { presentationForDefinition, type CordisXAgentDefinitionPresentation } from './agent-loop-v4.js'
import type { PlaygroundScenarioSubmissionCapture } from './playground-scenario-session-scope.js'

const ACQUIRE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-acquire-result.v1.schema.json' as const
const ADMISSION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json' as const
const MUTATION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json' as const
const DISCARD_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json' as const
const SNAPSHOT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-snapshot.v1.schema.json' as const
const PAGE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event-page.v1.schema.json' as const
const SUBSCRIPTION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-page.v1.schema.json' as const
const QUESTION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v1.schema.json' as const
const DECISION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v1.schema.json' as const
const ENTITY_ACQUIRE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-agent-acquire-result.v1.schema.json' as const

type EntityAcquireEnvelope = {
  readonly $schema: typeof ENTITY_ACQUIRE_SCHEMA
  readonly contract: 'cordisx.entity-agent-acquire-result/v1'
  readonly schemaVersion: 1
  readonly operation: 'create' | 'resume'
  readonly mutationId?: string
}
type AcceptedEntityAcquire = Extract<EntityAgentAcquireResult, { readonly status: 'accepted' }>

const clone = <Value>(value: Value): Value => structuredClone(value)
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const ownerKey = (owner: PluginOwnerIdentity) => `${owner.pluginId}\u0000${owner.generation}`

type CordisXDriverSessionEventType =
  | 'turn/start' | 'turn/end' | 'step/start' | 'step/end'
  | 'assistant/chunk' | 'assistant/message' | 'tool/call' | 'tool/result'
  | 'agent/inbox/spliced' | 'playground/scenario'

export type CordisXDriverSessionEvent = {
  [K in CordisXDriverSessionEventType]:
    { readonly sessionId: string; readonly type: K; readonly data: SessionEventDataMap[K]; readonly ignorable?: true }
}[CordisXDriverSessionEventType]

type SessionEventInput = {
  [K in SessionEvent['type']]: {
    readonly type: K
    readonly data: Extract<SessionEvent, { readonly type: K }>['data']
    readonly ignorable?: true
  }
}[SessionEvent['type']]

export interface CordisXDriverApprovalRequest {
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
}

export interface CordisXDriverAgentStatus {
  readonly sessionId: string
  readonly status: AgentStatus
}

export interface CordisXDriverMessageClaimed {
  readonly sessionId: string
  readonly messageId: MessageId
  readonly turn: number
}

export interface CordisXPrivateAgentDriver {
  create(input: { readonly sessionId: string; readonly options: AgentOptions; readonly setup?: AgentCreateOptions['setup'] }): Promise<{ readonly status: 'accepted'; readonly detail?: AgentDetailReference } | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }>
  resume(input: { readonly sessionId: string; readonly options: AgentOptions; readonly setup?: AgentResumeOptions['setup'] }): Promise<{ readonly status: 'accepted'; readonly detail?: AgentDetailReference } | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }>
  submit(input: { readonly sessionId: string; readonly message: UserMessage; readonly target: 'next-turn' | 'next-step'; readonly wakeup: boolean }): Promise<'accepted' | 'replayed' | 'unavailable'>
  discard(input: { readonly sessionId: string; readonly messageId: MessageId }): Promise<'accepted' | 'not-found' | 'already-claimed' | 'unavailable'>
  cancel(input: { readonly sessionId: string; readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted' | 'unavailable'>
  /** Driver observations are appended only by the Host Session authority. */
  onSessionEvent?(listener: (event: CordisXDriverSessionEvent) => void | Promise<void>): () => void
  onAgentStatus?(listener: (event: CordisXDriverAgentStatus) => void): () => void
  onMessageClaimed?(listener: (event: CordisXDriverMessageClaimed) => void): () => void
  /** A driver can request a Host-scoped approval without seeing an Agent handle. */
  onApprovalRequest?(listener: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>): () => void
  onReplacement(listener: () => void): () => void
  dispose(): void
}

export interface CordisXAgentSessionRuntimeOptions {
  readonly driver: CordisXPrivateAgentDriver
  readonly authorize: (owner: PluginOwnerIdentity, capability: AgentRuntimeCapability, sessionId?: string) => Promise<boolean>
  readonly now?: () => number
  readonly persistence?: CordisXSessionEventPersistence
  readonly initialSessions?: readonly CordisXPersistedSession[]
  /** Host Playground only: captures the current Shell authority for an accepted submission. */
  readonly captureSubmission?: (
    owner: PluginOwnerIdentity,
    sessionId: string,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
}

export interface CordisXPersistedSession {
  readonly id: string
  readonly generation: number
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  /** Host-validated setup retained in the same Session authority record. */
  readonly setup?: AgentSetup
}

export interface CordisXSessionEventPersistence {
  create(session: CordisXPersistedSession): Promise<void>
  append(input: {
    readonly sessionId: string
    readonly sessionGeneration: number
    readonly expectedSeq: number
    readonly events: readonly SessionEvent[]
  }): Promise<void>
  updateSetup?(input: {
    readonly sessionId: string
    readonly sessionGeneration: number
    readonly setup: AgentSetup
  }): Promise<void>
}

export type CordisXLegacyAgentLoopBindingResolution =
  | { readonly status: 'resolved'; readonly sessionId: string }
  | { readonly status: 'unavailable'; readonly code: 'binding-unresolved' | 'binding-closed' | 'plugin-generation-replaced' | 'connection-replaced' | 'host-unavailable' | 'unsupported' }

export type CordisXLegacyAgentLoopBindingResolver = (
  binding: CordisXAgentSessionLegacyAcquireRequestV1['binding'],
) => Promise<CordisXLegacyAgentLoopBindingResolution>

interface SessionRecord {
  readonly id: string
  generation: number
  readonly header: SessionHeader
  readonly events: SessionEvent[]
  setup: AgentSetup | undefined
  definitions: readonly CordisXResolvedAgentDefinition[] | undefined
  readonly subscribers: Set<SessionSubscriber>
  appendQueue: Promise<void>
  closed?: 'connection-replaced' | 'host-unavailable'
}

interface AgentRecord {
  readonly id: string
  generation: number
  readonly owner: PluginOwnerIdentity
  readonly session: SessionRecord
  readonly options: AgentOptions
  readonly pending: Map<string, { readonly message: UserMessage; readonly target: 'next-turn' | 'next-step' }>
  readonly claimed: Set<string>
  readonly live: Set<AgentSubscriber>
  readonly detail?: AgentDetailReference
  readonly definition?: AgentDefinitionIdentity
  /** Exact Host-resolved setup catalog retained only for this live Agent generation. */
  readonly definitions?: readonly CordisXResolvedAgentDefinition[]
  status: AgentStatus
  readonly idleWaiters: Set<(value: AgentIdleResult) => void>
  disposed?: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced'
}

/**
 * Host-private, read-only materialization input for native task surfaces. It is
 * cloned from the one Session authority and is never offered as a plugin
 * service or used as an append/recovery ledger.
 */
export interface CordisXAgentSessionProjection {
  readonly sessionId: string
  readonly sessionGeneration: number
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly setup?: {
    readonly definition: AgentDefinitionIdentity
    readonly definitions: readonly CordisXResolvedAgentDefinition[]
  }
  readonly closed?: 'connection-replaced' | 'host-unavailable'
  readonly agent?: {
    readonly generation: number
    readonly status: AgentStatus
    readonly detail?: AgentDetailReference
    readonly definition?: AgentDefinitionIdentity
    readonly definitions?: readonly CordisXResolvedAgentDefinition[]
  }
}

interface SessionSubscriber {
  readonly generation: number
  readonly replayThrough: number
  readonly owner: PluginOwnerIdentity
  readonly observer: SessionEventObserver
  lastSeq: number
  closed?: SessionSubscriptionClosed
  resolveClosed: (value: SessionSubscriptionClosed) => void
  delivery: Promise<void>
}

interface AgentSubscriber {
  readonly owner: PluginOwnerIdentity
  readonly observer: AgentLiveEventObserver
  closed?: 'unsubscribed' | 'agent-replaced' | 'plugin-generation-replaced' | 'connection-replaced' | 'permission-revoked'
}

interface AnswererRecord {
  readonly owner: PluginOwnerIdentity
  readonly answerer: ApprovalAnswerer
  closed?: 'disposed' | 'agent-replaced' | 'plugin-generation-replaced' | 'permission-revoked'
}

/**
 * Host-private AgentFactory/session append authority. Public values are only
 * produced through its three Cordis services below; callers never receive a
 * driver, native connection, operation id, or raw native payload.
 */
export class CordisXAgentSessionRuntime {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly agents = new Map<string, AgentRecord>()
  private readonly agentCapabilities = new WeakMap<object, AgentRecord>()
  private readonly handleCapabilities = new WeakMap<object, AgentRecord>()
  private readonly answerers = new Map<string, AnswererRecord>()
  private readonly mutations = new Map<string, { readonly fingerprint: string; readonly result: AgentAcquireResult }>()
  private readonly entityMutations = new Map<string, { readonly fingerprint: string; readonly result: AcceptedEntityAcquire }>()
  private nextAgentGeneration = 0
  private nextSubscriptionGeneration = 0
  private nextOwnerGeneration = 0
  private readonly ownerGenerations = new Map<string, number>()
  private readonly legacyResolvers = new Map<string, { readonly token: object; readonly resolve: CordisXLegacyAgentLoopBindingResolver }>()
  private readonly legacyMutations = new Map<string, { readonly fingerprint: string; readonly result: CordisXAgentSessionLegacyAcquireResultV1 }>()
  private disposed = false
  private readonly unsubscribeReplacement: () => void
  private readonly unsubscribeDriverEvents: () => void
  private readonly unsubscribeDriverApprovals: () => void
  private readonly unsubscribeDriverStatus: () => void
  private readonly unsubscribeDriverClaimed: () => void
  private readonly now: () => number

  constructor(private readonly options: CordisXAgentSessionRuntimeOptions) {
    this.now = options.now ?? (() => Date.now())
    for (const persisted of options.initialSessions ?? []) {
      if (!opaque(persisted.id) || persisted.generation < 1 || persisted.header.id !== persisted.id
        || persisted.events.some((event, index) => event.sessionId !== persisted.id || event.seq !== index)) {
        throw new Error('Recovered Agent Session ledger is invalid')
      }
      if (this.sessions.has(persisted.id)) throw new Error('Recovered Agent Session ledger contains a duplicate SessionId')
      let definitions: readonly CordisXResolvedAgentDefinition[] | undefined
      if (persisted.setup !== undefined) {
        try { definitions = resolveAgentDefinitionCatalog(persisted.setup).definitions }
        catch { throw new Error('Recovered Agent Session setup is invalid') }
      }
      this.sessions.set(persisted.id, {
        id: persisted.id,
        generation: persisted.generation,
        header: Object.freeze(clone(persisted.header)),
        events: persisted.events.map(event => Object.freeze(clone(event))),
        setup: persisted.setup === undefined ? undefined : Object.freeze(clone(persisted.setup)),
        definitions: definitions === undefined ? undefined : Object.freeze(definitions.map(clone)),
        subscribers: new Set(),
        appendQueue: Promise.resolve(),
      })
    }
    this.unsubscribeReplacement = options.driver.onReplacement(() => this.connectionReplaced())
    this.unsubscribeDriverEvents = options.driver.onSessionEvent?.(event => this.appendDriverEvent(event)) ?? (() => {})
    this.unsubscribeDriverApprovals = options.driver.onApprovalRequest?.(async request => await this.requestDriverApproval(request)) ?? (() => {})
    this.unsubscribeDriverStatus = options.driver.onAgentStatus?.(event => this.emitDriverStatus(event)) ?? (() => {})
    this.unsubscribeDriverClaimed = options.driver.onMessageClaimed?.(event => { void this.claimDriverMessage(event) }) ?? (() => {})
  }

  ownerFromContext(ctx: Context): PluginOwnerIdentity {
    const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
    const pluginId = scoped[CORDISX_PLUGIN_ID]
    const source = scoped[CORDISX_PLUGIN_SOURCE]
    if (pluginId === undefined || source === undefined) throw new Error('Agent runtime requires a Host-bound plugin context')
    const key = `${source}\u0000${pluginId}\u0000${generationFromContext(ctx) ?? 'host'}`
    let generation = this.ownerGenerations.get(key)
    if (generation === undefined) {
      generation = ++this.nextOwnerGeneration
      this.ownerGenerations.set(key, generation)
    }
    return Object.freeze({ pluginId: `${source}:${pluginId}`, generation })
  }

  async create(owner: PluginOwnerIdentity, input: AgentCreateOptions): Promise<AgentAcquireResult> {
    const sessionId = input.sessionId ?? `cx-session.${crypto.randomUUID()}`
    if (!opaque(sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.create', sessionId)) return this.acquireDenied('create', input.mutationId)
    return await this.acquire(owner, 'create', sessionId, input, input.sessionId === undefined ? 'host' : 'caller')
  }

  async resume(owner: PluginOwnerIdentity, input: AgentResumeOptions): Promise<AgentAcquireResult> {
    if (!opaque(input.sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.resume', input.sessionId)) return this.acquireDenied('resume', input.mutationId)
    return await this.acquire(owner, 'resume', input.sessionId, input, 'caller')
  }

  async createEntity(owner: PluginOwnerIdentity, input: EntityAgentCreateOptions, registry: EntityRegistry): Promise<EntityAgentAcquireResult> {
    const sessionId = input.sessionId ?? `cx-session.${crypto.randomUUID()}`
    const envelope = { $schema: ENTITY_ACQUIRE_SCHEMA, contract: 'cordisx.entity-agent-acquire-result/v1' as const, schemaVersion: 1 as const, operation: 'create' as const, ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }) }
    if (!opaque(sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.create', sessionId)) return { ...envelope, status: 'denied', code: 'permission-denied' }
    const prior = this.replayEntityMutation(owner, envelope, input)
    if (prior !== undefined) return prior
    const target = await registry.get(input.definition)
    if (target.status === 'unavailable') return { ...envelope, status: 'unavailable', code: 'host-unavailable' }
    if (target.status === 'not-found') {
      const snapshot = await registry.snapshot().catch(() => undefined)
      const current = snapshot?.entities.find(entity => entity.identity.agentId === input.definition.agentId)
      return { ...envelope, status: 'unavailable', code: current === undefined ? 'entity-not-found' : 'entity-revision-stale' }
    }
    const catalog = new Map<string, typeof target.entity>()
    const collect = async (resolution: typeof target.entity): Promise<boolean> => {
      const key = JSON.stringify([resolution.identity.agentId, resolution.identity.revision])
      if (catalog.has(key)) return true
      catalog.set(key, resolution)
      for (const parent of resolution.definition.extends ?? []) {
        const result = await registry.get(parent)
        if (result.status !== 'found' || !await collect(result.entity)) return false
      }
      return true
    }
    catalog.clear()
    if (!await collect(target.entity)) return { ...envelope, status: 'unavailable', code: 'entity-invalid' }
    const definitions = [...catalog.values()].map(entity => clone(entity.definition))
    if (definitions.length === 0) return { ...envelope, status: 'unavailable', code: 'entity-invalid' }
    const setup: AgentSetup = { definition: clone(target.entity.identity), definitions: definitions as [typeof definitions[number], ...typeof definitions[number][]] }
    const binding: EntitySessionDefinitionBinding = {
      source: 'entity-registry', owner: clone(target.entity.owner),
      resolution: { identity: clone(target.entity.identity), digest: target.entity.digest, definition: clone(target.entity.definition) },
    }
    const acquireInput: AgentCreateOptions = {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
      ...(input.options === undefined ? {} : { options: clone(input.options) }), setup,
    }
    const acquired = await this.acquire(owner, 'create', sessionId, acquireInput, input.sessionId === undefined ? 'host' : 'caller', false, binding)
    const result = this.entityAcquireResult(envelope, acquired, {
      identity: clone(target.entity.identity), digest: target.entity.digest, definition: clone(target.entity.definition),
    }, 'registry-current')
    return this.rememberEntityMutation(owner, input, result)
  }

  async resumeEntity(owner: PluginOwnerIdentity, input: EntityAgentResumeOptions): Promise<EntityAgentAcquireResult> {
    const envelope = { $schema: ENTITY_ACQUIRE_SCHEMA, contract: 'cordisx.entity-agent-acquire-result/v1' as const, schemaVersion: 1 as const, operation: 'resume' as const, ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }) }
    if (!opaque(input.sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.resume', input.sessionId)) return { ...envelope, status: 'denied', code: 'permission-denied' }
    const prior = this.replayEntityMutation(owner, envelope, input)
    if (prior !== undefined) return prior
    const session = this.sessions.get(input.sessionId)
    const event = session?.events.find(candidate => candidate.type === 'entity/definition-bound')
    if (event === undefined || event.type !== 'entity/definition-bound') return { ...envelope, status: 'unavailable', code: 'unsupported' }
    const binding = event.data
    if (input.definition !== undefined && (input.definition.agentId !== binding.resolution.identity.agentId
      || input.definition.revision !== binding.resolution.identity.revision)) return { ...envelope, status: 'unavailable', code: 'entity-revision-stale' }
    const acquireInput: AgentResumeOptions = {
      sessionId: input.sessionId,
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
      ...(input.options === undefined ? {} : { options: clone(input.options) }),
    }
    const acquired = await this.acquire(owner, 'resume', input.sessionId, acquireInput, 'caller')
    return this.rememberEntityMutation(owner, input, this.entityAcquireResult(envelope, acquired, binding.resolution, 'session-persisted'))
  }

  async get(owner: PluginOwnerIdentity, agentId: string): Promise<Agent | undefined> {
    if (!opaque(agentId) || !await this.allowed(owner, 'agents.get', agentId)) return undefined
    const record = this.agents.get(agentId)
    return record === undefined || record.disposed !== undefined ? undefined : this.agent(owner, record)
  }

  /** Host-only projection for Conversation Shell identity actions. */
  definitionPresentation(identity: { readonly agentId: string; readonly revision: string }): CordisXAgentDefinitionPresentation | undefined {
    let selected: { readonly live: boolean; readonly generation: number; readonly definition: CordisXResolvedAgentDefinition } | undefined
    for (const record of this.agents.values()) {
      if (!this.current(record)) continue
      const definition = record.definitions?.find(candidate => candidate.identity.agentId === identity.agentId
        && candidate.identity.revision === identity.revision)
      if (definition === undefined) continue
      if (selected === undefined || !selected.live || record.generation > selected.generation) {
        selected = { live: true, generation: record.generation, definition }
      }
    }
    for (const session of this.sessions.values()) {
      if (!this.sessionLive(session)) continue
      const definition = session.definitions?.find(candidate => candidate.identity.agentId === identity.agentId
        && candidate.identity.revision === identity.revision)
      if (definition === undefined || selected?.live === true) continue
      if (selected === undefined || session.generation > selected.generation) {
        selected = { live: false, generation: session.generation, definition }
      }
    }
    return selected === undefined ? undefined : presentationForDefinition(selected.definition)
  }

  /** Host-only exact owner lookup for Playground scenario scope activation. */
  ownerForSession(sessionId: string): PluginOwnerIdentity | undefined {
    const record = this.agents.get(sessionId)
    return record === undefined || !this.current(record) ? undefined : Object.freeze(clone(record.owner))
  }

  /** Host-only projection; SessionEvent remains the sole durable execution fact. */
  playgroundProjection(): readonly CordisXAgentSessionProjection[] {
    return Object.freeze([...this.sessions.values()].map(session => {
      const agent = this.agents.get(session.id)
      const currentAgent = agent !== undefined && this.current(agent) ? agent : undefined
      return Object.freeze({
        sessionId: session.id,
        sessionGeneration: session.generation,
        header: clone(session.header),
        events: Object.freeze(session.events.map(clone)),
        ...(session.setup === undefined || session.definitions === undefined ? {} : {
          setup: Object.freeze({
            definition: clone(session.setup.definition),
            definitions: Object.freeze(session.definitions.map(clone)),
          }),
        }),
        ...(session.closed === undefined ? {} : { closed: session.closed }),
        ...(currentAgent === undefined ? {} : {
          agent: Object.freeze({
            generation: currentAgent.generation,
            status: currentAgent.status,
            ...(currentAgent.detail === undefined ? {} : { detail: clone(currentAgent.detail) }),
            ...(currentAgent.definition === undefined ? {} : { definition: clone(currentAgent.definition) }),
            ...(currentAgent.definitions === undefined ? {} : { definitions: Object.freeze(currentAgent.definitions.map(clone)) }),
          }),
        }),
      })
    }))
  }

  installLegacyBindingResolver(ownerPluginId: string, resolve: CordisXLegacyAgentLoopBindingResolver): () => void {
    const token = {}
    this.legacyResolvers.set(ownerPluginId, { token, resolve })
    return () => {
      if (this.legacyResolvers.get(ownerPluginId)?.token === token) this.legacyResolvers.delete(ownerPluginId)
    }
  }

  async acquireLegacyTaskBinding(
    owner: PluginOwnerIdentity,
    request: CordisXAgentSessionLegacyAcquireRequestV1,
  ): Promise<CordisXAgentSessionLegacyAcquireResultV1> {
    const envelope = {
      $schema: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
      contract: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
      schemaVersion: 1 as const,
      mutationId: request.mutationId,
    }
    if (request.$schema !== CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1
      || request.contract !== CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1
      || request.schemaVersion !== 1 || !opaque(request.mutationId)
      || request.binding.contract !== 'cordisx.agent-loop-task-binding/v4'
      || request.binding.schemaVersion !== 4 || request.binding.state !== 'active') {
      return Object.freeze({ ...envelope, status: 'unavailable', code: request.binding?.state === 'closed' ? 'binding-closed' : 'unsupported' })
    }
    const mutationKey = `${ownerKey(owner)}\u0000legacy-acquire\u0000${request.mutationId}`
    const fingerprint = JSON.stringify(clone(request))
    const prior = this.legacyMutations.get(mutationKey)
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return Object.freeze({ ...envelope, status: 'conflict', code: 'mutation-conflict' })
      if (prior.result.status !== 'accepted') return prior.result
      const record = this.handleCapabilities.get(prior.result.acquire.handle as object)
      if (record === undefined || !this.current(record)) return Object.freeze({ ...envelope, status: 'unavailable', code: record?.disposed === 'connection-replaced' ? 'connection-replaced' : 'plugin-generation-replaced' })
      return Object.freeze({ ...prior.result, acquire: Object.freeze({ ...prior.result.acquire, disposition: 'replayed' as const }) })
    }
    const rememberLegacy = <Result extends CordisXAgentSessionLegacyAcquireResultV1>(result: Result): Result => {
      this.legacyMutations.set(mutationKey, { fingerprint, result })
      return result
    }
    const resolver = this.legacyResolvers.get(owner.pluginId)
    if (resolver === undefined) return rememberLegacy(Object.freeze({ ...envelope, status: 'unavailable', code: 'plugin-generation-replaced' }))
    let resolution: CordisXLegacyAgentLoopBindingResolution
    try { resolution = await resolver.resolve(clone(request.binding)) }
    catch { resolution = { status: 'unavailable', code: 'host-unavailable' } }
    if (resolution.status !== 'resolved' || !opaque(resolution.sessionId)) {
      return rememberLegacy(Object.freeze({ ...envelope, status: 'unavailable', code: resolution.status === 'resolved' ? 'binding-unresolved' : resolution.code }))
    }
    const resumeInput: AgentResumeOptions = {
      sessionId: resolution.sessionId,
      mutationId: request.mutationId,
      ...(request.options === undefined ? {} : { options: clone(request.options) }),
      ...(request.setup === undefined ? {} : { setup: clone(request.setup) }),
    }
    const acquire = !await this.allowed(owner, 'agents.resume', resolution.sessionId)
      ? this.acquireDenied('resume', request.mutationId)
      : await this.acquire(owner, 'resume', resolution.sessionId, resumeInput, 'caller', true)
    if (acquire.status === 'accepted') return rememberLegacy(Object.freeze({ ...envelope, status: 'accepted', sessionId: resolution.sessionId, identitySource: 'agent-loop-authority', acquire }))
    if (acquire.status === 'denied') return rememberLegacy(Object.freeze({ ...envelope, status: 'denied', code: 'permission-denied' }))
    if (acquire.status === 'conflict') return rememberLegacy(Object.freeze({ ...envelope, status: 'conflict', code: acquire.code === 'session-already-exists' ? 'agent-already-live' : acquire.code }))
    return rememberLegacy(Object.freeze({ ...envelope, status: 'unavailable', code: acquire.code === 'runtime-unavailable' || acquire.code === 'session-unavailable' ? 'host-unavailable' : acquire.code }))
  }

  async session(owner: PluginOwnerIdentity, sessionId: string): Promise<Session | undefined> {
    if (!opaque(sessionId) || !await this.allowed(owner, 'sessions.get', sessionId)) return undefined
    const record = this.sessions.get(sessionId)
    return record === undefined ? undefined : this.sessionHandle(owner, record)
  }

  async requestApproval(owner: PluginOwnerIdentity, request: Parameters<ApprovalService['request']>[0]): Promise<ApprovalDecision> {
    const record = this.recordForAgent(request.agent)
    if (record === undefined || !await this.allowed(owner, 'approvals.request', request.agent.id)) {
      return this.approvalDecision(request.agent, crypto.randomUUID(), request.toolName, request.callId, 'unavailable')
    }
    const id = `cx-approval.${crypto.randomUUID()}`
    const question = this.approvalQuestion(record, id, request.toolName, request.callId, request.reason)
    if (!await this.append(record.session, 'approval/asked', { id, toolName: request.toolName, ...(request.callId === undefined ? {} : { callId: request.callId }), ...(request.reason === undefined ? {} : { reason: request.reason }) })) {
      return this.approvalDecision(record, id, request.toolName, request.callId, 'unavailable')
    }
    const answerer = this.answerers.get(this.answererKey(record))
    let outcome: ApprovalOutcome = 'unavailable'
    if (answerer !== undefined && answerer.closed === undefined && await this.allowed(answerer.owner, 'approvals.answer', record.id)) {
      try {
        const proposed = await answerer.answerer(question)
        if (proposed === 'allowed-once' || proposed === 'rejected' || proposed === 'cancelled' || proposed === 'unavailable') outcome = proposed
      } catch { outcome = 'unavailable' }
    }
    if (!await this.append(record.session, 'approval/decided', { id, outcome })) outcome = 'unavailable'
    return this.approvalDecision(record, id, request.toolName, request.callId, outcome)
  }

  async registerAnswerer(owner: PluginOwnerIdentity, agent: Agent, answerer: ApprovalAnswerer): Promise<ApprovalAnswererHandle> {
    const record = this.recordForAgent(agent)
    if (record === undefined || typeof answerer !== 'function' || !await this.allowed(owner, 'approvals.answer', agent.id)) {
      throw new Error('Approval answerer is unavailable')
    }
    const entry: AnswererRecord = { owner: clone(owner), answerer }
    this.answerers.set(this.answererKey(record), entry)
    const handle = Object.freeze({
      agentId: record.id,
      agentGeneration: record.generation,
      dispose: async () => {
        if (entry.closed === undefined) entry.closed = 'disposed'
        this.answerers.delete(this.answererKey(record))
        return { status: 'closed' as const, code: 'disposed' as const }
      },
    })
    return handle as ApprovalAnswererHandle
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.unsubscribeReplacement()
    this.unsubscribeDriverEvents()
    this.unsubscribeDriverApprovals()
    this.unsubscribeDriverStatus()
    this.unsubscribeDriverClaimed()
    await Promise.all([...this.sessions.values()].map(session => session.appendQueue))
    this.disposed = true
    for (const agent of this.agents.values()) this.disposeAgent(agent, 'runtime-disposed')
    for (const session of this.sessions.values()) this.closeSession(session, 'host-unavailable')
    this.options.driver.dispose()
  }

  /** Host lifecycle/route/lease fences call this private authority directly. */
  fenceSession(sessionId: string, code: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) this.closeSession(session, code === 'route-replaced' ? 'host-unavailable' : code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable', code)
  }

  /** Route, permission, and plugin-generation authorities fence by Host-bound owner only. */
  fenceOwner(ownerPluginId: string, code: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>): void {
    for (const agent of this.agents.values()) {
      if (agent.owner.pluginId !== ownerPluginId) continue
      this.disposeAgent(agent, code === 'connection-replaced' ? 'connection-replaced' : 'owner-disposed')
      this.closeSession(agent.session, code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable', code)
    }
  }

  private async acquire(
    owner: PluginOwnerIdentity,
    operation: 'create' | 'resume',
    sessionId: string,
    input: AgentCreateOptions | AgentResumeOptions,
    source: 'host' | 'caller',
    resolvedLegacy = false,
    entityBinding?: EntitySessionDefinitionBinding,
  ): Promise<AgentAcquireResult> {
    if (this.disposed) return this.acquireUnavailable(operation, input.mutationId, 'runtime-unavailable')
    const mutationId = input.mutationId
    const mutationKey = mutationId === undefined ? undefined : `${ownerKey(owner)}\u0000${operation}\u0000${mutationId}`
    const fingerprint = JSON.stringify(clone(input))
    const prior = mutationKey === undefined ? undefined : this.mutations.get(mutationKey)
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return this.acquireConflict(operation, mutationId, 'mutation-conflict')
      if (prior.result.status === 'accepted') {
        const record = this.handleCapabilities.get(prior.result.handle as object)
        if (record === undefined || !this.current(record)) return this.acquireUnavailable(operation, mutationId, 'host-unavailable')
        return { ...prior.result, disposition: 'replayed' }
      }
      return clone(prior.result)
    }
    if (operation === 'create' && this.sessions.has(sessionId)) return this.remember(mutationKey, fingerprint, this.acquireConflict(operation, mutationId, 'session-already-exists'))
    const live = this.agents.get(sessionId)
    if (live !== undefined && live.disposed === undefined) return this.remember(mutationKey, fingerprint, this.acquireConflict(operation, mutationId, 'agent-already-live'))
    const existing = this.sessions.get(sessionId)
    if (operation === 'resume' && existing === undefined && !resolvedLegacy) return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'session-unavailable'))
    let definitions: readonly CordisXResolvedAgentDefinition[] | undefined
    if (input.setup !== undefined) {
      try { definitions = resolveAgentDefinitionCatalog(input.setup).definitions }
      catch { return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'unsupported')) }
    }
    const driver = operation === 'create'
      ? await this.options.driver.create({ sessionId, options: input.options ?? {}, ...(input.setup === undefined ? {} : { setup: input.setup }) })
      : await this.options.driver.resume({ sessionId, options: input.options ?? {}, ...(input.setup === undefined ? {} : { setup: input.setup }) })
    if (driver.status !== 'accepted') return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, driver.code))
    const session = existing ?? await this.newSession(sessionId, input.setup, definitions, entityBinding)
    if (session === undefined) return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'host-unavailable'))
    if (existing !== undefined && input.setup !== undefined && definitions !== undefined
      && !await this.updateSessionSetup(session, input.setup, definitions)) {
      return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'host-unavailable'))
    }
    const setup = input.setup ?? session.setup
    const resolvedDefinitions = definitions ?? session.definitions
    const record: AgentRecord = {
      id: sessionId,
      generation: ++this.nextAgentGeneration,
      owner: clone(owner),
      session,
      options: clone(input.options ?? {}),
      pending: new Map(),
      claimed: new Set(),
      live: new Set(),
      status: 'idle',
      idleWaiters: new Set(),
      ...(setup === undefined ? {} : { definition: clone(setup.definition) }),
      ...(resolvedDefinitions === undefined ? {} : { definitions: clone(resolvedDefinitions) }),
      ...(driver.detail === undefined ? {} : { detail: clone(driver.detail) }),
    }
    this.agents.set(sessionId, record)
    this.emitLive(record, 'agent/created', {})
    this.emitLive(record, 'agent/session-start', { source: operation === 'create' ? 'startup' : 'resume' })
    const handle = this.handle(owner, record)
    const accepted = {
      $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1' as const, schemaVersion: 1 as const,
      operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'accepted' as const,
      sessionId, agentGeneration: record.generation, sessionGeneration: session.generation,
      owner: clone(owner), sessionIdSource: source, disposition: operation === 'create' ? 'created' as const : 'resumed' as const, handle,
    }
    return this.remember(mutationKey, fingerprint, accepted)
  }

  private agent(owner: PluginOwnerIdentity, record: AgentRecord): Agent {
    const session = this.sessionHandle(owner, record.session)
    const admission = async (message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean) => {
      if (!this.current(record)) return this.admission(message.id, 'unavailable', 'agent-replaced')
      if (!this.sameSource(owner, message.source)) return this.admission(message.id, 'denied', 'source-denied')
      if (!await this.allowed(owner, 'agents.message.submit', record.id)) return this.admission(message.id, 'denied', 'permission-denied')
      const prior = record.pending.get(message.id)
      if (prior !== undefined) return this.admission(message.id, 'accepted')
      const sourceCapture = this.options.captureSubmission?.(owner, record.id, message.id)
      let submitted: Awaited<ReturnType<CordisXPrivateAgentDriver['submit']>>
      try { submitted = await this.options.driver.submit({ sessionId: record.id, message: clone(message), target, wakeup }) }
      catch (error) { sourceCapture?.close(); throw error }
      if (submitted === 'replayed') {
        sourceCapture?.close()
        return this.admission(message.id, 'accepted')
      }
      if (submitted !== 'accepted') {
        sourceCapture?.close()
        return this.admission(message.id, 'unavailable', 'host-unavailable')
      }
      sourceCapture?.commit()
      const stored = clone(message)
      record.pending.set(stored.id, { message: stored, target })
      const appended = await this.appendMany(record.session, [
        { type: 'agent/inbox/spliced', data: { target, start: target === 'next-turn' ? record.pending.size - 1 : 0, inserted: [stored] } },
        { type: 'user/message', data: stored },
      ])
      if (!appended) {
        record.pending.delete(stored.id)
        return this.admission(message.id, 'unavailable', 'host-unavailable')
      }
      this.emitLive(record, 'agent/inbox/inserted', { message: stored })
      return this.admission(stored.id, 'accepted')
    }
    const agent = Object.freeze({
      id: record.id, generation: record.generation, options: clone(record.options), session,
      inbox: Object.freeze({
        nextTurn: [...record.pending.values()].filter(item => item.target === 'next-turn').map(item => clone(item.message)),
        nextStep: [...record.pending.values()].filter(item => item.target === 'next-step').map(item => clone(item.message)),
      }),
      status: this.current(record) ? ({ status: 'available', value: record.status } satisfies AgentStatusObservation) : { status: 'unavailable', code: 'agent-replaced' },
      ...(record.detail === undefined ? {} : { detail: clone(record.detail) }),
      send: admission,
      followup: async (message: UserMessage) => await admission(message, 'next-turn', true),
      steer: async (message: UserMessage) => await admission(message, 'next-step', true),
      inject: async (message: UserMessage) => await admission(message, 'next-step', false),
      discard: async (messageId: MessageId): Promise<AgentMessageDiscardResult> => {
        if (!this.current(record)) return this.discard(messageId, 'unavailable', 'agent-replaced')
        if (!await this.allowed(owner, 'agents.message.cancel', record.id)) return this.discard(messageId, 'denied', 'permission-denied')
        const driver = await this.options.driver.discard({ sessionId: record.id, messageId })
        if (driver === 'already-claimed' || record.claimed.has(messageId)) return this.discard(messageId, 'conflict', 'already-claimed')
        const pending = record.pending.get(messageId)
        if (driver === 'not-found' || pending === undefined) return this.discard(messageId, 'not-found')
        if (driver === 'unavailable') return this.discard(messageId, 'unavailable', 'host-unavailable')
        record.pending.delete(messageId)
        if (!await this.append(record.session, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })) {
          return this.discard(messageId, 'unavailable', 'host-unavailable')
        }
        this.emitLive(record, 'agent/inbox/discarded', { message: pending.message })
        return this.discard(messageId, 'accepted')
      },
      cancel: async (cause: AgentCancelCause, options?: AgentCancelOptions): Promise<AgentMutationResult<'cancel'>> => {
        if (!this.current(record)) return this.mutation('cancel', options?.mutationId, 'unavailable', 'agent-replaced')
        if (!await this.allowed(owner, 'agents.cancel', record.id)) return this.mutation('cancel', options?.mutationId, 'denied', 'permission-denied')
        const result = await this.options.driver.cancel({ sessionId: record.id, cause, keepInbox: options?.keepInbox === true })
        if (result !== 'accepted') return this.mutation('cancel', options?.mutationId, 'unavailable', 'unsupported')
        if (options?.keepInbox !== true) {
          for (const pending of record.pending.values()) {
            if (!await this.append(record.session, 'agent/inbox/spliced', { target: pending.target, start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })) {
              return this.mutation('cancel', options?.mutationId, 'unavailable', 'host-unavailable')
            }
            this.emitLive(record, 'agent/inbox/discarded', { message: pending.message })
          }
          record.pending.clear()
        }
        return this.mutation('cancel', options?.mutationId, 'accepted')
      },
      whenIdle: async (): Promise<AgentIdleResult> => {
        if (!this.current(record)) return { status: 'unavailable', code: 'agent-replaced' }
        if (record.status === 'idle') return { status: 'idle' }
        return await new Promise(resolve => record.idleWaiters.add(resolve))
      },
      subscribe: async (observer: AgentLiveEventObserver): Promise<AgentLiveSubscribeResult> => {
        if (!this.current(record)) return { status: 'unavailable', code: 'agent-replaced' }
        if (!await this.allowed(owner, 'agents.live.subscribe', record.id)) return { status: 'denied', code: 'permission-denied' }
        const subscriber: AgentSubscriber = { owner: clone(owner), observer }
        record.live.add(subscriber)
        const subscription = Object.freeze({
          agentId: record.id, agentGeneration: record.generation,
          unsubscribe: async () => {
            subscriber.closed = 'unsubscribed'; record.live.delete(subscriber)
            return { status: 'closed' as const, code: 'unsubscribed' as const }
          },
        })
        return { status: 'subscribed', subscription } as AgentLiveSubscribeResult
      },
    })
    const branded = agent as unknown as Agent
    this.agentCapabilities.set(branded, record)
    return branded
  }

  private sessionHandle(owner: PluginOwnerIdentity, record: SessionRecord): Session {
    const session = Object.freeze({
      id: record.id, generation: record.generation, header: clone(record.header),
      snapshot: async (): Promise<SessionSnapshotResult> => {
        await record.appendQueue
        if (!this.sessionLive(record)) return { status: 'unavailable', code: record.closed === 'connection-replaced' ? 'session-replaced' : 'host-unavailable' }
        if (!await this.allowed(owner, 'sessions.read', record.id)) return { status: 'unavailable', code: 'permission-revoked' }
        return { status: 'available', snapshot: {
          $schema: SNAPSHOT_SCHEMA, contract: 'cordisx.session-snapshot/v1', schemaVersion: 1,
          sessionId: record.id, sessionGeneration: record.generation, header: clone(record.header), snapshotSeq: record.events.length - 1,
        } }
      },
      read: async (request: SessionReadRequest = {}) => {
        await record.appendQueue
        if (!this.sessionLive(record)) return { status: 'unavailable' as const, code: record.closed === 'connection-replaced' ? 'session-replaced' as const : 'host-unavailable' as const }
        if (!await this.allowed(owner, 'sessions.read', record.id)) return { status: 'unavailable' as const, code: 'permission-revoked' as const }
        const afterSeq = request.afterSeq ?? -1
        const snapshotSeq = request.snapshotSeq ?? record.events.length - 1
        const limit = request.limit ?? 100
        if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(snapshotSeq) || snapshotSeq < -1 || snapshotSeq > record.events.length - 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          return { status: 'unavailable' as const, code: 'unsupported' as const }
        }
        const events = record.events.filter(event => event.seq > afterSeq && event.seq <= snapshotSeq).slice(0, limit).map(clone)
        const nextAfterSeq = events.at(-1)?.seq ?? afterSeq
        return { status: 'available' as const, page: {
          $schema: PAGE_SCHEMA, contract: 'cordisx.session-event-page/v1', schemaVersion: 1,
          sessionId: record.id, sessionGeneration: record.generation, afterSeq, snapshotSeq, events,
          nextAfterSeq, hasMore: record.events.some(event => event.seq > nextAfterSeq && event.seq <= snapshotSeq),
        } }
      },
      subscribe: async (request: SessionSubscribeRequest, observer: SessionEventObserver): Promise<SessionSubscribeResult> => {
        await record.appendQueue
        if (!this.sessionLive(record)) return { status: 'unavailable', code: record.closed === 'connection-replaced' ? 'session-replaced' : 'host-unavailable' }
        if (!await this.allowed(owner, 'sessions.subscribe', record.id)) return { status: 'unavailable', code: 'permission-revoked' }
        const afterSeq = request.afterSeq ?? -1
        if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(request.pageSize ?? 100) || (request.pageSize ?? 100) < 1 || (request.pageSize ?? 100) > 500) return { status: 'unavailable', code: 'unsupported' }
        // Register before capturing the watermark. Any later append is live,
        // while the pre-commit range is emitted once as replay.
        let resolveClosed: (value: SessionSubscriptionClosed) => void = () => {}
        const closed = new Promise<SessionSubscriptionClosed>(resolve => { resolveClosed = resolve })
        const subscriber: SessionSubscriber = {
          generation: ++this.nextSubscriptionGeneration,
          replayThrough: record.events.length - 1,
          owner: clone(owner), observer, lastSeq: afterSeq, resolveClosed, delivery: Promise.resolve(),
        }
        record.subscribers.add(subscriber)
        const replayThrough = subscriber.replayThrough
        const replay = record.events.filter(event => event.seq > afterSeq && event.seq <= replayThrough).map(clone)
        subscriber.lastSeq = replayThrough
        if (replay.length > 0) await this.deliver(subscriber, { $schema: SUBSCRIPTION_SCHEMA, contract: 'cordisx.session-subscription-page/v1', schemaVersion: 1, sessionId: record.id, sessionGeneration: record.generation, subscriptionGeneration: subscriber.generation, replayThrough, phase: 'replay', events: replay })
        const subscription = Object.freeze({
          sessionId: record.id, sessionGeneration: record.generation, subscriptionGeneration: subscriber.generation, replayThrough,
          closed,
          unsubscribe: async () => this.closeSubscriber(record, subscriber, 'unsubscribed'),
        })
        return { status: 'subscribed', subscription } as SessionSubscribeResult
      },
    })
    return session as Session
  }

  private async append<K extends SessionEvent['type']>(session: SessionRecord, type: K, data: Extract<SessionEvent, { readonly type: K }>['data'], ignorable?: true): Promise<boolean> {
    return await this.appendMany(session, [{ type, data, ...(ignorable === true ? { ignorable: true as const } : {}) } as SessionEventInput])
  }

  private async appendMany(session: SessionRecord, inputs: readonly SessionEventInput[]): Promise<boolean> {
    if (inputs.length === 0) return true
    let accepted = false
    const operation = session.appendQueue.then(async () => {
      if (!this.sessionLive(session)) return
      const expectedSeq = session.events.length
      const events = inputs.map((input, index) => Object.freeze({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json' as const,
        contract: 'cordisx.session-event/v1' as const, schemaVersion: 1 as const,
        sessionId: session.id, seq: expectedSeq + index, time: this.now(), type: input.type, data: clone(input.data),
        ...('ignorable' in input && input.ignorable === true ? { ignorable: true as const } : {}),
      }) as SessionEvent)
      try {
        await this.options.persistence?.append({
          sessionId: session.id,
          sessionGeneration: session.generation,
          expectedSeq,
          events: clone(events),
        })
      } catch {
        this.closeSession(session, 'host-unavailable')
        return
      }
      if (!this.sessionLive(session)) return
      session.events.push(...events)
      accepted = true
      for (const event of events) {
        for (const subscriber of [...session.subscribers]) {
          if (subscriber.closed !== undefined || event.seq <= subscriber.lastSeq) continue
          subscriber.lastSeq = event.seq
          void this.deliver(subscriber, { $schema: SUBSCRIPTION_SCHEMA, contract: 'cordisx.session-subscription-page/v1', schemaVersion: 1, sessionId: session.id, sessionGeneration: session.generation, subscriptionGeneration: subscriber.generation, replayThrough: subscriber.replayThrough, phase: 'live', events: [clone(event)] })
        }
      }
    })
    session.appendQueue = operation.catch(() => undefined)
    await session.appendQueue
    return accepted
  }

  private async appendDriverEvent(event: CordisXDriverSessionEvent): Promise<void> {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record)) return
    await this.append(record.session, event.type, event.data as Extract<SessionEvent, { readonly type: typeof event.type }>['data'], event.ignorable)
  }

  private async requestDriverApproval(request: CordisXDriverApprovalRequest): Promise<ApprovalOutcome> {
    const record = this.agents.get(request.sessionId)
    if (record === undefined || !this.current(record)) return 'unavailable'
    const decision = await this.requestApproval(record.owner, {
      agent: this.agent(record.owner, record), toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    return decision.outcome
  }

  private emitDriverStatus(event: CordisXDriverAgentStatus): void {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record)) return
    record.status = event.status
    this.emitLive(record, 'agent/status', { status: event.status })
    if (event.status === 'idle') {
      for (const resolve of record.idleWaiters) resolve({ status: 'idle' })
      record.idleWaiters.clear()
    }
  }

  private async claimDriverMessage(event: CordisXDriverMessageClaimed): Promise<void> {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record) || record.claimed.has(event.messageId)) return
    const pending = record.pending.get(event.messageId)
    if (pending === undefined) return
    record.pending.delete(event.messageId)
    record.claimed.add(event.messageId)
    if (!await this.append(record.session, 'agent/inbox/spliced', {
      target: pending.target, start: 0, removedCount: 1, inserted: [],
    })) return
    this.emitLive(record, 'agent/inbox/claimed', { message: pending.message, turn: event.turn })
  }

  private async newSession(
    id: string,
    setup: AgentSetup | undefined,
    definitions: readonly CordisXResolvedAgentDefinition[] | undefined,
    entityBinding?: EntitySessionDefinitionBinding,
  ): Promise<SessionRecord | undefined> {
    const initialEvents: SessionEvent[] = entityBinding === undefined ? [] : [Object.freeze({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
      contract: 'cordisx.session-event/v1', schemaVersion: 1,
      sessionId: id, seq: 0, time: this.now(), type: 'entity/definition-bound', ignorable: true, data: clone(entityBinding),
    }) as SessionEvent]
    const record: SessionRecord = {
      id, generation: 1,
      header: Object.freeze({ id, formatVersion: 1, createdAt: this.now(), isSeeded: false }),
      events: initialEvents,
      setup: setup === undefined ? undefined : Object.freeze(clone(setup)),
      definitions: definitions === undefined ? undefined : Object.freeze(definitions.map(clone)),
      subscribers: new Set(), appendQueue: Promise.resolve(),
    }
    try {
      await this.options.persistence?.create({
        id, generation: record.generation, header: clone(record.header), events: clone(initialEvents),
        ...(record.setup === undefined ? {} : { setup: clone(record.setup) }),
      })
    } catch { return undefined }
    this.sessions.set(id, record)
    return record
  }

  private async updateSessionSetup(
    session: SessionRecord,
    setup: AgentSetup,
    definitions: readonly CordisXResolvedAgentDefinition[],
  ): Promise<boolean> {
    if (this.options.persistence !== undefined && this.options.persistence.updateSetup === undefined) return false
    try {
      await this.options.persistence?.updateSetup?.({
        sessionId: session.id,
        sessionGeneration: session.generation,
        setup: clone(setup),
      })
    } catch { return false }
    session.setup = Object.freeze(clone(setup))
    session.definitions = Object.freeze(definitions.map(clone))
    return true
  }

  private handle(owner: PluginOwnerIdentity, record: AgentRecord): AgentHandle {
    let handle!: AgentHandle
    const value = Object.freeze({
      agent: this.agent(owner, record), owner: clone(owner),
      dispose: async (options?: AgentDisposeOptions): Promise<AgentMutationResult<'dispose'>> => {
        if (this.handleCapabilities.get(handle as object) !== record || !this.current(record)) return this.mutation('dispose', options?.mutationId, 'unavailable', 'agent-replaced')
        if (!this.sameOwner(owner, record.owner)) return this.mutation('dispose', options?.mutationId, 'denied', 'not-owner')
        this.disposeAgent(record, 'owner-disposed')
        return this.mutation('dispose', options?.mutationId, 'accepted')
      },
    })
    handle = value as AgentHandle
    this.handleCapabilities.set(handle as object, record)
    return handle
  }

  private disposeAgent(record: AgentRecord, reason: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced'): void {
    if (record.disposed !== undefined) return
    record.disposed = reason
    this.answerers.delete(this.answererKey(record))
    this.emitLive(record, 'agent/disposed', { reason })
    for (const subscriber of record.live) subscriber.closed = reason === 'connection-replaced' ? 'connection-replaced' : 'agent-replaced'
    record.live.clear()
    for (const resolve of record.idleWaiters) resolve({ status: 'unavailable', code: reason === 'connection-replaced' ? 'connection-replaced' : 'agent-replaced' })
    record.idleWaiters.clear()
  }

  private closeSession(record: SessionRecord, code: NonNullable<SessionRecord['closed']>, subscriberCode: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'> = code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable'): void {
    if (record.closed !== undefined) return
    record.closed = code
    for (const subscriber of record.subscribers) this.closeSubscriber(record, subscriber, subscriberCode)
    record.subscribers.clear()
  }

  private connectionReplaced(): void {
    for (const agent of this.agents.values()) this.disposeAgent(agent, 'connection-replaced')
    for (const session of this.sessions.values()) this.closeSession(session, 'connection-replaced')
  }

  private async deliver(subscriber: SessionSubscriber, page: Parameters<SessionEventObserver>[0]): Promise<void> {
    subscriber.delivery = subscriber.delivery.then(async () => {
      if (subscriber.closed !== undefined) return
      try { await subscriber.observer(page) }
      catch { this.closeSubscriberByIdentity(subscriber, 'observer-failed') }
    })
    await subscriber.delivery
  }

  private closeSubscriber(record: SessionRecord, subscriber: SessionSubscriber, code: SessionSubscriptionCloseCode): SessionSubscriptionClosed {
    if (subscriber.closed !== undefined) return subscriber.closed
    const closed: SessionSubscriptionClosed = Object.freeze({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-close.v1.schema.json',
      contract: 'cordisx.session-subscription-close/v1', schemaVersion: 1,
      sessionId: record.id, sessionGeneration: record.generation, subscriptionGeneration: subscriber.generation,
      status: 'closed', code,
    })
    subscriber.closed = closed
    record.subscribers.delete(subscriber)
    subscriber.resolveClosed(closed)
    return closed
  }

  private closeSubscriberByIdentity(subscriber: SessionSubscriber, code: SessionSubscriptionCloseCode): void {
    for (const session of this.sessions.values()) {
      if (session.subscribers.has(subscriber)) { this.closeSubscriber(session, subscriber, code); return }
    }
  }

  private emitLive<K extends AgentLiveEvent['type']>(record: AgentRecord, type: K, data: Extract<AgentLiveEvent, { readonly type: K }>['data']): void {
    const event = Object.freeze({ type, agentId: record.id, sessionId: record.id, agentGeneration: record.generation, time: this.now(), data: clone(data) }) as AgentLiveEvent
    for (const subscriber of [...record.live]) if (subscriber.closed === undefined) void subscriber.observer(clone(event))
  }

  private recordForAgent(value: Agent): AgentRecord | undefined {
    const record = this.agentCapabilities.get(value as object)
    return record !== undefined && record.generation === value.generation && this.current(record) ? record : undefined
  }
  private current(record: AgentRecord): boolean { return !this.disposed && record.disposed === undefined && this.agents.get(record.id) === record && this.sessionLive(record.session) }
  private sessionLive(record: SessionRecord): boolean { return !this.disposed && record.closed === undefined && this.sessions.get(record.id) === record }
  private sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean { return left.pluginId === right.pluginId && left.generation === right.generation }
  private sameSource(owner: PluginOwnerIdentity, source: UserMessage['source']): boolean { return source.kind === 'plugin' && source.pluginId === owner.pluginId && source.generation === owner.generation }
  private async allowed(owner: PluginOwnerIdentity, capability: AgentRuntimeCapability, sessionId?: string): Promise<boolean> { return !this.disposed && await this.options.authorize(owner, capability, sessionId) }
  private answererKey(record: AgentRecord): string { return `${record.id}\u0000${record.generation}` }
  private acquireDenied(operation: 'create' | 'resume', mutationId?: string): AgentAcquireResult { return { $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'denied', code: 'permission-denied' } }
  private acquireUnavailable(operation: 'create' | 'resume', mutationId: string | undefined, code: 'runtime-unavailable' | 'host-unavailable' | 'unsupported' | 'session-unavailable'): AgentAcquireResult { return { $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'unavailable', code: code === 'session-unavailable' ? 'session-unavailable' : code } }
  private acquireConflict(operation: 'create' | 'resume', mutationId: string | undefined, code: 'mutation-conflict' | 'session-already-exists' | 'agent-already-live'): AgentAcquireResult { return { $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'conflict', code } }
  private entityAcquireResult(
    envelope: EntityAcquireEnvelope,
    result: AgentAcquireResult,
    resolution: EntityDefinitionResolution,
    definitionSource: 'registry-current' | 'session-persisted',
  ): EntityAgentAcquireResult {
    if (result.status !== 'accepted') return { ...envelope, status: result.status, code: result.code } as EntityAgentAcquireResult
    return Object.freeze({
      ...envelope, status: 'accepted', sessionId: result.sessionId, agentGeneration: result.agentGeneration,
      sessionGeneration: result.sessionGeneration, owner: clone(result.owner), sessionIdSource: result.sessionIdSource,
      disposition: result.disposition, ...(result.handle.agent.detail === undefined ? {} : { details: clone(result.handle.agent.detail) }),
      definitionResolution: clone(resolution), definitionSource, handle: result.handle,
    }) as EntityAgentAcquireResult
  }
  private replayEntityMutation(
    owner: PluginOwnerIdentity,
    envelope: EntityAcquireEnvelope,
    input: EntityAgentCreateOptions | EntityAgentResumeOptions,
  ): EntityAgentAcquireResult | undefined {
    if (input.mutationId === undefined) return undefined
    const prior = this.entityMutations.get(`${ownerKey(owner)}\u0000${envelope.operation}\u0000${input.mutationId}`)
    if (prior === undefined) return undefined
    if (prior.fingerprint !== JSON.stringify(clone(input))) return { ...envelope, status: 'conflict', code: 'mutation-conflict' }
    const record = this.handleCapabilities.get(prior.result.handle as object)
    return record !== undefined && this.current(record)
      ? Object.freeze({ ...prior.result, disposition: 'replayed' })
      : { ...envelope, status: 'unavailable', code: 'host-unavailable' }
  }
  private rememberEntityMutation(
    owner: PluginOwnerIdentity,
    input: EntityAgentCreateOptions | EntityAgentResumeOptions,
    result: EntityAgentAcquireResult,
  ): EntityAgentAcquireResult {
    if (input.mutationId !== undefined && result.status === 'accepted') this.entityMutations.set(
      `${ownerKey(owner)}\u0000${result.operation}\u0000${input.mutationId}`,
      { fingerprint: JSON.stringify(clone(input)), result },
    )
    return result
  }
  private remember(key: string | undefined, fingerprint: string, result: AgentAcquireResult): AgentAcquireResult { if (key !== undefined) this.mutations.set(key, { fingerprint, result }); return result }
  private admission(messageId: string, status: 'accepted' | 'denied' | 'unavailable', code?: 'source-denied' | 'permission-denied' | 'agent-replaced' | 'host-unavailable'): Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never { return Object.freeze({ $schema: ADMISSION_SCHEMA, contract: 'cordisx.agent-admission/v1', schemaVersion: 1, status, messageId, ...(status === 'accepted' ? {} : { code }) }) as never }
  private discard(messageId: string, status: AgentMessageDiscardResult['status'], code?: string): AgentMessageDiscardResult { return Object.freeze({ $schema: DISCARD_SCHEMA, contract: 'cordisx.agent-message-cancellation-result/v1', schemaVersion: 1, status, messageId, ...(code === undefined ? {} : { code }) }) as AgentMessageDiscardResult }
  private mutation(operation: 'cancel' | 'dispose', mutationId: string | undefined, status: 'accepted' | 'denied' | 'unavailable', code?: string): AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'> { return Object.freeze({ $schema: MUTATION_SCHEMA, contract: 'cordisx.agent-mutation-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status, ...(code === undefined ? {} : { code }) }) as AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'> }
  private approvalQuestion(record: AgentRecord, id: string, toolName: string, callId?: string, reason?: string): ApprovalQuestion { return Object.freeze({ $schema: QUESTION_SCHEMA, contract: 'cordisx.approval-question/v1', schemaVersion: 1, id, agentId: record.id, sessionId: record.id, agentGeneration: record.generation, toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }) }) }
  private approvalDecision(record: AgentRecord | Agent, id: string, toolName: string, callId: string | undefined, outcome: ApprovalOutcome): ApprovalDecision { return Object.freeze({ $schema: DECISION_SCHEMA, contract: 'cordisx.approval-decision/v1', schemaVersion: 1, id, agentId: record.id, sessionId: record.session.id, agentGeneration: record.generation, outcome }) }
}

const runtimes = new WeakMap<object, CordisXAgentSessionRuntime>()
function runtimeFor(service: object): CordisXAgentSessionRuntime { const runtime = runtimes.get(service); if (runtime === undefined) throw new Error('Agent Session runtime service is detached'); return runtime }

export class CordisXAgentRegistryServiceV1 extends Service implements EntityBackedAgentRegistry {
  private readonly entities: EntityRegistry | undefined
  constructor(ctx: Context, input: CordisXAgentSessionRuntime | { readonly runtime: CordisXAgentSessionRuntime; readonly entities: EntityRegistry }) {
    super(ctx, 'agents')
    const runtime = input instanceof CordisXAgentSessionRuntime ? input : input.runtime
    this.entities = input instanceof CordisXAgentSessionRuntime ? undefined : input.entities
    runtimes.set(this, runtime)
  }
  create: EntityBackedAgentRegistry['create'] = (async (options: AgentCreateOptions | EntityAgentCreateOptions): Promise<AgentAcquireResult | EntityAgentAcquireResult> => {
    const runtime = runtimeFor(this); const owner = runtime.ownerFromContext(this.ctx)
    return 'definition' in options && (options as { readonly setup?: unknown }).setup === undefined && this.entities !== undefined
      ? await runtime.createEntity(owner, options as EntityAgentCreateOptions, this.entities)
      : await runtime.create(owner, options as AgentCreateOptions)
  }) as EntityBackedAgentRegistry['create']
  resume: EntityBackedAgentRegistry['resume'] = (async (options: AgentResumeOptions | EntityAgentResumeOptions): Promise<AgentAcquireResult | EntityAgentAcquireResult> => {
    const runtime = runtimeFor(this); const owner = runtime.ownerFromContext(this.ctx)
    return 'definitionSource' in options && this.entities !== undefined
      ? await runtime.resumeEntity(owner, options as EntityAgentResumeOptions)
      : await runtime.resume(owner, options as AgentResumeOptions)
  }) as EntityBackedAgentRegistry['resume']
  get = async (agentId: string): Promise<Agent | undefined> => { const runtime = runtimeFor(this); return await runtime.get(runtime.ownerFromContext(this.ctx), agentId) }
  acquireLegacyTaskBinding = async (request: CordisXAgentSessionLegacyAcquireRequestV1): Promise<CordisXAgentSessionLegacyAcquireResultV1> => { const runtime = runtimeFor(this); return await runtime.acquireLegacyTaskBinding(runtime.ownerFromContext(this.ctx), request) }
}
export class CordisXSessionRegistryServiceV1 extends Service implements SessionRegistry {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) { super(ctx, 'sessions'); runtimes.set(this, runtime) }
  get = async (sessionId: string): Promise<Session | undefined> => { const runtime = runtimeFor(this); return await runtime.session(runtime.ownerFromContext(this.ctx), sessionId) }
}
export class CordisXApprovalServiceV1 extends Service implements ApprovalService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) { super(ctx, 'approvals'); runtimes.set(this, runtime) }
  request = async (request: Parameters<ApprovalService['request']>[0]): Promise<ApprovalDecision> => { const runtime = runtimeFor(this); return await runtime.requestApproval(runtime.ownerFromContext(this.ctx), request) }
  registerAnswerer = async (agent: Agent, answerer: ApprovalAnswerer): Promise<ApprovalAnswererHandle> => { const runtime = runtimeFor(this); return await runtime.registerAnswerer(runtime.ownerFromContext(this.ctx), agent, answerer) }
}
