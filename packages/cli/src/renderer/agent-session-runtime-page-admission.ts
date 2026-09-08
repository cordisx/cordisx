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
import { AgentSessionRuntimeAdmission } from './agent-session-runtime-admission.js'
import {
  AgentRecord,
  AnswererRecord,
  AuthorityAnswererRecord,
  clone,
  CordisXPrivateAgentDriver,
  opaque,
  ownerKey,
  PAGE_CONTEXT_SCHEMA_V2,
  PAGE_FRESH_NAVIGATION_SCHEMA,
  PAGE_ORIGIN_SCHEMA,
  PAGE_ROUTE_CLAIM_RECEIPT_SCHEMA,
  PAGE_ROUTE_CONTINUATION_SCHEMA,
  PAGE_TARGET_ORIGIN_SCHEMA,
  PAGE_TARGET_RECEIPT_SCHEMA,
  RequestResolverRecord,
  ROUTING_CLOSE_SCHEMA,
  SessionRecord,
} from './agent-session-runtime-types.js'

export abstract class AgentSessionRuntimePageAdmission extends AgentSessionRuntimeAdmission {
  beginPageComposerCommand(
    owner: PluginOwnerIdentity,
    input: {
      readonly binding: PageAdmissionBinding
      readonly route: HostPageAdmissionRoute
      readonly generation: string
      readonly commandId: string
      readonly submitPayload: string
    },
  ): AgentPageComposerCommandContext | undefined {
    const lifecycle = this.options.pageAdmissionBindings
    if (
      this.disposed || lifecycle === undefined || !opaque(input.generation) || !opaque(input.commandId)
      || typeof input.submitPayload !== 'string' || input.submitPayload.length < 1
      || [...input.submitPayload].length > 65_536
    ) return undefined
    const command = lifecycle.begin(input.binding, input.commandId)
    const route = command === undefined ? undefined : lifecycle.route(command)
    if (
      command === undefined || route === undefined || !lifecycle.active(command)
      || route.outlet !== input.route.outlet || route.routeDefinitionId !== input.route.routeDefinitionId
      || route.roomId !== input.route.roomId
    ) return undefined
    const origin = Object.freeze({
      $schema: PAGE_ORIGIN_SCHEMA,
      contract: 'cordisx.agent-page-composer-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: command.originId,
      binding: Object.freeze({ ...command.binding }),
      generation: input.generation,
      executionId: command.executionId,
      commandId: input.commandId,
      scope: 'page-composer-submit' as const,
      page: Object.freeze({
        outlet: route.outlet,
        routeDefinitionId: route.routeDefinitionId,
        ...(route.roomId === undefined ? {} : { roomId: route.roomId }),
      }),
    }) as AgentPageComposerOrigin
    const freshRoomNavigation = command.freshNavigationToken === undefined
      ? undefined
      : Object.freeze({
        $schema: PAGE_FRESH_NAVIGATION_SCHEMA,
        contract: 'cordisx.agent-page-fresh-room-navigation/v1' as const,
        schemaVersion: 1 as const,
        token: command.freshNavigationToken,
      }) as AgentPageFreshRoomNavigation
    this.pageAdmissionCommands.set(origin.originId, {
      owner: Object.freeze(clone(owner)),
      command,
      origin,
      route: Object.freeze({ ...route }),
      ...(freshRoomNavigation === undefined ? {} : { freshNavigation: freshRoomNavigation }),
    })
    return Object.freeze({
      $schema: PAGE_CONTEXT_SCHEMA_V2,
      contract: 'cordisx.agent-page-composer-command-context/v2' as const,
      schemaVersion: 2 as const,
      binding: Object.freeze({ ...command.binding }),
      generation: input.generation,
      scope: 'page-composer-submit' as const,
      command: Object.freeze({ id: input.commandId }),
      submitPayload: input.submitPayload,
      origin,
      ...(freshRoomNavigation === undefined ? {} : { freshRoomNavigation }),
    }) as AgentPageComposerCommandContext
  }

