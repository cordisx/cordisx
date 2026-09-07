import { runApprovalInvocation } from './approval-invocation.js'
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
import { AgentSessionRuntimeCore } from './agent-session-runtime-core.js'
import {
  AgentRecord,
  AnswererRecord,
  AuthorityAnswererRecord,
  clone,
  CordisXPrivateAgentDriver,
  DECISION_SCHEMA_V1,
  DECISION_SCHEMA_V2,
  hasExactKeys,
  opaque,
  ownerKey,
  PAGE_ORIGIN_SCHEMA,
  PAGE_SCHEMA,
  PageAdmissionCommandRecord,
  PageAdmissionTargetRecord,
  plainObject,
  QUESTION_SCHEMA_V1,
  QUESTION_SCHEMA_V2,
  RequestResolverRecord,
  ROUTING_CLOSE_SCHEMA,
  ROUTING_REGISTRATION_SCHEMA,
  SessionRecord,
  SessionSubscriber,
  SNAPSHOT_SCHEMA,
  SUBSCRIPTION_SCHEMA,
} from './agent-session-runtime-types.js'

export abstract class AgentSessionRuntimeApproval extends AgentSessionRuntimeCore {
  async session(owner: PluginOwnerIdentity, sessionId: string): Promise<Session | undefined> {
    if (!opaque(sessionId) || !await this.allowed(owner, 'sessions.get', sessionId)) return undefined
    const record = this.sessions.get(sessionId)
    return record === undefined ? undefined : this.sessionHandle(owner, record)
  }

  async requestApproval(
    owner: PluginOwnerIdentity,
    request: Parameters<ApprovalServiceV1['request']>[0],
  ): Promise<ApprovalDecisionV1> {
    const record = this.recordForAgent(request.agent)
    if (
      record === undefined || !this.sameOwner(owner, record.owner)
      || !await this.allowed(owner, 'approvals.request', request.agent.id)
    ) {
      return this.approvalDecision(request.agent, crypto.randomUUID(), request.toolName, request.callId, 'unavailable')
    }
    const id = `cx-approval.${crypto.randomUUID()}`
    const question = this.approvalQuestion(record, id, request.toolName, request.callId, request.reason)
    if (
      !await this.append(record.session, 'approval/asked', {
        id,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      })
    ) {
      return this.approvalDecision(record, id, request.toolName, request.callId, 'unavailable')
    }
    const answerer = this.answerers.get(this.answererKey(record))
    let outcome: ApprovalOutcome = 'unavailable'
    if (
      answerer !== undefined && answerer.closed === undefined
      && await this.allowed(answerer.owner, 'approvals.answer', record.id)
      && answerer.closed === undefined && this.answerers.get(this.answererKey(record)) === answerer
      && this.current(record)
    ) {
      try {
        const proposed = await runApprovalInvocation(
          answerer.controllers,
          request.signal,
          signal => answerer.answerer(question, signal),
          record.approvalControllers,
        )
        if (request.signal?.aborted) outcome = 'cancelled'
        else if (
          answerer.closed !== undefined || !this.current(record)
          || this.answerers.get(this.answererKey(record)) !== answerer
        ) outcome = 'unavailable'
        else if (
          proposed === 'allowed-once' || proposed === 'rejected' || proposed === 'cancelled'
          || proposed === 'unavailable'
        ) outcome = proposed
      } catch {
        outcome = request.signal?.aborted ? 'cancelled' : 'unavailable'
      }
    }
    if (!await this.append(record.session, 'approval/decided', { id, outcome })) outcome = 'unavailable'
    return this.approvalDecision(record, id, request.toolName, request.callId, outcome)
  }

  async registerAnswerer(
    owner: PluginOwnerIdentity,
    agent: Agent,
    answerer: ApprovalAnswererV1,
  ): Promise<ApprovalAnswererHandleV1> {
    const record = this.recordForAgent(agent)
    if (
      record === undefined || typeof answerer !== 'function' || !this.sameOwner(owner, record.owner)
      || this.options.declares?.(owner, 'approvals.answer') === false
    ) {
      throw new Error('Approval answerer is unavailable')
    }
    const key = this.answererKey(record)
    if (this.answerers.has(key)) throw new Error('Approval answerer is already registered')
    const entry: AnswererRecord = { owner: clone(owner), answerer, controllers: new Set() }
    this.answerers.set(key, entry)
    const handle = Object.freeze({
      agentId: record.id,
      agentGeneration: record.generation,
      dispose: async () => {
        this.closeAnswerer(record, entry, 'disposed')
        return { status: 'closed' as const, code: entry.closed! }
      },
    })
    return handle as ApprovalAnswererHandleV1
  }

