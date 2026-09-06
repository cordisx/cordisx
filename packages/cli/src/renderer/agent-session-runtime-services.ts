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
import { CordisXAgentSessionRuntime } from './agent-session-runtime-results.js'

const runtimes = new WeakMap<object, CordisXAgentSessionRuntime>()

function runtimeFor(service: object): CordisXAgentSessionRuntime {
  const runtime = runtimes.get(service)
  if (runtime === undefined) throw new Error('Agent Session runtime service is detached')
  return runtime
}

export class CordisXAgentRegistryServiceV1 extends Service implements EntityBackedAgentRegistry {
  private readonly entities: EntityRegistry | undefined
  constructor(
    ctx: Context,
    input: CordisXAgentSessionRuntime | {
      readonly runtime: CordisXAgentSessionRuntime
      readonly entities: EntityRegistry
    },
  ) {
    super(ctx, 'agents')
    const runtime = input instanceof CordisXAgentSessionRuntime ? input : input.runtime
    this.entities = input instanceof CordisXAgentSessionRuntime ? undefined : input.entities
    runtimes.set(this, runtime)
  }
  create: EntityBackedAgentRegistry['create'] = (async (
    options: AgentCreateOptions | EntityAgentCreateOptions,
  ): Promise<AgentAcquireResult | EntityAgentAcquireResult> => {
    const runtime = runtimeFor(this)
    const owner = runtime.ownerFromContext(this.ctx)
    return 'definition' in options && (options as { readonly setup?: unknown }).setup === undefined
        && this.entities !== undefined
      ? await runtime.createEntity(owner, options as EntityAgentCreateOptions, this.entities)
      : await runtime.create(owner, options as AgentCreateOptions)
  }) as EntityBackedAgentRegistry['create']
  resume: EntityBackedAgentRegistry['resume'] = (async (
    options: AgentResumeOptions | EntityAgentResumeOptions,
  ): Promise<AgentAcquireResult | EntityAgentAcquireResult> => {
    const runtime = runtimeFor(this)
    const owner = runtime.ownerFromContext(this.ctx)
    return 'definitionSource' in options && this.entities !== undefined
      ? await runtime.resumeEntity(owner, options as EntityAgentResumeOptions)
      : await runtime.resume(owner, options as AgentResumeOptions)
  }) as EntityBackedAgentRegistry['resume']
  get = async (agentId: string): Promise<Agent | undefined> => {
    const runtime = runtimeFor(this)
    return await runtime.get(runtime.ownerFromContext(this.ctx), agentId)
  }
  acquireLegacyTaskBinding = async (
    request: CordisXAgentSessionLegacyAcquireRequestV1,
  ): Promise<CordisXAgentSessionLegacyAcquireResultV1> => {
    const runtime = runtimeFor(this)
    return await runtime.acquireLegacyTaskBinding(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXSessionRegistryServiceV1 extends Service implements SessionRegistry {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'sessions')
    runtimes.set(this, runtime)
  }
  get = async (sessionId: string): Promise<Session | undefined> => {
    const runtime = runtimeFor(this)
    return await runtime.session(runtime.ownerFromContext(this.ctx), sessionId)
  }
}

export type CordisXApprovalService = ApprovalServiceV1 & ApprovalServiceV2 & ApprovalServiceV3

export class CordisXApprovalServiceV1 extends Service
  implements ApprovalServiceV1, ApprovalServiceV2, ApprovalServiceV3
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'approvals')
    runtimes.set(this, runtime)
  }
  request = (async (
    request: Parameters<ApprovalServiceV1['request']>[0] | Parameters<ApprovalServiceV2['request']>[0],
  ): Promise<ApprovalDecisionV1 | ApprovalDecisionV2> => {
    const runtime = runtimeFor(this)
    const owner = runtime.ownerFromContext(this.ctx)
    return 'requester' in request
      ? await runtime.requestApprovalV2(owner, request)
      : await runtime.requestApproval(owner, request)
  }) as CordisXApprovalService['request']
  registerAnswerer = async (agent: Agent, answerer: ApprovalAnswererV1): Promise<ApprovalAnswererHandleV1> => {
    const runtime = runtimeFor(this)
    return await runtime.registerAnswerer(runtime.ownerFromContext(this.ctx), agent, answerer)
  }
  registerAuthorityAnswerer = async (
    authority: ApprovalAgentTarget,
    answerer: ApprovalAnswererV2,
  ): Promise<ApprovalAuthorityAnswererHandle> => {
    const runtime = runtimeFor(this)
    return await runtime.registerAuthorityAnswerer(runtime.ownerFromContext(this.ctx), authority, answerer)
  }
  registerRequestResolver = async (
    requester: ApprovalAgentTarget,
    resolver: ApprovalRequestResolver,
  ): Promise<ApprovalRequestResolverRegisterResult> => {
    const runtime = runtimeFor(this)
    return await runtime.registerRequestResolver(runtime.ownerFromContext(this.ctx), requester, resolver)
  }
}

