import type { CordisXAgentSessionRuntimeOptions } from './agent-session-runtime-types.js'
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
import { AgentSessionRuntimeOperations } from './agent-session-runtime-agent-operations.js'
import {
  AgentRecord,
  AnswererRecord,
  AuthorityAnswererRecord,
  clone,
  CordisXDriverAgentStatus,
  CordisXDriverApprovalRequest,
  CordisXDriverMessageClaimed,
  CordisXDriverSessionEvent,
  hasExactKeys,
  MUTATION_SCHEMA,
  opaque,
  plainObject,
  RequestResolverRecord,
  ROUTING_CLOSE_SCHEMA,
  ROUTING_QUESTION_SCHEMA,
  ROUTING_RESULT_SCHEMA,
  SessionRecord,
  SessionSubscriber,
} from './agent-session-runtime-types.js'

export abstract class AgentSessionRuntimeEvents extends AgentSessionRuntimeOperations {
  bindTaskPermission(
    source: Parameters<NonNullable<CordisXAgentSessionRuntimeOptions['taskPermissions']>['bind']>[0],
    agent: Agent,
    current: () => boolean,
    readback: () => Promise<boolean>,
  ): () => void {
    const record = this.recordForApprovalTarget({ agent, definition: source.definition })
    if (record === undefined || !this.sameOwner(source.owner, record.owner)) throw new Error('Task Agent unavailable')
    const resolver = this.requestResolvers.get(this.answererKey(record))
    if (resolver === undefined || this.options.taskPermissions === undefined) {
      throw new Error('Task resolver unavailable')
    }
    return this.options.taskPermissions.bind(
      source,
      this.approvalBinding(record),
      () => current() && this.requestResolverCurrent(record, resolver),
      readback,
    )
  }