  async requestApprovalV2(
    owner: PluginOwnerIdentity,
    request: ApprovalRequestV2,
    authorityLease?: PluginApprovalAuthorityLeaseV8,
  ): Promise<ApprovalDecisionV2> {
    if (
      !opaque(request.toolName) || request.callId !== undefined && !opaque(request.callId)
      || request.reason.kind !== 'plain-text' || typeof request.reason.text !== 'string'
      || request.reason.text.length < 1 || request.reason.text.length > 10_000
      || /[\u0000\u000B\u000C\u000E-\u001F\u007F]/u.test(request.reason.text)
    ) {
      throw new Error('Approval request document is invalid')
    }
    const requester = this.recordForApprovalTarget(request.requester)
    const authority = this.recordForApprovalTarget(request.authority)
    if (
      requester === undefined || authority === undefined
      || !this.sameOwner(owner, requester.owner) || !this.sameOwner(owner, authority.owner)
    ) {
      throw new Error('Approval request live Agent binding is unavailable')
    }
    const id = `cx-approval.${crypto.randomUUID()}`
    if (!await this.allowed(owner, 'approvals.request', requester.id)) {
      return this.approvalDecisionV2(requester, authority, id, 'unavailable')
    }
    const question = this.approvalQuestionV2(requester, authority, id, request.toolName, request.callId, request.reason)
    const contextAccepted = await this.appendMany(
      requester.session,
      [{
        type: 'approval/authority-bound',
        data: {
          approvalId: id,
          requester: clone(requester.definition!),
          authority: clone(authority.definition!),
          reason: clone(request.reason),
        },
        ignorable: true,
      }, {
        type: 'approval/asked',
        data: {
          id,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          reason: request.reason.text,
        },
      }] as const,
    )
    if (!contextAccepted) return this.approvalDecisionV2(requester, authority, id, 'unavailable')

    const answerer = this.authorityAnswerers.get(this.answererKey(authority))
    let outcome: ApprovalOutcome = request.signal?.aborted === true ? 'cancelled' : 'unavailable'
    if (
      outcome !== 'cancelled' && answerer !== undefined && answerer.closed === undefined
      && this.current(requester) && this.current(authority)
      && (authorityLease === undefined
        ? await this.allowed(answerer.owner, 'approvals.answer', authority.id)
        : this.options.approvalAuthorityLeaseActive?.(
          answerer.owner,
          authorityLease,
          this.approvalBinding(requester),
          this.approvalBinding(authority),
        ) === true)
      && answerer.closed === undefined && this.authorityAnswerers.get(this.answererKey(authority)) === answerer
      && this.current(requester) && this.current(authority)
    ) {
      try {
        const proposed = await runApprovalInvocation(
          answerer.controllers,
          request.signal,
          signal => answerer.answerer(question, signal),
          requester.approvalControllers,
        )
        if (
          !this.current(requester) || !this.current(authority)
          || answerer.closed !== undefined || this.authorityAnswerers.get(this.answererKey(authority)) !== answerer
        ) outcome = 'unavailable'
        else if (request.signal?.aborted === true) outcome = 'cancelled'
        else if (
          proposed === 'allowed-once' || proposed === 'rejected' || proposed === 'cancelled'
          || proposed === 'unavailable'
        ) outcome = proposed
      } catch {
        outcome = request.signal?.aborted ? 'cancelled' : 'unavailable'
      }
    }
    if (!await this.append(requester.session, 'approval/decided', { id, outcome })) outcome = 'unavailable'
    return this.approvalDecisionV2(requester, authority, id, outcome)
  }

