import type { AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentAcquireResult,
  AgentAdmission,
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
  ApprovalAnswerer as ApprovalAnswererV1,
  ApprovalAnswererHandle as ApprovalAnswererHandleV1,
  ApprovalDecision as ApprovalDecisionV1,
  ApprovalQuestion as ApprovalQuestionV1,
  ApprovalService as ApprovalServiceV1,
} from '@cordisx/protocol/approval/v1'
import type {
  ApprovalAgentBinding,
  ApprovalAgentTarget,
  ApprovalAnswerer as ApprovalAnswererV2,
  ApprovalAuthorityAnswererHandle,
  ApprovalDecision as ApprovalDecisionV2,
  ApprovalQuestion as ApprovalQuestionV2,
  ApprovalRequest as ApprovalRequestV2,
  ApprovalService as ApprovalServiceV2,
} from '@cordisx/protocol/approval/v2'
import type {
  ApprovalRequestResolver,
  ApprovalRequestResolverClosed,
  ApprovalRequestResolverHandle,
  ApprovalRequestResolverRegisterResult,
  ApprovalRequestRoutingQuestion,
  ApprovalRequestRoutingRegistration,
  ApprovalRequestRoutingResult,
  ApprovalService as ApprovalServiceV3,
} from '@cordisx/protocol/approval/v3'
import type {
  AgentCancelCause,
  ApprovalOutcome,
  MessageId,
  PluginOwnerIdentity,
  Session,
  SessionEvent,
  SessionEventDataMap,
  SessionEventObserver,
  SessionHeader,
  SessionId,
  SessionReadRequest,
  SessionRegistry,
  SessionSnapshotResult,
  SessionSubscribeRequest,
  SessionSubscribeResult,
  SessionSubscription,
  SessionSubscriptionCloseCode,
  SessionSubscriptionClosed,
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
import type {
  AgentAdmissionReservationRequest,
  AgentAdmissionReservationResult,
  AgentAdmissionReservationService,
  AgentCommandOrigin,
} from '@cordisx/protocol/agent-admission/v2'
import type {
  AgentAdmissionTarget,
  AgentAdmissionTargetOrigin,
  AgentAdmissionTargetOriginRequest,
  AgentAdmissionTargetOriginResult,
  AgentAdmissionTargetOriginService,
  AgentAdmissionTargetReservationRequest,
  AgentAdmissionTargetReservationResult,
  AgentAdmissionTargetReservationService,
} from '@cordisx/protocol/agent-admission/v3'
import type {
  AgentAdmissionBootstrapReservationRequest,
  AgentAdmissionBootstrapReservationResult,
  AgentAdmissionBootstrapReservationService,
  AgentAdmissionBootstrapTargetOrigin,
  AgentAdmissionBootstrapTargetRequest,
  AgentAdmissionBootstrapTargetResult,
  AgentAdmissionBootstrapTargetService,
  AgentBootstrapCommandOrigin,
} from '@cordisx/protocol/agent-admission/v4'
import type {
  AgentAdmissionBootstrapRoomReservationRequest,
  AgentAdmissionBootstrapRoomReservationResult,
  AgentAdmissionBootstrapRoomReservationService,
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetOrigin,
  AgentAdmissionBootstrapRoomTargetReceipt,
  AgentAdmissionBootstrapRoomTargetRequest,
  AgentAdmissionBootstrapRoomTargetResult,
  AgentAdmissionBootstrapRoomTargetService,
} from '@cordisx/protocol/agent-admission/v5'
import type {
  AgentAdmissionBootstrapRouteClaimReceipt,
  AgentAdmissionBootstrapRouteClaimRequest,
  AgentAdmissionBootstrapRouteClaimResult,
  AgentAdmissionBootstrapRouteContinuation,
  AgentAdmissionBootstrapRouteDeclarationRequest,
  AgentAdmissionBootstrapRouteDeclarationResult,
  AgentAdmissionBootstrapRouteDeclarationService,
  AgentAdmissionBootstrapRouteReservationRequest,
  AgentAdmissionBootstrapRouteReservationResult,
  AgentAdmissionBootstrapRouteReservationService,
  AgentAdmissionBootstrapRouteTarget,
} from '@cordisx/protocol/agent-admission/v6'
import type {
  AgentPageAdmissionReservationRequest,
  AgentPageAdmissionReservationResult,
  AgentPageAdmissionReservationService,
  AgentPageAdmissionRouteClaimReceipt,
  AgentPageAdmissionRouteClaimResult,
  AgentPageAdmissionRouteContinuation,
  AgentPageAdmissionRouteDeclarationRequest,
  AgentPageAdmissionRouteDeclarationResult,
  AgentPageAdmissionRouteDeclarationService,
  AgentPageAdmissionRouteReservationRequest,
  AgentPageAdmissionRouteReservationResult,
  AgentPageAdmissionRouteReservationService,
  AgentPageAdmissionRouteTarget,
  AgentPageAdmissionTarget,
  AgentPageAdmissionTargetOrigin,
  AgentPageAdmissionTargetReceipt,
  AgentPageAdmissionTargetRequest,
  AgentPageAdmissionTargetResult,
  AgentPageAdmissionTargetService,
  AgentPageComposerCommandContext,
  AgentPageComposerCommandResult,
  AgentPageComposerOrigin,
  AgentPageFreshRoomNavigation,
  AgentPageFreshRoomNavigationRequest,
  AgentPageFreshRoomNavigationResult,
  AgentPageFreshRoomNavigationService,
  AgentPageRoomRoute,
} from '@cordisx/protocol/agent-page-admission/v2'
import type {
  AgentDetailNavigationRequest,
  AgentDetailNavigationResult,
  AgentDetailNavigationService,
  AgentSessionDetailReferenceRequest,
  AgentSessionDetailReferenceResult,
  AgentSessionDetailReferenceService,
} from '@cordisx/protocol/agent-detail-navigation/v1'
import type { PluginApprovalAuthorityLeaseV8 } from '@cordisx/protocol/plugin-manifest/v8'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { generationFromContext } from './ownership.js'
import {
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  type CordisXAgentRegistryV1,
  type CordisXAgentSessionLegacyAcquireRequestV1,
  type CordisXAgentSessionLegacyAcquireResultV1,
} from '../agent-session-migration-contracts.js'
import { type CordisXResolvedAgentDefinition, resolveAgentDefinitionCatalog } from './agent-loop.js'
import { type CordisXAgentDefinitionPresentation, presentationForDefinition } from './agent-loop-v4.js'
import type { PlaygroundScenarioSubmissionCapture } from './playground-scenario-session-scope.js'
import {
  type PageAdmissionBinding,
  PageAdmissionBindingRegistry,
  type PageAdmissionCommand,
  type PageAdmissionCommandCompletion,
  type PageAdmissionDestinationRoute as HostPageAdmissionDestinationRoute,
  type PageAdmissionRoute as HostPageAdmissionRoute,
  type PageAdmissionSourceCapture,
  type PageAdmissionTarget as HostPageAdmissionTarget,
} from './page-admission-lifecycle.js'
import {
  AcceptedEntityAcquire,
  ACQUIRE_SCHEMA,
  AgentRecord,
  AgentSubscriber,
  AnswererRecord,
  AuthorityAnswererRecord,
  clone,
  CordisXAgentSessionProjection,
  CordisXAgentSessionRuntimeOptions,
  CordisXDriverAgentStatus,
  CordisXDriverApprovalRequest,
  CordisXDriverMessageClaimed,
  CordisXDriverSessionEvent,
  CordisXLegacyAgentLoopBindingResolution,
  CordisXLegacyAgentLoopBindingResolver,
  ENTITY_ACQUIRE_SCHEMA,
  EntityAcquireEnvelope,
  opaque,
  ownerKey,
  PageAdmissionCommandRecord,
  PageAdmissionTargetRecord,
  RequestResolverRecord,
  SessionEventInput,
  SessionRecord,
  SessionSubscriber,
  SUBSCRIPTION_SCHEMA,
} from './agent-session-runtime-types.js'

export abstract class AgentSessionRuntimeCore {
  protected readonly sessions = new Map<string, SessionRecord>()

  protected readonly agents = new Map<string, AgentRecord>()

  protected readonly agentCapabilities = new WeakMap<object, AgentRecord>()

  protected readonly handleCapabilities = new WeakMap<object, AgentRecord>()

  protected readonly answerers = new Map<string, AnswererRecord>()

  protected readonly authorityAnswerers = new Map<string, AuthorityAnswererRecord>()

  protected readonly requestResolvers = new Map<string, RequestResolverRecord>()

  protected readonly routeRequiredRequesters = new Set<string>()

  protected readonly mutations = new Map<
    string,
    { readonly fingerprint: string; readonly result: AgentAcquireResult }
  >()

  protected readonly entityMutations = new Map<
    string,
    { readonly fingerprint: string; readonly result: AcceptedEntityAcquire }
  >()

  protected nextAgentGeneration = 0

  protected nextSubscriptionGeneration = 0

  protected nextOwnerGeneration = 0

  protected connectionGeneration = 1

  protected readonly ownerGenerations = new Map<string, number>()

  protected readonly legacyResolvers = new Map<
    string,
    { readonly token: object; readonly resolve: CordisXLegacyAgentLoopBindingResolver }
  >()

  protected readonly legacyMutations = new Map<
    string,
    { readonly fingerprint: string; readonly result: CordisXAgentSessionLegacyAcquireResultV1 }
  >()

  protected readonly reservedAdmissionOrigins = new Set<string>()

  protected readonly targetAdmissionOrigins = new Map<
    string,
    Readonly<{
      owner: PluginOwnerIdentity
      origin: AgentCommandOrigin
      target: AgentAdmissionTarget
      reserved: boolean
    }>
  >()

  protected readonly issuedAdmissionTargets = new Set<string>()

  protected readonly bootstrapAdmissionTargets = new Map<
    string,
    Readonly<{
      owner: PluginOwnerIdentity
      origin: AgentBootstrapCommandOrigin
      target: AgentAdmissionTarget
      connectionGeneration: number
      reserved: boolean
      handleId?: string
      handleGeneration?: number
    }>
  >()

  protected readonly issuedBootstrapAdmissionTargets = new Set<string>()

  protected readonly bootstrapAdmissionRoomTargets = new Map<
    string,
    Readonly<{
      owner: PluginOwnerIdentity
      origin: AgentBootstrapCommandOrigin
      target: AgentAdmissionBootstrapRoomTarget
      receipt: AgentAdmissionBootstrapRoomTargetReceipt
      connectionGeneration: number
      reserved: boolean
      handleId?: string
      handleGeneration?: number
      capture?: PlaygroundScenarioSubmissionCapture
    }>
  >()

  protected readonly issuedBootstrapAdmissionRoomTargets = new Set<string>()

  protected readonly bootstrapAdmissionRoomRooms = new Map<string, string>()

  protected readonly bootstrapAdmissionRouteContinuations = new Map<
    string,
    Readonly<{
      owner: PluginOwnerIdentity
      origin: AgentBootstrapCommandOrigin
      target: AgentAdmissionBootstrapRouteTarget
      continuation: AgentAdmissionBootstrapRouteContinuation
      connectionGeneration: number
      reserved: boolean
      submitted: boolean
      claimed: boolean
      revoked: boolean
      handleId?: string
      handleGeneration?: number
      sourceSessionId?: string
      sourceMessageId?: MessageId
      capture?: PlaygroundScenarioSubmissionCapture
    }>
  >()

  protected readonly issuedBootstrapAdmissionRouteTargets = new Set<string>()

  protected readonly bootstrapAdmissionRouteRooms = new Map<string, string>()

  protected readonly pageAdmissionCommands = new Map<string, PageAdmissionCommandRecord>()

  protected readonly pageAdmissionTargets = new Map<string, PageAdmissionTargetRecord>()

  protected disposed = false

  protected readonly unsubscribeReplacement: () => void

  protected readonly unsubscribeDriverEvents: () => void

  protected readonly unsubscribeDriverApprovals: () => void

  protected readonly unsubscribeDriverStatus: () => void

  protected readonly unsubscribeDriverClaimed: () => void

  protected readonly now: () => number

  constructor(protected readonly options: CordisXAgentSessionRuntimeOptions) {
    this.now = options.now ?? (() => Date.now())
    for (const persisted of options.initialSessions ?? []) {
      if (
        !opaque(persisted.id) || persisted.generation < 1 || persisted.header.id !== persisted.id
        || persisted.events.some((event, index) => event.sessionId !== persisted.id || event.seq !== index)
      ) {
        throw new Error('Recovered Agent Session ledger is invalid')
      }
      if (this.sessions.has(persisted.id)) {
        throw new Error('Recovered Agent Session ledger contains a duplicate SessionId')
      }
      let definitions: readonly CordisXResolvedAgentDefinition[] | undefined
      if (persisted.setup !== undefined) {
        try {
          definitions = resolveAgentDefinitionCatalog(persisted.setup).definitions
        } catch {
          throw new Error('Recovered Agent Session setup is invalid')
        }
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
    this.unsubscribeDriverApprovals =
      options.driver.onApprovalRequest?.(async request => await this.requestDriverApproval(request)) ?? (() => {})
    this.unsubscribeDriverStatus = options.driver.onAgentStatus?.(event => this.emitDriverStatus(event)) ?? (() => {})
    this.unsubscribeDriverClaimed = options.driver.onMessageClaimed?.(event => {
      void this.claimDriverMessage(event)
    }) ?? (() => {})
  }

  ownerFromContext(ctx: Context): PluginOwnerIdentity {
    const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
    const pluginId = scoped[CORDISX_PLUGIN_ID]
    const source = scoped[CORDISX_PLUGIN_SOURCE]
    if (pluginId === undefined || source === undefined) {
      throw new Error('Agent runtime requires a Host-bound plugin context')
    }
    return this.ownerForPlugin(source, pluginId, generationFromContext(ctx) ?? 'host')
  }

  ownerForPlugin(source: string, pluginId: string, moduleGeneration: string): PluginOwnerIdentity {
    const key = `${source}\u0000${pluginId}\u0000${moduleGeneration}`
    let generation = this.ownerGenerations.get(key)
    if (generation === undefined) {
      generation = ++this.nextOwnerGeneration
      this.ownerGenerations.set(key, generation)
    }
    return Object.freeze({ pluginId: `${source}:${pluginId}`, generation })
  }

  async authorizeTask(
    owner: PluginOwnerIdentity,
    operation: 'create' | 'read' | 'approval',
    sessionId?: string,
  ): Promise<boolean> {
    const capabilities: AgentRuntimeCapability[] = operation === 'approval'
      ? ['approvals.request', 'approvals.answer']
      : operation === 'create'
      ? ['agents.create', 'agents.message.submit', 'agents.get']
      : ['agents.get']
    if (this.disposed) return false
    // Before a task has been looked up/reserved, check declaration availability only.
    // The task transaction must still authorize the exact Session before any effect.
    if (sessionId === undefined) {
      return capabilities.every(capability => this.options.declares?.(owner, capability) === true)
    }
    for (const capability of capabilities) if (!await this.allowed(owner, capability, sessionId)) return false
    return true
  }

  async create(owner: PluginOwnerIdentity, input: AgentCreateOptions): Promise<AgentAcquireResult> {
    const sessionId = input.sessionId ?? `cx-session.${crypto.randomUUID()}`
    if (!opaque(sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.create', sessionId)) return this.acquireDenied('create', input.mutationId)
    return await this.acquire(owner, 'create', sessionId, input, input.sessionId === undefined ? 'host' : 'caller')
  }

  async resume(owner: PluginOwnerIdentity, input: AgentResumeOptions): Promise<AgentAcquireResult> {
    if (!opaque(input.sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.resume', input.sessionId)) {
      return this.acquireDenied('resume', input.mutationId)
    }
    return await this.acquire(owner, 'resume', input.sessionId, input, 'caller')
  }

  async createEntity(
    owner: PluginOwnerIdentity,
    input: EntityAgentCreateOptions,
    registry: EntityRegistry,
    executionContext?: AgentTaskResolvedContext,
  ): Promise<EntityAgentAcquireResult> {
    const sessionId = input.sessionId ?? `cx-session.${crypto.randomUUID()}`
    const envelope = {
      $schema: ENTITY_ACQUIRE_SCHEMA,
      contract: 'cordisx.entity-agent-acquire-result/v1' as const,
      schemaVersion: 1 as const,
      operation: 'create' as const,
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
    }
    if (!opaque(sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.create', sessionId)) {
      return { ...envelope, status: 'denied', code: 'permission-denied' }
    }
    const prior = this.replayEntityMutation(owner, envelope, input)
    if (prior !== undefined) return prior
    const target = await registry.get(input.definition)
    if (target.status === 'unavailable') return { ...envelope, status: 'unavailable', code: 'host-unavailable' }
    if (target.status === 'not-found') {
      const snapshot = await registry.snapshot().catch(() => undefined)
      const current = snapshot?.entities.find(entity => entity.identity.agentId === input.definition.agentId)
      return {
        ...envelope,
        status: 'unavailable',
        code: current === undefined ? 'entity-not-found' : 'entity-revision-stale',
      }
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
    const setup: AgentSetup = {
      definition: clone(target.entity.identity),
      definitions: definitions as [typeof definitions[number], ...typeof definitions[number][]],
    }
    const binding: EntitySessionDefinitionBinding = {
      source: 'entity-registry',
      owner: clone(target.entity.owner),
      resolution: {
        identity: clone(target.entity.identity),
        digest: target.entity.digest,
        definition: clone(target.entity.definition),
      },
    }
    const acquireInput: AgentCreateOptions = {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
      ...(input.options === undefined ? {} : { options: clone(input.options) }),
      setup,
    }
    const acquired = await this.acquire(
      owner,
      'create',
      sessionId,
      acquireInput,
      input.sessionId === undefined ? 'host' : 'caller',
      false,
      binding,
      executionContext,
    )
    const result = this.entityAcquireResult(envelope, acquired, {
      identity: clone(target.entity.identity),
      digest: target.entity.digest,
      definition: clone(target.entity.definition),
    }, 'registry-current')
    return this.rememberEntityMutation(owner, input, result)
  }

  async resumeEntity(owner: PluginOwnerIdentity, input: EntityAgentResumeOptions): Promise<EntityAgentAcquireResult> {
    const envelope = {
      $schema: ENTITY_ACQUIRE_SCHEMA,
      contract: 'cordisx.entity-agent-acquire-result/v1' as const,
      schemaVersion: 1 as const,
      operation: 'resume' as const,
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
    }
    if (!opaque(input.sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.resume', input.sessionId)) {
      return { ...envelope, status: 'denied', code: 'permission-denied' }
    }
    const prior = this.replayEntityMutation(owner, envelope, input)
    if (prior !== undefined) return prior
    const session = this.sessions.get(input.sessionId)
    if (session === undefined) return { ...envelope, status: 'unavailable', code: 'session-unavailable' }
    const event = session.events.find(candidate => candidate.type === 'entity/definition-bound')
    if (event === undefined || event.type !== 'entity/definition-bound') {
      return { ...envelope, status: 'unavailable', code: 'unsupported' }
    }
    const binding = event.data
    if (
      input.definition !== undefined && (input.definition.agentId !== binding.resolution.identity.agentId
        || input.definition.revision !== binding.resolution.identity.revision)
    ) return { ...envelope, status: 'unavailable', code: 'entity-revision-stale' }
    const acquireInput: AgentResumeOptions = {
      sessionId: input.sessionId,
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
      ...(input.options === undefined ? {} : { options: clone(input.options) }),
    }
    const acquired = await this.acquire(owner, 'resume', input.sessionId, acquireInput, 'caller')
    return this.rememberEntityMutation(
      owner,
      input,
      this.entityAcquireResult(envelope, acquired, binding.resolution, 'session-persisted'),
    )
  }

  async get(owner: PluginOwnerIdentity, agentId: string): Promise<Agent | undefined> {
    if (!opaque(agentId) || !await this.allowed(owner, 'agents.get', agentId)) return undefined
    const record = this.agents.get(agentId)
    return record === undefined || record.disposed !== undefined ? undefined : this.agent(owner, record)
  }

  definitionPresentation(
    identity: { readonly agentId: string; readonly revision: string },
  ): CordisXAgentDefinitionPresentation | undefined {
    let selected: {
      readonly live: boolean
      readonly generation: number
      readonly definition: CordisXResolvedAgentDefinition
    } | undefined
    for (const record of this.agents.values()) {
      if (!this.current(record)) continue
      const definition = record.definitions?.find(candidate =>
        candidate.identity.agentId === identity.agentId
        && candidate.identity.revision === identity.revision
      )
      if (definition === undefined) continue
      if (selected === undefined || !selected.live || record.generation > selected.generation) {
        selected = { live: true, generation: record.generation, definition }
      }
    }
    for (const session of this.sessions.values()) {
      if (!this.sessionLive(session)) continue
      const definition = session.definitions?.find(candidate =>
        candidate.identity.agentId === identity.agentId
        && candidate.identity.revision === identity.revision
      )
      if (definition === undefined || selected?.live === true) continue
      if (selected === undefined || session.generation > selected.generation) {
        selected = { live: false, generation: session.generation, definition }
      }
    }
    return selected === undefined ? undefined : presentationForDefinition(selected.definition)
  }

  ownerForSession(sessionId: string): PluginOwnerIdentity | undefined {
    const record = this.agents.get(sessionId)
    return record === undefined || !this.current(record) ? undefined : Object.freeze(clone(record.owner))
  }

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
            ...(currentAgent.definitions === undefined
              ? {}
              : { definitions: Object.freeze(currentAgent.definitions.map(clone)) }),
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
    if (
      request.$schema !== CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1
      || request.contract !== CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1
      || request.schemaVersion !== 1 || !opaque(request.mutationId)
      || request.binding.contract !== 'cordisx.agent-loop-task-binding/v4'
      || request.binding.schemaVersion !== 4 || request.binding.state !== 'active'
    ) {
      return Object.freeze({
        ...envelope,
        status: 'unavailable',
        code: request.binding?.state === 'closed' ? 'binding-closed' : 'unsupported',
      })
    }
    const mutationKey = `${ownerKey(owner)}\u0000legacy-acquire\u0000${request.mutationId}`
    const fingerprint = JSON.stringify(clone(request))
    const prior = this.legacyMutations.get(mutationKey)
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return Object.freeze({ ...envelope, status: 'conflict', code: 'mutation-conflict' })
      }
      if (prior.result.status !== 'accepted') return prior.result
      const record = this.handleCapabilities.get(prior.result.acquire.handle as object)
      if (record === undefined || !this.current(record)) {
        return Object.freeze({
          ...envelope,
          status: 'unavailable',
          code: record?.disposed === 'connection-replaced' ? 'connection-replaced' : 'plugin-generation-replaced',
        })
      }
      return Object.freeze({
        ...prior.result,
        acquire: Object.freeze({ ...prior.result.acquire, disposition: 'replayed' as const }),
      })
    }
    const rememberLegacy = <Result extends CordisXAgentSessionLegacyAcquireResultV1>(result: Result): Result => {
      this.legacyMutations.set(mutationKey, { fingerprint, result })
      return result
    }
    const resolver = this.legacyResolvers.get(owner.pluginId)
    if (resolver === undefined) {
      return rememberLegacy(Object.freeze({ ...envelope, status: 'unavailable', code: 'plugin-generation-replaced' }))
    }
    let resolution: CordisXLegacyAgentLoopBindingResolution
    try {
      resolution = await resolver.resolve(clone(request.binding))
    } catch {
      resolution = { status: 'unavailable', code: 'host-unavailable' }
    }
    if (resolution.status !== 'resolved' || !opaque(resolution.sessionId)) {
      return rememberLegacy(
        Object.freeze({
          ...envelope,
          status: 'unavailable',
          code: resolution.status === 'resolved' ? 'binding-unresolved' : resolution.code,
        }),
      )
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
    if (acquire.status === 'accepted') {
      return rememberLegacy(
        Object.freeze({
          ...envelope,
          status: 'accepted',
          sessionId: resolution.sessionId,
          identitySource: 'agent-loop-authority',
          acquire,
        }),
      )
    }
    if (acquire.status === 'denied') {
      return rememberLegacy(Object.freeze({ ...envelope, status: 'denied', code: 'permission-denied' }))
    }
    if (acquire.status === 'conflict') {
      return rememberLegacy(
        Object.freeze({
          ...envelope,
          status: 'conflict',
          code: acquire.code === 'session-already-exists' ? 'agent-already-live' : acquire.code,
        }),
      )
    }
    return rememberLegacy(
      Object.freeze({
        ...envelope,
        status: 'unavailable',
        code: acquire.code === 'runtime-unavailable' || acquire.code === 'session-unavailable'
          ? 'host-unavailable'
          : acquire.code,
      }),
    )
  }

  protected async append<K extends SessionEvent['type']>(
    session: SessionRecord,
    type: K,
    data: Extract<SessionEvent, { readonly type: K }>['data'],
    ignorable?: true,
  ): Promise<boolean> {
    return await this.appendMany(session, [
      { type, data, ...(ignorable === true ? { ignorable: true as const } : {}) } as SessionEventInput,
    ])
  }

  protected async appendMany(session: SessionRecord, inputs: readonly SessionEventInput[]): Promise<boolean> {
    if (inputs.length === 0) return true
    let accepted = false
    const operation = session.appendQueue.then(async () => {
      if (!this.sessionLive(session)) return
      const expectedSeq = session.events.length
      const events = inputs.map((input, index) =>
        Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json' as const,
          contract: 'cordisx.session-event/v1' as const,
          schemaVersion: 1 as const,
          sessionId: session.id,
          seq: expectedSeq + index,
          time: this.now(),
          type: input.type,
          data: clone(input.data),
          ...('ignorable' in input && input.ignorable === true ? { ignorable: true as const } : {}),
        }) as SessionEvent
      )
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
          void this.deliver(subscriber, {
            $schema: SUBSCRIPTION_SCHEMA,
            contract: 'cordisx.session-subscription-page/v1',
            schemaVersion: 1,
            sessionId: session.id,
            sessionGeneration: session.generation,
            subscriptionGeneration: subscriber.generation,
            replayThrough: subscriber.replayThrough,
            phase: 'live',
            events: [clone(event)],
          })
        }
      }
    })
    session.appendQueue = operation.catch(() => undefined)
    await session.appendQueue
    return accepted
  }

  protected emitLive<K extends AgentLiveEvent['type']>(
    record: AgentRecord,
    type: K,
    data: Extract<AgentLiveEvent, { readonly type: K }>['data'],
  ): void {
    const event = Object.freeze({
      type,
      agentId: record.id,
      sessionId: record.id,
      agentGeneration: record.generation,
      time: this.now(),
      data: clone(data),
    }) as AgentLiveEvent
    for (const subscriber of [...record.live]) {
      if (subscriber.closed === undefined) void subscriber.observer(clone(event))
    }
  }
  protected abstract connectionReplaced(): void

  protected abstract appendDriverEvent(event: CordisXDriverSessionEvent): Promise<void>

  protected abstract requestDriverApproval(request: CordisXDriverApprovalRequest): Promise<ApprovalOutcome>

  protected abstract emitDriverStatus(event: CordisXDriverAgentStatus): void

  protected abstract claimDriverMessage(event: CordisXDriverMessageClaimed): Promise<void>

  protected abstract allowed(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ): Promise<boolean>

  protected abstract acquireDenied(operation: 'create' | 'resume', mutationId?: string): AgentAcquireResult

  protected abstract acquire(
    owner: PluginOwnerIdentity,
    operation: 'create' | 'resume',
    sessionId: string,
    input: AgentCreateOptions | AgentResumeOptions,
    source: 'host' | 'caller',
    resolvedLegacy?: boolean,
    entityBinding?: EntitySessionDefinitionBinding,
    executionContext?: AgentTaskResolvedContext,
  ): Promise<AgentAcquireResult>

  protected abstract replayEntityMutation(
    owner: PluginOwnerIdentity,
    envelope: EntityAcquireEnvelope,
    input: EntityAgentCreateOptions | EntityAgentResumeOptions,
  ): EntityAgentAcquireResult | undefined

  protected abstract entityAcquireResult(
    envelope: EntityAcquireEnvelope,
    result: AgentAcquireResult,
    resolution: EntityDefinitionResolution,
    definitionSource: 'registry-current' | 'session-persisted',
  ): EntityAgentAcquireResult

  protected abstract rememberEntityMutation(
    owner: PluginOwnerIdentity,
    input: EntityAgentCreateOptions | EntityAgentResumeOptions,
    result: EntityAgentAcquireResult,
  ): EntityAgentAcquireResult

  protected abstract agent(owner: PluginOwnerIdentity, record: AgentRecord): Agent

  protected abstract current(record: AgentRecord): boolean

  protected abstract sessionLive(record: SessionRecord): boolean

  protected abstract closeSession(
    record: SessionRecord,
    code: NonNullable<SessionRecord['closed']>,
    subscriberCode?: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>,
  ): void

  protected abstract deliver(subscriber: SessionSubscriber, page: Parameters<SessionEventObserver>[0]): Promise<void>
}