  finishPageComposerCommand(
    owner: PluginOwnerIdentity,
    context: AgentPageComposerCommandContext,
    failure?: unknown,
  ): AgentPageComposerCommandResult {
    const issued = this.pageCommand(owner, context.origin)
    if (issued === undefined) return { status: 'unavailable', code: 'page-replaced' }
    const lifecycle = this.options.pageAdmissionBindings
    if (lifecycle === undefined) return { status: 'unavailable', code: 'host-unavailable' }
    if (failure !== undefined) lifecycle.fail(issued.command, 'handler-failed')
    lifecycle.complete(issued.command)
    const completion = lifecycle.completion(issued.command)
    this.pageAdmissionCommands.delete(context.origin.originId)
    if (completion.status === 'accepted') {
      return {
        status: 'accepted',
        code: 'submitted',
        roomId: completion.roomId,
        disposition: completion.disposition,
        deliveries: completion.deliveries.map(delivery =>
          Object.freeze({
            target: Object.freeze({ ...delivery.target }),
            status: 'accepted' as const,
            sessionId: delivery.source.sessionId as SessionId,
            messageId: delivery.source.messageId as MessageId,
          })
        ) as AgentPageComposerCommandResult extends { readonly status: 'accepted'; readonly deliveries: infer Value }
          ? Value
          : never,
      }
    }
    this.closePageAdmissionCaptures(issued.command)
    return {
      status: 'failed',
      code: completion.code,
      ...(completion.roomId === undefined ? {} : { roomId: completion.roomId }),
      deliveries: completion.deliveries.map(delivery =>
        delivery.status === 'accepted'
          ? Object.freeze({
            target: Object.freeze({ ...delivery.target }),
            status: 'accepted' as const,
            sessionId: delivery.source.sessionId as SessionId,
            messageId: delivery.source.messageId as MessageId,
          })
          : Object.freeze({
            target: Object.freeze({ ...delivery.target }),
            status: 'denied' as const,
            code: this.pageDeniedDeliveryCode(delivery.code),
          })
      ),
    }
  }

  async issuePageAdmissionTarget(
    owner: PluginOwnerIdentity,
    request: AgentPageAdmissionTargetRequest,
  ): Promise<AgentPageAdmissionTargetResult> {
    const issued = this.pageCommand(owner, request.origin)
    const lifecycle = this.options.pageAdmissionBindings
    if (issued === undefined || lifecycle === undefined) return { status: 'denied', code: 'origin-denied' }
    if (!lifecycle.active(issued.command)) return { status: 'denied', code: 'page-unavailable' }
    if (!this.validPageTarget(request.target)) return { status: 'denied', code: 'target-denied' }
    const declaration = lifecycle.declare(issued.command, request.target)
    if (declaration === undefined) return { status: 'denied', code: 'duplicate-target' }
    const targetOrigin = Object.freeze({
      $schema: PAGE_TARGET_ORIGIN_SCHEMA,
      contract: 'cordisx.agent-page-admission-target-origin/v1' as const,
      schemaVersion: 1 as const,
      token: declaration.token,
    }) as AgentPageAdmissionTargetOrigin
    const receipt = Object.freeze({
      $schema: PAGE_TARGET_RECEIPT_SCHEMA,
      contract: 'cordisx.agent-page-admission-target-receipt/v1' as const,
      schemaVersion: 1 as const,
      receiptId: `cx-page-admission-target-receipt.${crypto.randomUUID()}`,
      target: Object.freeze(clone(request.target)),
    }) as AgentPageAdmissionTargetReceipt
    this.pageAdmissionTargets.set(declaration.token, {
      owner: Object.freeze(clone(owner)),
      command: issued.command,
      origin: issued.origin,
      target: Object.freeze(clone(request.target)),
      declaration,
      targetOrigin,
      receipt,
      fresh: false,
      reserved: false,
      submitted: false,
      revoked: false,
    })
    return { status: 'issued', origin: targetOrigin, receipt }
  }