  async registerAuthorityAnswerer(
    owner: PluginOwnerIdentity,
    target: ApprovalAgentTarget,
    answerer: ApprovalAnswererV2,
  ): Promise<ApprovalAuthorityAnswererHandle> {
    const authority = this.recordForApprovalTarget(target)
    if (
      authority === undefined || typeof answerer !== 'function' || !this.sameOwner(owner, authority.owner)
      || this.options.declares?.(owner, 'approvals.answer') === false
    ) {
      throw new Error('Approval authority answerer is unavailable')
    }
    const key = this.answererKey(authority)
    if (this.authorityAnswerers.has(key)) throw new Error('Approval authority answerer is already registered')
    const entry: AuthorityAnswererRecord = { owner: clone(owner), answerer, controllers: new Set() }
    this.authorityAnswerers.set(key, entry)
    const handle = Object.freeze({
      authority: this.approvalBinding(authority),
      dispose: async () => {
        this.closeAuthorityAnswerer(authority, entry, 'disposed')
        return { status: 'closed' as const, code: entry.closed! }
      },
    })
    return handle as ApprovalAuthorityAnswererHandle
  }

  async registerRequestResolver(
    owner: PluginOwnerIdentity,
    target: ApprovalAgentTarget,
    resolver: ApprovalRequestResolver,
  ): Promise<ApprovalRequestResolverRegisterResult> {
    if (typeof resolver !== 'function' || !plainObject(target) || !plainObject(target.definition)) {
      return { status: 'unavailable', code: 'unsupported' }
    }
    const requester = this.recordForApprovalTarget(target)
    if (requester === undefined) return { status: 'unavailable', code: 'agent-replaced' }
    if (!this.sameOwner(owner, requester.owner)) return { status: 'denied', code: 'not-owner' }
    // Registration is a capability/lifecycle admission only. Dynamic
    // host-route scopes may not have an active Session route until a later
    // delegation step; invocation performs the exact permission check.
    if (this.options.declares?.(owner, 'approvals.request') === false) {
      return { status: 'denied', code: 'permission-denied' }
    }
    if (!this.current(requester)) return { status: 'unavailable', code: 'agent-replaced' }

    const registration = Object.freeze({
      $schema: ROUTING_REGISTRATION_SCHEMA,
      contract: 'cordisx.approval-request-routing-registration/v1' as const,
      schemaVersion: 1 as const,
      registrationId: `cx-approval-route.${crypto.randomUUID()}`,
      owner: clone(owner),
      requester: this.approvalBinding(requester),
    })
    let resolveClosed!: (value: ApprovalRequestResolverClosed) => void
    const closed = new Promise<ApprovalRequestResolverClosed>(resolve => {
      resolveClosed = resolve
    })
    const record: RequestResolverRecord = {
      owner: clone(owner),
      requester,
      resolver,
      registration,
      connectionGeneration: this.connectionGeneration,
      controllers: new Set(),
      closed,
      resolveClosed,
    }
    const key = this.answererKey(requester)
    const previous = this.requestResolvers.get(key)
    if (previous !== undefined) this.closeRequestResolver(previous, 'requester-replaced')
    this.routeRequiredRequesters.add(key)
    this.requestResolvers.set(key, record)
    const handle = Object.freeze({
      registration,
      closed,
      dispose: async () => this.closeRequestResolver(record, 'disposed'),
    })
    return { status: 'registered', handle: handle as ApprovalRequestResolverHandle }
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
    this.clearAdmissionCapabilities()
    for (const agent of this.agents.values()) this.disposeAgent(agent, 'runtime-disposed')
    for (const session of this.sessions.values()) this.closeSession(session, 'host-unavailable')
    this.options.driver.dispose()
  }