export class CordisXAgentAdmissionReservationService extends Service implements AgentAdmissionReservationService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmission')
    runtimes.set(this, runtime)
  }
  reserve = async (request: AgentAdmissionReservationRequest): Promise<AgentAdmissionReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reserveAdmission(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionTargetOriginService extends Service implements AgentAdmissionTargetOriginService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionOrigins')
    runtimes.set(this, runtime)
  }
  issue = async (request: AgentAdmissionTargetOriginRequest): Promise<AgentAdmissionTargetOriginResult> => {
    const runtime = runtimeFor(this)
    return await runtime.issueAdmissionTargetOrigin(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionTargetReservationService extends Service
  implements AgentAdmissionTargetReservationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionReservations')
    runtimes.set(this, runtime)
  }
  reserve = async (request: AgentAdmissionTargetReservationRequest): Promise<AgentAdmissionTargetReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reserveAdmissionTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionBootstrapTargetService extends Service
  implements AgentAdmissionBootstrapTargetService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionBootstrapTargets')
    runtimes.set(this, runtime)
  }
  issue = async (request: AgentAdmissionBootstrapTargetRequest): Promise<AgentAdmissionBootstrapTargetResult> => {
    const runtime = runtimeFor(this)
    return await runtime.issueAdmissionBootstrapTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionBootstrapReservationService extends Service
  implements AgentAdmissionBootstrapReservationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionBootstrapReservations')
    runtimes.set(this, runtime)
  }
  reserve = async (
    request: AgentAdmissionBootstrapReservationRequest,
  ): Promise<AgentAdmissionBootstrapReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reserveAdmissionBootstrapTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionBootstrapRoomTargetService extends Service
  implements AgentAdmissionBootstrapRoomTargetService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionBootstrapRoomTargets')
    runtimes.set(this, runtime)
  }
  issue = async (
    request: AgentAdmissionBootstrapRoomTargetRequest,
  ): Promise<AgentAdmissionBootstrapRoomTargetResult> => {
    const runtime = runtimeFor(this)
    return await runtime.issueAdmissionBootstrapRoomTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionBootstrapRoomReservationService extends Service
  implements AgentAdmissionBootstrapRoomReservationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionBootstrapRoomReservations')
    runtimes.set(this, runtime)
  }
  reserve = async (
    request: AgentAdmissionBootstrapRoomReservationRequest,
  ): Promise<AgentAdmissionBootstrapRoomReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reserveAdmissionBootstrapRoomTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionBootstrapRouteDeclarationService extends Service
  implements AgentAdmissionBootstrapRouteDeclarationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionBootstrapRouteDeclarations')
    runtimes.set(this, runtime)
  }
  declare = async (
    request: AgentAdmissionBootstrapRouteDeclarationRequest,
  ): Promise<AgentAdmissionBootstrapRouteDeclarationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.declareAdmissionBootstrapRoute(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentAdmissionBootstrapRouteReservationService extends Service
  implements AgentAdmissionBootstrapRouteReservationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentAdmissionBootstrapRouteReservations')
    runtimes.set(this, runtime)
  }
  reserve = async (
    request: AgentAdmissionBootstrapRouteReservationRequest,
  ): Promise<AgentAdmissionBootstrapRouteReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reserveAdmissionBootstrapRoute(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentPageAdmissionTargetService extends Service implements AgentPageAdmissionTargetService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentPageAdmissionTargets')
    runtimes.set(this, runtime)
  }
  issue = async (request: AgentPageAdmissionTargetRequest): Promise<AgentPageAdmissionTargetResult> => {
    const runtime = runtimeFor(this)
    return await runtime.issuePageAdmissionTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentPageAdmissionReservationService extends Service
  implements AgentPageAdmissionReservationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentPageAdmissionReservations')
    runtimes.set(this, runtime)
  }
  reserve = async (request: AgentPageAdmissionReservationRequest): Promise<AgentPageAdmissionReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reservePageAdmissionTarget(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentPageAdmissionRouteDeclarationService extends Service
  implements AgentPageAdmissionRouteDeclarationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentPageAdmissionRouteDeclarations')
    runtimes.set(this, runtime)
  }
  declare = async (
    request: AgentPageAdmissionRouteDeclarationRequest,
  ): Promise<AgentPageAdmissionRouteDeclarationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.declarePageAdmissionRoute(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentPageAdmissionRouteReservationService extends Service
  implements AgentPageAdmissionRouteReservationService
{
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentPageAdmissionRouteReservations')
    runtimes.set(this, runtime)
  }
  reserve = async (
    request: AgentPageAdmissionRouteReservationRequest,
  ): Promise<AgentPageAdmissionRouteReservationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.reservePageAdmissionRoute(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentPageFreshRoomNavigationService extends Service implements AgentPageFreshRoomNavigationService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentPageFreshRoomNavigation')
    runtimes.set(this, runtime)
  }
  navigate = async (request: AgentPageFreshRoomNavigationRequest): Promise<AgentPageFreshRoomNavigationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.navigatePageAdmission(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentSessionDetailReferenceService extends Service implements AgentSessionDetailReferenceService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentSessionDetailReferences')
    runtimes.set(this, runtime)
  }
  get = async (request: AgentSessionDetailReferenceRequest): Promise<AgentSessionDetailReferenceResult> => {
    const runtime = runtimeFor(this)
    return await runtime.getAgentSessionDetailReference(runtime.ownerFromContext(this.ctx), request)
  }
}

export class CordisXAgentDetailNavigationService extends Service implements AgentDetailNavigationService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) {
    super(ctx, 'agentDetailNavigation')
    runtimes.set(this, runtime)
  }
  open = async (request: AgentDetailNavigationRequest): Promise<AgentDetailNavigationResult> => {
    const runtime = runtimeFor(this)
    return await runtime.openAgentDetail(runtime.ownerFromContext(this.ctx), request)
  }
}