  async declarePageAdmissionRoute(
    owner: PluginOwnerIdentity,
    request: AgentPageAdmissionRouteDeclarationRequest,
  ): Promise<AgentPageAdmissionRouteDeclarationResult> {
    const issued = this.pageCommand(owner, request.origin)
    const lifecycle = this.options.pageAdmissionBindings
    if (issued === undefined || lifecycle === undefined) return { status: 'denied', code: 'origin-denied' }
    if (!lifecycle.active(issued.command)) return { status: 'denied', code: 'page-unavailable' }
    if (!this.validPageRouteTarget(request.target)) return { status: 'denied', code: 'route-denied' }
    const destination: HostPageAdmissionDestinationRoute = {
      outlet: request.target.route.outlet,
      routeDefinitionId: request.target.route.routeDefinitionId,
      param: 'roomId',
      roomId: request.target.route.roomId,
    }
    const declaration = lifecycle.declare(issued.command, request.target, destination)
    if (declaration === undefined) return { status: 'denied', code: 'duplicate-target' }
    const continuation = Object.freeze({
      $schema: PAGE_ROUTE_CONTINUATION_SCHEMA,
      contract: 'cordisx.agent-page-admission-route-continuation/v1' as const,
      schemaVersion: 1 as const,
      token: declaration.token,
    }) as AgentPageAdmissionRouteContinuation
    this.pageAdmissionTargets.set(declaration.token, {
      owner: Object.freeze(clone(owner)),
      command: issued.command,
      origin: issued.origin,
      target: Object.freeze(clone(request.target)),
      declaration,
      continuation,
      fresh: true,
      reserved: false,
      submitted: false,
      revoked: false,
    })
    return { status: 'declared', continuation }
  }

  async reservePageAdmissionTarget(
    owner: PluginOwnerIdentity,
    request: AgentPageAdmissionReservationRequest,
  ): Promise<AgentPageAdmissionReservationResult> {
    const record = this.pageAdmissionTargets.get(request.origin.token)
    const result = await this.reservePageAdmission(owner, record, request.handle, request.message)
    return result as AgentPageAdmissionReservationResult
  }

  async reservePageAdmissionRoute(
    owner: PluginOwnerIdentity,
    request: AgentPageAdmissionRouteReservationRequest,
  ): Promise<AgentPageAdmissionRouteReservationResult> {
    const record = this.pageAdmissionTargets.get(request.continuation.token)
    const result = await this.reservePageAdmission(owner, record, request.handle, request.message)
    return result as AgentPageAdmissionRouteReservationResult
  }

  async navigatePageAdmission(
    owner: PluginOwnerIdentity,
    request: AgentPageFreshRoomNavigationRequest,
  ): Promise<AgentPageFreshRoomNavigationResult> {
    const command = [...this.pageAdmissionCommands.values()].find(candidate =>
      candidate.freshNavigation?.token === request.navigation.token
    )
    const lifecycle = this.options.pageAdmissionBindings
    if (command === undefined || lifecycle === undefined) return { status: 'denied', code: 'navigation-denied' }
    if (!this.sameOwner(owner, command.owner)) return { status: 'denied', code: 'not-owner' }
    if (!this.samePageRoomRoute(request.route, command)) return { status: 'denied', code: 'route-mismatch' }
    if (lifecycle.freshNavigation(command.command, this.pageDestination(request.route)) === undefined) {
      return { status: 'denied', code: 'incomplete-submission' }
    }
    const navigated = await this.options.navigatePageAdmission?.(owner, command.command, request.route)
    if (navigated !== 'accepted') {
      lifecycle.fail(command.command, 'navigation-failed')
      this.closePageAdmissionCaptures(command.command)
      command.navigation = { status: 'unavailable', code: 'navigation-failed' }
      return command.navigation
    }
    if (command.navigation?.status === 'accepted') return command.navigation
    lifecycle.fail(command.command, 'claim-failed')
    this.closePageAdmissionCaptures(command.command)
    command.navigation = { status: 'unavailable', code: 'claim-failed' }
    return command.navigation
  }