  protected async reservePageAdmission(
    owner: PluginOwnerIdentity,
    issued: PageAdmissionTargetRecord | undefined,
    handle: AgentHandle,
    requestMessage: { readonly text: string },
  ): Promise<
    | {
      readonly status: 'reserved'
      readonly reservation: {
        readonly reservationId: string
        readonly submit: () => Promise<AgentAdmission & { readonly status: 'accepted' }>
        readonly revoke: () => Promise<void>
      }
    }
    | { readonly status: 'denied'; readonly code: string }
  > {
    const lifecycle = this.options.pageAdmissionBindings
    if (
      this.disposed || issued === undefined || lifecycle === undefined || typeof requestMessage?.text !== 'string'
      || requestMessage.text.length < 1 || [...requestMessage.text].length > 65_536
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    if (!this.sameOwner(owner, issued.owner)) return { status: 'denied', code: 'not-owner' }
    if (issued.revoked || issued.reserved || issued.submitted) return { status: 'denied', code: 'reused' }
    if (!lifecycle.reserve(issued.declaration)) return { status: 'denied', code: 'page-replaced' }
    const record = this.handleCapabilities.get(handle as object)
    if (record === undefined || record.generation !== handle.agent.generation || !this.current(record)) {
      lifecycle.deny(issued.declaration, 'stale')
      return { status: 'denied', code: 'stale' }
    }
    if (!this.sameOwner(owner, record.owner)) {
      lifecycle.deny(issued.declaration, 'not-owner')
      return { status: 'denied', code: 'not-owner' }
    }
    const messageId = `cx-message.${crypto.randomUUID()}` as MessageId
    const message = Object.freeze({
      id: messageId,
      role: 'user' as const,
      content: Object.freeze([{ type: 'text' as const, text: requestMessage.text }]),
      source: Object.freeze({ kind: 'plugin' as const, pluginId: owner.pluginId, generation: owner.generation }),
    }) as UserMessage
    if (!lifecycle.capture(issued.declaration, { sessionId: record.id, messageId })) {
      return { status: 'denied', code: 'page-replaced' }
    }
    const capture = this.options.capturePageAdmission?.(
      owner,
      issued.origin,
      issued.target,
      record.id,
      record.generation,
      messageId,
      () => lifecycle.commandLive(issued.command) && !issued.revoked,
      () => lifecycle.bindingActive(issued.command.binding) && !issued.revoked,
    )
    if (this.options.capturePageAdmission !== undefined && capture === undefined) {
      lifecycle.deny(issued.declaration, 'target-mismatch')
      return { status: 'denied', code: 'target-mismatch' }
    }
    if (capture !== undefined && !capture.active()) {
      capture.close()
      lifecycle.deny(issued.declaration, 'page-replaced')
      return { status: 'denied', code: 'page-replaced' }
    }
    issued.reserved = true
    issued.handleId = record.id
    issued.handleGeneration = record.generation
    issued.sourceSessionId = record.id
    issued.sourceMessageId = messageId
    if (capture !== undefined) issued.capture = capture
    let used = false
    let revoked = false
    const reservation = Object.freeze({
      reservationId: `cx-page-admission-reservation.${crypto.randomUUID()}`,
      submit: async () => {
        if (
          used || revoked || issued.revoked || !issued.reserved || issued.submitted
          || issued.handleId !== record.id || issued.handleGeneration !== record.generation
          || !this.current(record) || !lifecycle.active(issued.command)
          || (issued.capture !== undefined && !issued.capture.active())
        ) {
          throw new Error('page admission reservation unavailable')
        }
        used = true
        const result = await this.submitAdmission(owner, record, message, 'next-turn', true, issued.capture)
        if (result.status !== 'accepted') {
          lifecycle.deny(issued.declaration, 'submit-denied')
          throw new Error('page admission submit denied')
        }
        if (!lifecycle.accept(issued.declaration, { sessionId: record.id, messageId })) {
          throw new Error('page admission capture was fenced before submit completion')
        }
        issued.submitted = true
        return result as AgentAdmission & { readonly status: 'accepted' }
      },
      revoke: async () => {
        if (used || revoked) return
        revoked = true
        issued.revoked = true
        issued.capture?.close()
        lifecycle.deny(issued.declaration, 'revoked')
      },
    })
    return { status: 'reserved', reservation }
  }

  protected pageCommand(
    owner: PluginOwnerIdentity,
    origin: AgentPageComposerOrigin,
  ): PageAdmissionCommandRecord | undefined {
    if (!this.validPageOrigin(origin)) return undefined
    const record = this.pageAdmissionCommands.get(origin.originId)
    if (record === undefined || !this.sameOwner(owner, record.owner) || !this.samePageOrigin(record.origin, origin)) {
      return undefined
    }
    const lifecycle = this.options.pageAdmissionBindings
    return lifecycle?.commandLive(record.command) === true ? record : undefined
  }

  protected validPageOrigin(origin: AgentPageComposerOrigin | undefined): origin is AgentPageComposerOrigin {
    return origin !== undefined && origin.$schema === PAGE_ORIGIN_SCHEMA
      && origin.contract === 'cordisx.agent-page-composer-origin/v1' && origin.schemaVersion === 1
      && opaque(origin.originId) && opaque(origin.binding.bindingId) && opaque(origin.binding.ownerGeneration)
      && opaque(origin.generation) && opaque(origin.executionId) && opaque(origin.commandId)
      && origin.scope === 'page-composer-submit' && opaque(origin.page.outlet)
      && opaque(origin.page.routeDefinitionId)
      && (origin.page.roomId === undefined || opaque(origin.page.roomId))
  }

  protected samePageOrigin(left: AgentPageComposerOrigin, right: AgentPageComposerOrigin): boolean {
    return left.originId === right.originId && left.binding.bindingId === right.binding.bindingId
      && left.binding.ownerGeneration === right.binding.ownerGeneration && left.generation === right.generation
      && left.executionId === right.executionId && left.commandId === right.commandId && left.scope === right.scope
      && left.page.outlet === right.page.outlet && left.page.routeDefinitionId === right.page.routeDefinitionId
      && left.page.roomId === right.page.roomId
  }

  protected validPageTarget(target: AgentPageAdmissionTarget | undefined): target is AgentPageAdmissionTarget {
    return target !== undefined && opaque(target.roomId) && opaque(target.participantId)
      && opaque(target.memberId) && opaque(target.runId)
  }

  protected validPageRouteTarget(
    target: AgentPageAdmissionRouteTarget | undefined,
  ): target is AgentPageAdmissionRouteTarget {
    return this.validPageTarget(target) && target.route !== undefined && opaque(target.route.outlet)
      && opaque(target.route.routeDefinitionId) && target.route.param === 'roomId'
      && target.route.roomId === target.roomId
  }

  protected pageDestination(route: AgentPageRoomRoute): HostPageAdmissionDestinationRoute {
    return {
      outlet: route.outlet,
      routeDefinitionId: route.routeDefinitionId,
      param: 'roomId',
      roomId: route.roomId,
    }
  }

  protected closePageAdmissionCaptures(command: PageAdmissionCommand): void {
    for (const record of this.pageAdmissionTargets.values()) {
      if (record.command.executionId !== command.executionId) continue
      record.revoked = true
      record.capture?.close()
    }
  }

  protected samePageRoomRoute(route: AgentPageRoomRoute, command: PageAdmissionCommandRecord): boolean {
    return command.freshNavigation?.token !== undefined && route.outlet === command.route.outlet
      && route.routeDefinitionId !== command.route.routeDefinitionId && route.param === 'roomId'
      && route.roomId !== ''
  }

  protected pageDeniedDeliveryCode(
    code: string,
  ): Extract<AgentPageComposerCommandResult, { readonly status: 'failed' }>['deliveries'][number] extends infer Delivery
    ? Delivery extends { readonly status: 'denied'; readonly code: infer Value } ? Value : never
    : never
  {
    return ([
        'reservation-denied',
        'submit-denied',
        'stale',
        'page-replaced',
        'plugin-generation-replaced',
        'connection-replaced',
        'command-complete',
        'revoked',
      ] as const)
        .includes(code as never)
      ? code as never
      : 'reservation-denied' as never
  }

  protected validAgentDetailReference(value: AgentDetailReference | undefined): value is AgentDetailReference {
    return value !== undefined && plainObject(value) && hasExactKeys(value, ['kind', 'ref'])
      && value.kind === 'host' && opaque(value.ref) && value.ref !== '*'
  }

  protected sameAgentDetailReference(left: AgentDetailReference, right: AgentDetailReference): boolean {
    return left.kind === right.kind && left.ref === right.ref
  }

  protected validAdmissionOrigin(origin: AgentCommandOrigin | undefined): origin is AgentCommandOrigin {
    return origin !== undefined && origin.scope === 'composer-submit' && opaque(origin.originId)
      && opaque(origin.executionId) && opaque(origin.binding.bindingId)
      && opaque(origin.binding.ownerGeneration) && opaque(origin.generation)
      && opaque(origin.commandId) && opaque(origin.room.roomId)
      && opaque(origin.room.participantId) && opaque(origin.room.memberId) && opaque(origin.room.runId)
  }

  protected validAdmissionTarget(target: AgentAdmissionTarget | undefined): target is AgentAdmissionTarget {
    return target !== undefined && opaque(target.participantId) && opaque(target.memberId) && opaque(target.runId)
  }

  protected sameAdmissionOrigin(left: AgentCommandOrigin, right: AgentCommandOrigin): boolean {
    return left.originId === right.originId && left.executionId === right.executionId
      && left.binding.bindingId === right.binding.bindingId
      && left.binding.ownerGeneration === right.binding.ownerGeneration
      && left.generation === right.generation && left.commandId === right.commandId && left.scope === right.scope
      && left.room.roomId === right.room.roomId && left.room.participantId === right.room.participantId
      && left.room.memberId === right.room.memberId && left.room.runId === right.room.runId
  }

  protected validBootstrapAdmissionOrigin(
    origin: AgentBootstrapCommandOrigin | undefined,
  ): origin is AgentBootstrapCommandOrigin {
    return origin !== undefined
      && origin.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json'
      && origin.contract === 'cordisx.agent-bootstrap-command-origin/v1' && origin.schemaVersion === 1
      && origin.scope === 'composer-submit' && opaque(origin.originId) && opaque(origin.executionId)
      && opaque(origin.binding.bindingId) && opaque(origin.binding.ownerGeneration)
      && opaque(origin.generation) && opaque(origin.commandId)
  }

  protected targetIssueKey(
    owner: PluginOwnerIdentity,
    origin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
  ): string {
    return `${
      ownerKey(owner)
    }\u0000${origin.originId}\u0000${origin.executionId}\u0000${target.participantId}\u0000${target.memberId}\u0000${target.runId}`
  }

  protected bootstrapTargetIssueKey(
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionTarget,
  ): string {
    return `${
      ownerKey(owner)
    }\u0000${origin.originId}\u0000${origin.executionId}\u0000${target.participantId}\u0000${target.memberId}\u0000${target.runId}`
  }

  protected validBootstrapRoomTarget(
    target: AgentAdmissionBootstrapRoomTarget | undefined,
  ): target is AgentAdmissionBootstrapRoomTarget {
    return target !== undefined && opaque(target.roomId) && opaque(target.participantId)
      && opaque(target.memberId) && opaque(target.runId)
  }

  protected sameBootstrapRoomTarget(
    left: AgentAdmissionBootstrapRoomTarget,
    right: AgentAdmissionBootstrapRoomTarget,
  ): boolean {
    return left.roomId === right.roomId && left.participantId === right.participantId
      && left.memberId === right.memberId && left.runId === right.runId
  }

  protected bootstrapRoomIssueKey(
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRoomTarget,
  ): string {
    return `${
      this.bootstrapRouteCommandKey(owner, origin)
    }\u0000${target.roomId}\u0000${target.participantId}\u0000${target.memberId}\u0000${target.runId}`
  }

  protected validBootstrapRoomOrigin(origin: unknown): origin is AgentAdmissionBootstrapRoomTargetOrigin {
    return plainObject(origin) && hasExactKeys(origin, ['$schema', 'contract', 'schemaVersion', 'token'])
      && origin.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-origin.v5.schema.json'
      && origin.contract === 'cordisx.agent-admission-bootstrap-room-target-origin/v5'
      && origin.schemaVersion === 5 && opaque(origin.token)
  }

  protected validBootstrapRouteTarget(
    target: AgentAdmissionBootstrapRouteTarget | undefined,
  ): target is AgentAdmissionBootstrapRouteTarget {
    return target !== undefined && opaque(target.roomId) && opaque(target.participantId) && opaque(target.memberId)
      && opaque(target.runId)
      && target.route !== undefined && opaque(target.route.routeId) && target.route.param === 'roomId'
      && opaque(target.route.roomId) && target.route.roomId === target.roomId
  }

  protected sameBootstrapRouteTarget(
    left: AgentAdmissionBootstrapRouteTarget,
    right: AgentAdmissionBootstrapRouteTarget,
  ): boolean {
    return left.roomId === right.roomId && left.participantId === right.participantId
      && left.memberId === right.memberId && left.runId === right.runId
      && left.route.routeId === right.route.routeId && left.route.param === right.route.param
      && left.route.roomId === right.route.roomId
  }

  protected validBootstrapRouteContinuation(value: unknown): value is AgentAdmissionBootstrapRouteContinuation {
    return plainObject(value) && hasExactKeys(value, ['$schema', 'contract', 'schemaVersion', 'token'])
      && value.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-continuation.v6.schema.json'
      && value.contract === 'cordisx.agent-admission-bootstrap-route-continuation/v6'
      && value.schemaVersion === 6 && opaque(value.token)
  }

  protected validBootstrapRouteClaimRequest(request: unknown): request is AgentAdmissionBootstrapRouteClaimRequest {
    if (
      !plainObject(request) || !hasExactKeys(request, ['continuation', 'binding', 'source'])
      || !this.validBootstrapRouteContinuation(request.continuation)
      || !plainObject(request.binding) || !hasExactKeys(request.binding, ['binding', 'generation', 'route'])
      || !plainObject(request.binding.binding)
      || !hasExactKeys(request.binding.binding, ['bindingId', 'ownerGeneration'])
      || !plainObject(request.binding.route) || !hasExactKeys(request.binding.route, ['routeId', 'param', 'roomId'])
      || !plainObject(request.source) || !hasExactKeys(request.source, ['sessionId', 'messageId'])
    ) return false
    return opaque(request.binding.binding.bindingId) && opaque(request.binding.binding.ownerGeneration)
      && opaque(request.binding.generation) && opaque(request.binding.route.routeId)
      && request.binding.route.param === 'roomId' && opaque(request.binding.route.roomId)
      && opaque(request.source.sessionId) && opaque(request.source.messageId)
  }

  protected bootstrapRouteCommandKey(owner: PluginOwnerIdentity, origin: AgentBootstrapCommandOrigin): string {
    return `${
      ownerKey(owner)
    }\u0000${origin.originId}\u0000${origin.executionId}\u0000${origin.binding.bindingId}\u0000${origin.binding.ownerGeneration}\u0000${origin.generation}\u0000${origin.commandId}`
  }

  protected bootstrapRouteIssueKey(
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
  ): string {
    return `${
      this.bootstrapRouteCommandKey(owner, origin)
    }\u0000${target.roomId}\u0000${target.participantId}\u0000${target.memberId}\u0000${target.runId}\u0000${target.route.routeId}\u0000${target.route.param}\u0000${target.route.roomId}`
  }
  protected abstract allowed(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ): Promise<boolean>

  protected abstract sessionHandle(owner: PluginOwnerIdentity, record: SessionRecord): Session

  protected abstract recordForAgent(value: Agent): AgentRecord | undefined

  protected abstract sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean

  protected abstract approvalDecision(
    record: AgentRecord | Agent,
    id: string,
    toolName: string,
    callId: string | undefined,
    outcome: ApprovalOutcome,
  ): ApprovalDecisionV1

  protected abstract approvalQuestion(
    record: AgentRecord,
    id: string,
    toolName: string,
    callId?: string,
    reason?: string,
  ): ApprovalQuestionV1

  protected abstract answererKey(record: AgentRecord): string

  protected abstract current(record: AgentRecord): boolean

  protected abstract closeAnswerer(
    record: AgentRecord,
    answerer: AnswererRecord,
    code: NonNullable<AnswererRecord['closed']>,
  ): void

  protected abstract recordForApprovalTarget(target: ApprovalAgentTarget): AgentRecord | undefined

  protected abstract approvalDecisionV2(
    requester: AgentRecord,
    authority: AgentRecord,
    id: string,
    outcome: ApprovalOutcome,
  ): ApprovalDecisionV2

  protected abstract approvalQuestionV2(
    requester: AgentRecord,
    authority: AgentRecord,
    id: string,
    toolName: string,
    callId: string | undefined,
    reason: ApprovalRequestV2['reason'],
  ): ApprovalQuestionV2

  protected abstract approvalBinding(record: AgentRecord): ApprovalAgentBinding

  protected abstract closeAuthorityAnswerer(
    record: AgentRecord,
    answerer: AuthorityAnswererRecord,
    code: NonNullable<AuthorityAnswererRecord['closed']>,
  ): void

  protected abstract closeRequestResolver(
    resolver: RequestResolverRecord,
    code: ApprovalRequestResolverClosed['code'],
  ): ApprovalRequestResolverClosed

  protected abstract clearAdmissionCapabilities(): void

  protected abstract disposeAgent(
    record: AgentRecord,
    reason: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced',
  ): void

  protected abstract closeSession(
    record: SessionRecord,
    code: NonNullable<SessionRecord['closed']>,
    subscriberCode?: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>,
  ): void

  protected abstract submitAdmission(
    owner: PluginOwnerIdentity,
    record: AgentRecord,
    message: UserMessage,
    target: 'next-turn' | 'next-step',
    wakeup: boolean,
    captured?: PlaygroundScenarioSubmissionCapture,
  ): Promise<Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never>
}