  protected async appendDriverEvent(event: CordisXDriverSessionEvent): Promise<void> {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record)) return
    await this.append(
      record.session,
      event.type,
      event.data as Extract<SessionEvent, { readonly type: typeof event.type }>['data'],
      event.ignorable,
    )
  }

  protected async requestDriverApproval(request: CordisXDriverApprovalRequest): Promise<ApprovalOutcome> {
    const record = this.agents.get(request.sessionId)
    if (record === undefined || !this.current(record)) return 'unavailable'
    const key = this.answererKey(record)
    const resolver = this.requestResolvers.get(key)
    if (resolver !== undefined) return await this.routeDriverApproval(record, resolver, request)
    if (this.routeRequiredRequesters.has(key)) return 'unavailable'
    const decision = await this.requestApproval(record.owner, {
      agent: this.agent(record.owner, record),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    return decision.outcome
  }

  protected async routeDriverApproval(
    requester: AgentRecord,
    resolver: RequestResolverRecord,
    request: CordisXDriverApprovalRequest,
  ): Promise<ApprovalOutcome> {
    if (
      !opaque(request.toolName) || request.callId !== undefined && !opaque(request.callId)
      || typeof request.reason !== 'string' || request.reason.length < 1 || request.reason.length > 10_000
      || /[\u0000\u000B\u000C\u000E-\u001F\u007F]/u.test(request.reason)
      || !this.requestResolverCurrent(requester, resolver)
    ) return 'unavailable'
    const controller = new AbortController()
    resolver.controllers.add(controller)
    try {
      const outcome = await this.resolveDriverApproval(
        requester,
        resolver,
        { ...request, reason: request.reason },
        controller,
      )
      return this.requestResolverCurrent(requester, resolver) ? outcome : 'unavailable'
    } finally {
      resolver.controllers.delete(controller)
    }
  }

  private async resolveDriverApproval(
    requester: AgentRecord,
    resolver: RequestResolverRecord,
    request: CordisXDriverApprovalRequest & { readonly reason: string },
    controller: AbortController,
  ): Promise<ApprovalOutcome> {
    const question: ApprovalRequestRoutingQuestion = Object.freeze({
      $schema: ROUTING_QUESTION_SCHEMA,
      contract: 'cordisx.approval-request-routing-question/v1',
      schemaVersion: 1,
      routingId: `cx-approval-routing.${crypto.randomUUID()}`,
      registration: clone(resolver.registration),
      requester: this.approvalBinding(requester),
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      reason: { kind: 'plain-text' as const, text: request.reason },
    })
    let result: ApprovalRequestRoutingResult
    try {
      result = clone(
        await resolver.resolver(
          clone(question),
          request.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, request.signal]),
        ),
      )
    } catch {
      return 'unavailable'
    }
    if (
      controller.signal.aborted || request.signal?.aborted || !this.requestResolverCurrent(requester, resolver)
      || !this.validRoutingResult(result, question, resolver.registration)
    ) return 'unavailable'
    if (result.status !== 'accepted') return 'unavailable'
    const resolvedRequester = this.recordForApprovalBinding(result.requester)
    const authority = this.recordForApprovalBinding(result.authority)
    if (
      resolvedRequester !== requester || authority === undefined
      || !this.sameOwner(resolver.owner, resolvedRequester.owner) || !this.sameOwner(resolver.owner, authority.owner)
      || !await this.allowed(resolver.owner, 'approvals.request', requester.id)
      || (this.options.requiresApprovalAuthorityLease?.(resolver.owner) !== true
        && !await this.allowed(resolver.owner, 'approvals.answer', authority.id))
      || !this.requestResolverCurrent(requester, resolver) || !this.current(authority)
    ) return 'unavailable'
    const authorityLease = await this.options.mintApprovalAuthorityLease?.(resolver.owner, {
      routingId: question.routingId,
      registrationId: resolver.registration.registrationId,
      requester: this.approvalBinding(requester),
      authority: this.approvalBinding(authority),
    }, () => !request.signal?.aborted && this.requestResolverCurrent(requester, resolver) && this.current(authority))
    if (authorityLease === undefined && this.options.requiresApprovalAuthorityLease?.(resolver.owner) === true) {
      return 'unavailable'
    }
    try {
      const decision = await this.requestApprovalV2(resolver.owner, {
        requester: { agent: this.agent(resolver.owner, requester), definition: clone(requester.definition!) },
        authority: { agent: this.agent(resolver.owner, authority), definition: clone(authority.definition!) },
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        reason: clone(question.reason),
        signal: request.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, request.signal]),
      }, authorityLease)
      return decision.outcome
    } finally {
      if (authorityLease !== undefined) this.options.releaseApprovalAuthorityLease?.(authorityLease)
    }
  }

  protected emitDriverStatus(event: CordisXDriverAgentStatus): void {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record)) return
    record.status = event.status
    this.emitLive(record, 'agent/status', { status: event.status })
    if (event.status === 'idle') {
      for (const resolve of record.idleWaiters) resolve({ status: 'idle' })
      record.idleWaiters.clear()
    }
  }

  protected async claimDriverMessage(event: CordisXDriverMessageClaimed): Promise<void> {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record) || record.claimed.has(event.messageId)) return
    const pending = record.pending.get(event.messageId)
    if (pending === undefined) return
    record.pending.delete(event.messageId)
    record.claimed.add(event.messageId)
    if (
      !await this.append(record.session, 'agent/inbox/spliced', {
        target: pending.target,
        start: 0,
        removedCount: 1,
        inserted: [],
      })
    ) return
    this.emitLive(record, 'agent/inbox/claimed', { message: pending.message, turn: event.turn })
  }

  protected async newSession(
    id: string,
    setup: AgentSetup | undefined,
    definitions: readonly CordisXResolvedAgentDefinition[] | undefined,
    entityBinding?: EntitySessionDefinitionBinding,
    isSeeded = false,
  ): Promise<SessionRecord | undefined> {
    const initialEvents: SessionEvent[] = entityBinding === undefined ? [] : [Object.freeze({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
      contract: 'cordisx.session-event/v1',
      schemaVersion: 1,
      sessionId: id,
      seq: 0,
      time: this.now(),
      type: 'entity/definition-bound',
      ignorable: true,
      data: clone(entityBinding),
    }) as SessionEvent]
    const record: SessionRecord = {
      id,
      generation: 1,
      header: Object.freeze({ id, formatVersion: 1, createdAt: this.now(), isSeeded }),
      events: initialEvents,
      setup: setup === undefined ? undefined : Object.freeze(clone(setup)),
      definitions: definitions === undefined ? undefined : Object.freeze(definitions.map(clone)),
      subscribers: new Set(),
      appendQueue: Promise.resolve(),
    }
    try {
      await this.options.persistence?.create({
        id,
        generation: record.generation,
        header: clone(record.header),
        events: clone(initialEvents),
        ...(record.setup === undefined ? {} : { setup: clone(record.setup) }),
      })
    } catch {
      return undefined
    }
    this.sessions.set(id, record)
    return record
  }

  protected async updateSessionSetup(
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
    } catch {
      return false
    }
    session.setup = Object.freeze(clone(setup))
    session.definitions = Object.freeze(definitions.map(clone))
    return true
  }

  protected handle(owner: PluginOwnerIdentity, record: AgentRecord): AgentHandle {
    let handle!: AgentHandle
    const value = Object.freeze({
      agent: this.agent(owner, record),
      owner: clone(owner),
      dispose: async (options?: AgentDisposeOptions): Promise<AgentMutationResult<'dispose'>> => {
        if (this.handleCapabilities.get(handle as object) !== record || !this.current(record)) {
          return this.mutation('dispose', options?.mutationId, 'unavailable', 'agent-replaced')
        }
        if (!this.sameOwner(owner, record.owner)) {
          return this.mutation('dispose', options?.mutationId, 'denied', 'not-owner')
        }
        this.disposeAgent(record, 'owner-disposed')
        return this.mutation('dispose', options?.mutationId, 'accepted')
      },
    })
    handle = value as AgentHandle
    this.handleCapabilities.set(handle as object, record)
    return handle
  }

  protected disposeAgent(
    record: AgentRecord,
    reason: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced',
  ): void {
    if (record.disposed !== undefined) return
    for (const controller of record.approvalControllers) controller.abort()
    record.approvalControllers.clear()
    record.disposed = reason
    const answerer = this.answerers.get(this.answererKey(record))
    if (answerer !== undefined) this.closeAnswerer(record, answerer, 'agent-replaced')
    const authorityAnswerer = this.authorityAnswerers.get(this.answererKey(record))
    if (authorityAnswerer !== undefined) {
      this.closeAuthorityAnswerer(
        record,
        authorityAnswerer,
        reason === 'connection-replaced' ? 'connection-replaced' : 'authority-replaced',
      )
    }
    const requestResolver = this.requestResolvers.get(this.answererKey(record))
    if (requestResolver !== undefined) {
      this.closeRequestResolver(
        requestResolver,
        reason === 'connection-replaced' ? 'connection-replaced' : 'requester-replaced',
      )
    }
    this.emitLive(record, 'agent/disposed', { reason })
    for (const subscriber of record.live) {
      subscriber.closed = reason === 'connection-replaced'
        ? 'connection-replaced'
        : 'agent-replaced'
    }
    record.live.clear()
    for (const resolve of record.idleWaiters) {
      resolve({
        status: 'unavailable',
        code: reason === 'connection-replaced' ? 'connection-replaced' : 'agent-replaced',
      })
    }
    record.idleWaiters.clear()
  }

  protected closeSession(
    record: SessionRecord,
    code: NonNullable<SessionRecord['closed']>,
    subscriberCode: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'> =
      code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable',
  ): void {
    if (record.closed !== undefined) return
    record.closed = code
    for (const subscriber of record.subscribers) this.closeSubscriber(record, subscriber, subscriberCode)
    record.subscribers.clear()
  }

  protected connectionReplaced(): void {
    this.connectionGeneration += 1
    this.clearAdmissionCapabilities()
    for (const agent of this.agents.values()) this.disposeAgent(agent, 'connection-replaced')
    for (const session of this.sessions.values()) this.closeSession(session, 'connection-replaced')
  }

  protected clearAdmissionCapabilitiesForOwner(ownerPluginId: string): void {
    if (!opaque(ownerPluginId)) return
    for (const [token, issued] of this.targetAdmissionOrigins) {
      if (issued.owner.pluginId === ownerPluginId) this.targetAdmissionOrigins.delete(token)
    }
    for (const [token, issued] of this.bootstrapAdmissionTargets) {
      if (issued.owner.pluginId === ownerPluginId) this.bootstrapAdmissionTargets.delete(token)
    }
    for (const [token, issued] of this.bootstrapAdmissionRoomTargets) {
      if (issued.owner.pluginId !== ownerPluginId) continue
      issued.capture?.close()
      this.bootstrapAdmissionRoomTargets.delete(token)
    }
    for (const [token, issued] of this.bootstrapAdmissionRouteContinuations) {
      if (issued.owner.pluginId !== ownerPluginId) continue
      issued.capture?.close()
      this.bootstrapAdmissionRouteContinuations.delete(token)
    }
    for (const [token, issued] of this.pageAdmissionTargets) {
      if (issued.owner.pluginId !== ownerPluginId) continue
      issued.revoked = true
      issued.capture?.close()
      this.pageAdmissionTargets.delete(token)
    }
    for (const [originId, issued] of this.pageAdmissionCommands) {
      if (issued.owner.pluginId === ownerPluginId) this.pageAdmissionCommands.delete(originId)
    }
    const prefix = `${ownerPluginId}\u0000`
    for (const key of this.issuedAdmissionTargets) if (key.startsWith(prefix)) this.issuedAdmissionTargets.delete(key)
    for (const key of this.issuedBootstrapAdmissionTargets) {
      if (key.startsWith(prefix)) this.issuedBootstrapAdmissionTargets.delete(key)
    }
    for (const key of this.issuedBootstrapAdmissionRoomTargets) {
      if (key.startsWith(prefix)) this.issuedBootstrapAdmissionRoomTargets.delete(key)
    }
    for (const key of this.issuedBootstrapAdmissionRouteTargets) {
      if (key.startsWith(prefix)) this.issuedBootstrapAdmissionRouteTargets.delete(key)
    }
    for (const key of this.bootstrapAdmissionRoomRooms.keys()) {
      if (key.startsWith(prefix)) this.bootstrapAdmissionRoomRooms.delete(key)
    }
    for (const key of this.bootstrapAdmissionRouteRooms.keys()) {
      if (key.startsWith(prefix)) this.bootstrapAdmissionRouteRooms.delete(key)
    }
    for (const key of this.reservedAdmissionOrigins) {
      if (key.startsWith(prefix)) this.reservedAdmissionOrigins.delete(key)
    }
  }

  protected clearAdmissionCapabilities(): void {
    for (const issued of this.bootstrapAdmissionRoomTargets.values()) issued.capture?.close()
    for (const issued of this.bootstrapAdmissionRouteContinuations.values()) issued.capture?.close()
    for (const issued of this.pageAdmissionTargets.values()) issued.capture?.close()
    this.targetAdmissionOrigins.clear()
    this.bootstrapAdmissionTargets.clear()
    this.bootstrapAdmissionRoomTargets.clear()
    this.bootstrapAdmissionRouteContinuations.clear()
    this.issuedAdmissionTargets.clear()
    this.issuedBootstrapAdmissionTargets.clear()
    this.issuedBootstrapAdmissionRoomTargets.clear()
    this.issuedBootstrapAdmissionRouteTargets.clear()
    this.bootstrapAdmissionRoomRooms.clear()
    this.bootstrapAdmissionRouteRooms.clear()
    this.reservedAdmissionOrigins.clear()
    this.pageAdmissionTargets.clear()
    this.pageAdmissionCommands.clear()
  }

  protected async deliver(subscriber: SessionSubscriber, page: Parameters<SessionEventObserver>[0]): Promise<void> {
    subscriber.delivery = subscriber.delivery.then(async () => {
      if (subscriber.closed !== undefined) return
      try {
        await subscriber.observer(page)
      } catch {
        this.closeSubscriberByIdentity(subscriber, 'observer-failed')
      }
    })
    await subscriber.delivery
  }

  protected closeSubscriber(
    record: SessionRecord,
    subscriber: SessionSubscriber,
    code: SessionSubscriptionCloseCode,
  ): SessionSubscriptionClosed {
    if (subscriber.closed !== undefined) return subscriber.closed
    const closed: SessionSubscriptionClosed = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-close.v1.schema.json',
      contract: 'cordisx.session-subscription-close/v1',
      schemaVersion: 1,
      sessionId: record.id,
      sessionGeneration: record.generation,
      subscriptionGeneration: subscriber.generation,
      status: 'closed',
      code,
    })
    subscriber.closed = closed
    record.subscribers.delete(subscriber)
    subscriber.resolveClosed(closed)
    return closed
  }

  protected closeSubscriberByIdentity(subscriber: SessionSubscriber, code: SessionSubscriptionCloseCode): void {
    for (const session of this.sessions.values()) {
      if (session.subscribers.has(subscriber)) {
        this.closeSubscriber(session, subscriber, code)
        return
      }
    }
  }

  protected closeAnswerer(
    record: AgentRecord,
    answerer: AnswererRecord,
    code: NonNullable<AnswererRecord['closed']>,
  ): void {
    if (answerer.closed === undefined) answerer.closed = code
    for (const controller of answerer.controllers) controller.abort()
    answerer.controllers.clear()
    if (this.answerers.get(this.answererKey(record)) === answerer) this.answerers.delete(this.answererKey(record))
  }

  protected closeAuthorityAnswerer(
    record: AgentRecord,
    answerer: AuthorityAnswererRecord,
    code: NonNullable<AuthorityAnswererRecord['closed']>,
  ): void {
    if (answerer.closed === undefined) answerer.closed = code
    for (const controller of answerer.controllers) controller.abort()
    answerer.controllers.clear()
    if (this.authorityAnswerers.get(this.answererKey(record)) === answerer) {
      this.authorityAnswerers.delete(this.answererKey(record))
    }
  }

  protected closeRequestResolver(
    resolver: RequestResolverRecord,
    code: ApprovalRequestResolverClosed['code'],
  ): ApprovalRequestResolverClosed {
    if (resolver.terminal !== undefined) return resolver.terminal
    const closed: ApprovalRequestResolverClosed = Object.freeze({
      $schema: ROUTING_CLOSE_SCHEMA,
      contract: 'cordisx.approval-request-resolver-close/v1',
      schemaVersion: 1,
      registration: clone(resolver.registration),
      status: 'closed',
      code,
    })
    resolver.terminal = closed
    for (const controller of resolver.controllers) controller.abort()
    resolver.controllers.clear()
    if (this.requestResolvers.get(this.answererKey(resolver.requester)) === resolver) {
      this.requestResolvers.delete(this.answererKey(resolver.requester))
    }
    resolver.resolveClosed(closed)
    return closed
  }

  protected requestResolverCurrent(requester: AgentRecord, resolver: RequestResolverRecord): boolean {
    return resolver.terminal === undefined
      && resolver.requester === requester
      && resolver.connectionGeneration === this.connectionGeneration
      && this.requestResolvers.get(this.answererKey(requester)) === resolver
      && this.current(requester)
  }

  protected recordForAgent(value: Agent): AgentRecord | undefined {
    const record = this.agentCapabilities.get(value as object)
    return record !== undefined && record.generation === value.generation && this.current(record) ? record : undefined
  }

  protected recordForApprovalTarget(target: ApprovalAgentTarget): AgentRecord | undefined {
    const record = this.recordForAgent(target.agent)
    return record?.definition !== undefined
        && record.definition.agentId === target.definition.agentId
        && record.definition.revision === target.definition.revision
      ? record
      : undefined
  }

  protected recordForApprovalBinding(value: unknown): AgentRecord | undefined {
    if (
      !plainObject(value) || !hasExactKeys(value, ['agentId', 'sessionId', 'agentGeneration', 'definition'])
      || !opaque(value.agentId) || value.sessionId !== value.agentId
      || !Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1
      || !plainObject(value.definition) || !hasExactKeys(value.definition, ['agentId', 'revision'])
      || !opaque(value.definition.agentId) || !opaque(value.definition.revision)
      || value.definition.agentId === '*' || value.definition.revision === '*'
    ) return undefined
    const record = this.agents.get(value.agentId)
    return record !== undefined && record.generation === value.agentGeneration && this.current(record)
        && record.definition?.agentId === value.definition.agentId
        && record.definition.revision === value.definition.revision
      ? record
      : undefined
  }

  protected validRoutingResult(
    value: unknown,
    question: ApprovalRequestRoutingQuestion,
    registration: ApprovalRequestRoutingRegistration,
  ): value is ApprovalRequestRoutingResult {
    if (
      !plainObject(value) || value.$schema !== ROUTING_RESULT_SCHEMA
      || value.contract !== 'cordisx.approval-request-routing-result/v1' || value.schemaVersion !== 1
      || value.routingId !== question.routingId || !this.sameRoutingRegistration(value.registration, registration)
    ) return false
    if (value.status === 'unavailable') {
      return hasExactKeys(value, [
        '$schema',
        'contract',
        'schemaVersion',
        'routingId',
        'registration',
        'status',
        'code',
      ])
        && (value.code === 'mapping-unavailable' || value.code === 'authority-unavailable')
    }
    return value.status === 'accepted' && value.code === 'routed'
      && hasExactKeys(value, [
        '$schema',
        'contract',
        'schemaVersion',
        'routingId',
        'registration',
        'status',
        'code',
        'requester',
        'authority',
      ])
      && this.sameApprovalBinding(value.requester, question.requester)
      && this.recordForApprovalBinding(value.requester) !== undefined
      && this.recordForApprovalBinding(value.authority) !== undefined
  }

  protected sameApprovalBinding(left: unknown, right: ApprovalAgentBinding): boolean {
    if (
      !plainObject(left) || !hasExactKeys(left, ['agentId', 'sessionId', 'agentGeneration', 'definition'])
      || !plainObject(left.definition) || !hasExactKeys(left.definition, ['agentId', 'revision'])
    ) return false
    return left.agentId === right.agentId && left.sessionId === right.sessionId
      && left.agentGeneration === right.agentGeneration && plainObject(left.definition)
      && left.definition.agentId === right.definition.agentId && left.definition.revision === right.definition.revision
  }

  protected sameRoutingRegistration(left: unknown, right: ApprovalRequestRoutingRegistration): boolean {
    if (
      !plainObject(left)
      || !hasExactKeys(left, ['$schema', 'contract', 'schemaVersion', 'registrationId', 'owner', 'requester'])
      || left.$schema !== right.$schema || left.contract !== right.contract
      || left.schemaVersion !== right.schemaVersion
      || left.registrationId !== right.registrationId || !plainObject(left.owner)
      || !hasExactKeys(left.owner, ['pluginId', 'generation'])
    ) return false
    return left.owner.pluginId === right.owner.pluginId && left.owner.generation === right.owner.generation
      && this.sameApprovalBinding(left.requester, right.requester)
  }
  protected abstract current(record: AgentRecord): boolean

  protected abstract answererKey(record: AgentRecord): string

  protected abstract approvalBinding(record: AgentRecord): ApprovalAgentBinding

  protected abstract sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean

  protected abstract allowed(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ): Promise<boolean>

  protected abstract mutation(
    operation: 'cancel' | 'dispose',
    mutationId: string | undefined,
    status: 'accepted' | 'denied' | 'unavailable',
    code?: string,
  ): AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'>
}