  claimPageAdmissionBinding(binding: PageAdmissionBinding): readonly AgentPageAdmissionRouteClaimReceipt[] {
    const lifecycle = this.options.pageAdmissionBindings
    if (lifecycle === undefined) return []
    const claims = lifecycle.claim(binding)
    const receipts: AgentPageAdmissionRouteClaimReceipt[] = []
    for (const claim of claims) {
      const record = this.pageAdmissionTargets.get(claim.declaration.token)
      if (record === undefined || !record.fresh || record.continuation === undefined || record.submitted === false) {
        continue
      }
      const command = this.pageAdmissionCommands.get(record.origin.originId)
      if (command === undefined || !this.sameOwner(record.owner, command.owner)) continue
      if (!('route' in record.target)) continue
      const route = record.target.route
      const receipt = Object.freeze({
        $schema: PAGE_ROUTE_CLAIM_RECEIPT_SCHEMA,
        contract: 'cordisx.agent-page-admission-route-claim-receipt/v1' as const,
        schemaVersion: 1 as const,
        receiptId: `cx-page-admission-route-claim.${crypto.randomUUID()}`,
        owner: Object.freeze(clone(record.owner)),
        origin: Object.freeze(clone(record.origin)),
        target: Object.freeze(clone(record.target)),
        binding: Object.freeze({
          binding: Object.freeze({ ...binding }),
          generation: record.origin.generation,
          route: Object.freeze(clone(route)),
        }),
        source: Object.freeze({ sessionId: claim.source.sessionId, messageId: claim.source.messageId }),
      }) as AgentPageAdmissionRouteClaimReceipt
      if (
        record.capture !== undefined
        && this.options.claimPageAdmission?.(
            record.owner,
            receipt,
            () => lifecycle.bindingActive(binding),
          ) !== true
      ) {
        record.revoked = true
        record.capture.close()
        lifecycle.fail(command.command, 'claim-failed')
        continue
      }
      command.navigation = { status: 'accepted', code: 'claimed', roomId: route.roomId }
      receipts.push(receipt)
    }
    return Object.freeze(receipts)
  }

  async reserveAdmission(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionReservationRequest,
  ): Promise<AgentAdmissionReservationResult> {
    if (
      this.disposed || !this.validAdmissionOrigin(request.origin) || request.message === undefined
      || typeof request.message.text !== 'string' || request.message.text.length < 1
      || [...request.message.text].length > 65_536
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const record = this.handleCapabilities.get(request.handle as object)
    if (record === undefined || record.generation !== request.handle.agent.generation) {
      return { status: 'denied', code: 'stale' }
    }
    if (!this.sameOwner(owner, record.owner)) return { status: 'denied', code: 'not-owner' }
    if (!this.current(record)) return { status: 'denied', code: 'stale' }
    const originKey = `${ownerKey(owner)}\u0000${request.origin.originId}`
    if (this.reservedAdmissionOrigins.has(originKey)) return { status: 'denied', code: 'reused' }
    const messageId = `cx-message.${crypto.randomUUID()}` as MessageId
    const message = Object.freeze({
      id: messageId,
      role: 'user' as const,
      content: Object.freeze([{ type: 'text' as const, text: request.message.text }]),
      source: Object.freeze({ kind: 'plugin' as const, pluginId: owner.pluginId, generation: owner.generation }),
    }) as UserMessage
    const sourceCapture = this.options.captureAdmission?.(
      owner,
      request.origin,
      record.id,
      record.generation,
      messageId,
    )
    if (sourceCapture === undefined) return { status: 'denied', code: 'origin-denied' }
    this.reservedAdmissionOrigins.add(originKey)
    let used = false
    let revoked = false
    const reservation = Object.freeze({
      reservationId: `cx-admission-reservation.${crypto.randomUUID()}`,
      submit: async () => {
        if (used || revoked || !this.current(record) || !sourceCapture.active()) {
          throw new Error('agent-admission reservation unavailable')
        }
        used = true
        const result = await this.submitAdmission(owner, record, message, 'next-turn', true, sourceCapture)
        if (result.status !== 'accepted') throw new Error('agent-admission submit denied')
        return result
      },
      revoke: async () => {
        if (!revoked && !used) sourceCapture.close()
        revoked = true
      },
    })
    return { status: 'reserved', reservation: reservation as never }
  }

  fenceSession(
    sessionId: string,
    code: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>,
  ): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) {
      this.closeSession(
        session,
        code === 'route-replaced'
          ? 'host-unavailable'
          : code === 'connection-replaced'
          ? 'connection-replaced'
          : 'host-unavailable',
        code,
      )
    }
  }

  fenceOwner(
    ownerPluginId: string,
    code: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>,
  ): void {
    this.clearAdmissionCapabilitiesForOwner(ownerPluginId)
    for (const agent of this.agents.values()) {
      if (agent.owner.pluginId !== ownerPluginId) continue
      const answerer = this.answerers.get(this.answererKey(agent))
      if (answerer !== undefined) {
        this.closeAnswerer(
          agent,
          answerer,
          code === 'plugin-generation-replaced'
            ? 'plugin-generation-replaced'
            : code === 'permission-revoked'
            ? 'permission-revoked'
            : 'agent-replaced',
        )
      }
      const authorityAnswerer = this.authorityAnswerers.get(this.answererKey(agent))
      if (authorityAnswerer !== undefined) {
        this.closeAuthorityAnswerer(
          agent,
          authorityAnswerer,
          code === 'plugin-generation-replaced'
            ? 'plugin-generation-replaced'
            : code === 'permission-revoked'
            ? 'permission-revoked'
            : code === 'connection-replaced'
            ? 'connection-replaced'
            : 'authority-replaced',
        )
      }
      const requestResolver = this.requestResolvers.get(this.answererKey(agent))
      if (requestResolver !== undefined) {
        this.closeRequestResolver(
          requestResolver,
          code === 'plugin-generation-replaced'
            ? 'plugin-generation-replaced'
            : code === 'permission-revoked'
            ? 'permission-revoked'
            : code === 'connection-replaced'
            ? 'connection-replaced'
            : 'requester-replaced',
        )
      }
      this.disposeAgent(agent, code === 'connection-replaced' ? 'connection-replaced' : 'owner-disposed')
      this.closeSession(
        agent.session,
        code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable',
        code,
      )
    }
  }
  protected abstract sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean

  protected abstract current(record: AgentRecord): boolean

  protected abstract submitAdmission(
    owner: PluginOwnerIdentity,
    record: AgentRecord,
    message: UserMessage,
    target: 'next-turn' | 'next-step',
    wakeup: boolean,
    captured?: PlaygroundScenarioSubmissionCapture,
  ): Promise<Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never>

  protected abstract closeSession(
    record: SessionRecord,
    code: NonNullable<SessionRecord['closed']>,
    subscriberCode?: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>,
  ): void

  protected abstract clearAdmissionCapabilitiesForOwner(ownerPluginId: string): void

  protected abstract answererKey(record: AgentRecord): string

  protected abstract closeAnswerer(
    record: AgentRecord,
    answerer: AnswererRecord,
    code: NonNullable<AnswererRecord['closed']>,
  ): void

  protected abstract closeAuthorityAnswerer(
    record: AgentRecord,
    answerer: AuthorityAnswererRecord,
    code: NonNullable<AuthorityAnswererRecord['closed']>,
  ): void

  protected abstract closeRequestResolver(
    resolver: RequestResolverRecord,
    code: ApprovalRequestResolverClosed['code'],
  ): ApprovalRequestResolverClosed

  protected abstract disposeAgent(
    record: AgentRecord,
    reason: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced',
  ): void
}
