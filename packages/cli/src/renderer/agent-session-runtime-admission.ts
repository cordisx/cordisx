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
import { AgentSessionRuntimeDetails } from './agent-session-runtime-details.js'
import {
  AgentRecord,
  clone,
  CordisXPrivateAgentDriver,
  hasExactKeys,
  opaque,
  plainObject,
} from './agent-session-runtime-types.js'

export abstract class AgentSessionRuntimeAdmission extends AgentSessionRuntimeDetails {
  async issueAdmissionTargetOrigin(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionTargetOriginRequest,
  ): Promise<AgentAdmissionTargetOriginResult> {
    if (this.disposed || !this.validAdmissionOrigin(request.origin) || !this.validAdmissionTarget(request.target)) {
      return { status: 'denied', code: 'origin-denied' }
    }
    if (this.options.admissionTargetActive?.(owner, request.origin, request.target) !== true) {
      return { status: 'denied', code: 'target-denied' }
    }
    const issueKey = this.targetIssueKey(owner, request.origin, request.target)
    if (this.issuedAdmissionTargets.has(issueKey)) return { status: 'denied', code: 'reused' }
    const token = `cx-admission-target-origin.${crypto.randomUUID()}`
    const origin = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-target-origin.v3.schema.json' as const,
      contract: 'cordisx.agent-admission-target-origin/v3' as const,
      schemaVersion: 3 as const,
      token,
    }) as AgentAdmissionTargetOrigin
    this.issuedAdmissionTargets.add(issueKey)
    this.targetAdmissionOrigins.set(
      token,
      Object.freeze({
        owner: Object.freeze(clone(owner)),
        origin: Object.freeze(clone(request.origin)),
        target: Object.freeze(clone(request.target)),
        reserved: false,
      }),
    )
    return { status: 'issued', origin }
  }

  async reserveAdmissionTarget(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionTargetReservationRequest,
  ): Promise<AgentAdmissionTargetReservationResult> {
    if (
      this.disposed || request.origin === undefined || request.message === undefined
      || request.origin.$schema
        !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-target-origin.v3.schema.json'
      || request.origin.contract !== 'cordisx.agent-admission-target-origin/v3' || request.origin.schemaVersion !== 3
      || typeof request.origin.token !== 'string' || request.origin.token.length < 1
      || request.origin.token.length > 4_096
      || typeof request.message.text !== 'string' || request.message.text.length < 1
      || request.message.text.length > 65_536
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const issued = this.targetAdmissionOrigins.get(request.origin.token)
    if (issued === undefined || !this.sameOwner(owner, issued.owner)) return { status: 'denied', code: 'not-owner' }
    if (issued.reserved) return { status: 'denied', code: 'reused' }
    if (this.options.admissionTargetActive?.(owner, issued.origin, issued.target) !== true) {
      return { status: 'denied', code: 'command-complete' }
    }
    const record = this.handleCapabilities.get(request.handle as object)
    if (record === undefined || record.generation !== request.handle.agent.generation || !this.current(record)) {
      return { status: 'denied', code: 'stale' }
    }
    if (!this.sameOwner(owner, record.owner)) return { status: 'denied', code: 'not-owner' }
    const messageId = `cx-message.${crypto.randomUUID()}` as MessageId
    const message = Object.freeze({
      id: messageId,
      role: 'user' as const,
      content: Object.freeze([{ type: 'text' as const, text: request.message.text }]),
      source: Object.freeze({ kind: 'plugin' as const, pluginId: owner.pluginId, generation: owner.generation }),
    }) as UserMessage
    const sourceCapture = this.options.captureAdmissionTarget?.(
      owner,
      issued.origin,
      issued.target,
      record.id,
      record.generation,
      messageId,
    )
    if (sourceCapture === undefined) return { status: 'denied', code: 'target-mismatch' }
    this.targetAdmissionOrigins.set(request.origin.token, Object.freeze({ ...issued, reserved: true }))
    let used = false
    let revoked = false
    const reservation = Object.freeze({
      reservationId: `cx-admission-target-reservation.${crypto.randomUUID()}`,
      submit: async () => {
        if (
          used || revoked || !this.current(record) || !sourceCapture.active()
          || this.options.admissionTargetActive?.(owner, issued.origin, issued.target) !== true
        ) {
          throw new Error('agent-admission target reservation unavailable')
        }
        used = true
        const result = await this.submitAdmission(owner, record, message, 'next-turn', true, sourceCapture)
        if (result.status !== 'accepted') throw new Error('agent-admission target submit denied')
        return result
      },
      revoke: async () => {
        if (!revoked && !used) sourceCapture.close()
        revoked = true
      },
    })
    return { status: 'reserved', reservation: reservation as never }
  }

  async issueAdmissionBootstrapTarget(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapTargetRequest,
  ): Promise<AgentAdmissionBootstrapTargetResult> {
    if (
      this.disposed || !this.validBootstrapAdmissionOrigin(request.origin) || !this.validAdmissionTarget(request.target)
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    if (this.options.bootstrapAdmissionTargetActive?.(owner, request.origin, request.target) !== true) {
      return { status: 'denied', code: 'target-denied' }
    }
    const issueKey = this.bootstrapTargetIssueKey(owner, request.origin, request.target)
    if (this.issuedBootstrapAdmissionTargets.has(issueKey)) return { status: 'denied', code: 'reused' }
    const token = `cx-admission-bootstrap-target-origin.${crypto.randomUUID()}`
    const origin = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-target-origin.v4.schema.json' as const,
      contract: 'cordisx.agent-admission-bootstrap-target-origin/v4' as const,
      schemaVersion: 4 as const,
      token,
    }) as AgentAdmissionBootstrapTargetOrigin
    this.issuedBootstrapAdmissionTargets.add(issueKey)
    this.bootstrapAdmissionTargets.set(
      token,
      Object.freeze({
        owner: Object.freeze(clone(owner)),
        origin: Object.freeze(clone(request.origin)),
        target: Object.freeze(clone(request.target)),
        connectionGeneration: this.connectionGeneration,
        reserved: false,
      }),
    )
    return { status: 'issued', origin }
  }

  async reserveAdmissionBootstrapTarget(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapReservationRequest,
  ): Promise<AgentAdmissionBootstrapReservationResult> {
    if (
      this.disposed || request.origin === undefined || request.message === undefined
      || request.origin.$schema
        !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-target-origin.v4.schema.json'
      || request.origin.contract !== 'cordisx.agent-admission-bootstrap-target-origin/v4'
      || request.origin.schemaVersion !== 4
      || typeof request.origin.token !== 'string' || request.origin.token.length < 1
      || request.origin.token.length > 4_096
      || typeof request.message.text !== 'string' || request.message.text.length < 1
      || request.message.text.length > 65_536
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const issued = this.bootstrapAdmissionTargets.get(request.origin.token)
    if (issued === undefined || !this.sameOwner(owner, issued.owner)) return { status: 'denied', code: 'not-owner' }
    if (issued.reserved) return { status: 'denied', code: 'reused' }
    if (
      issued.connectionGeneration !== this.connectionGeneration
      || this.options.bootstrapAdmissionTargetActive?.(owner, issued.origin, issued.target) !== true
    ) {
      return { status: 'denied', code: 'command-complete' }
    }
    const record = this.handleCapabilities.get(request.handle as object)
    if (record === undefined || record.generation !== request.handle.agent.generation || !this.current(record)) {
      return { status: 'denied', code: 'stale' }
    }
    if (!this.sameOwner(owner, record.owner)) return { status: 'denied', code: 'not-owner' }
    const messageId = `cx-message.${crypto.randomUUID()}` as MessageId
    const message = Object.freeze({
      id: messageId,
      role: 'user' as const,
      content: Object.freeze([{ type: 'text' as const, text: request.message.text }]),
      source: Object.freeze({ kind: 'plugin' as const, pluginId: owner.pluginId, generation: owner.generation }),
    }) as UserMessage
    const sourceCapture = this.options.captureBootstrapAdmissionTarget?.(
      owner,
      issued.origin,
      issued.target,
      record.id,
      record.generation,
      messageId,
    )
    if (sourceCapture === undefined) return { status: 'denied', code: 'target-mismatch' }
    if (
      !sourceCapture.active()
      || this.options.bootstrapAdmissionTargetActive?.(owner, issued.origin, issued.target) !== true
    ) {
      sourceCapture.close()
      return { status: 'denied', code: 'command-complete' }
    }
    this.bootstrapAdmissionTargets.set(
      request.origin.token,
      Object.freeze({
        ...issued,
        reserved: true,
        handleId: record.id,
        handleGeneration: record.generation,
      }),
    )
    let used = false
    let revoked = false
    const reservation = Object.freeze({
      reservationId: `cx-admission-bootstrap-reservation.${crypto.randomUUID()}`,
      submit: async () => {
        const current = this.bootstrapAdmissionTargets.get(request.origin.token)
        if (
          used || revoked || current === undefined || !current.reserved
          || current.handleId !== record.id || current.handleGeneration !== record.generation
          || current.connectionGeneration !== this.connectionGeneration || !this.current(record)
          || !sourceCapture.active()
          || this.options.bootstrapAdmissionTargetActive?.(owner, issued.origin, issued.target) !== true
        ) {
          throw new Error('agent-admission bootstrap reservation unavailable')
        }
        used = true
        const result = await this.submitAdmission(owner, record, message, 'next-turn', true, sourceCapture)
        if (result.status !== 'accepted') throw new Error('agent-admission bootstrap submit denied')
        return result
      },
      revoke: async () => {
        if (!revoked && !used) sourceCapture.close()
        revoked = true
      },
    })
    return { status: 'reserved', reservation: reservation as never }
  }

  async issueAdmissionBootstrapRoomTarget(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapRoomTargetRequest,
  ): Promise<AgentAdmissionBootstrapRoomTargetResult> {
    if (this.disposed || !this.validBootstrapAdmissionOrigin(request.origin)) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const target = request.target
    if (target === undefined || !opaque(target.roomId)) return { status: 'denied', code: 'room-denied' }
    if (!this.validBootstrapRoomTarget(target)) return { status: 'denied', code: 'target-denied' }
    if (this.options.bootstrapAdmissionRoomTargetActive?.(owner, request.origin, target) !== true) {
      return { status: 'denied', code: 'target-denied' }
    }
    const commandKey = this.bootstrapRouteCommandKey(owner, request.origin)
    const declaredRoom = this.bootstrapAdmissionRoomRooms.get(commandKey)
    if (declaredRoom !== undefined && declaredRoom !== target.roomId) return { status: 'denied', code: 'cross-room' }
    const issueKey = this.bootstrapRoomIssueKey(owner, request.origin, target)
    if (this.issuedBootstrapAdmissionRoomTargets.has(issueKey)) return { status: 'denied', code: 'duplicate-target' }
    const token = `cx-admission-bootstrap-room-target-origin.${crypto.randomUUID()}`
    const origin = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-origin.v5.schema.json' as const,
      contract: 'cordisx.agent-admission-bootstrap-room-target-origin/v5' as const,
      schemaVersion: 5 as const,
      token,
    }) as AgentAdmissionBootstrapRoomTargetOrigin
    const receipt = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-receipt.v5.schema.json' as const,
      contract: 'cordisx.agent-admission-bootstrap-room-target-receipt/v5' as const,
      schemaVersion: 5 as const,
      receiptId: `cx-admission-bootstrap-room-receipt.${crypto.randomUUID()}`,
      target: Object.freeze(clone(target)),
    }) as AgentAdmissionBootstrapRoomTargetReceipt
    this.bootstrapAdmissionRoomRooms.set(commandKey, target.roomId)
    this.issuedBootstrapAdmissionRoomTargets.add(issueKey)
    this.bootstrapAdmissionRoomTargets.set(
      token,
      Object.freeze({
        owner: Object.freeze(clone(owner)),
        origin: Object.freeze(clone(request.origin)),
        target: Object.freeze(clone(target)),
        receipt,
        connectionGeneration: this.connectionGeneration,
        reserved: false,
      }),
    )
    return { status: 'issued', origin, receipt }
  }

  async reserveAdmissionBootstrapRoomTarget(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapRoomReservationRequest,
  ): Promise<AgentAdmissionBootstrapRoomReservationResult> {
    if (
      this.disposed || !this.validBootstrapRoomOrigin(request.origin) || request.message === undefined
      || typeof request.message.text !== 'string' || request.message.text.length < 1
      || request.message.text.length > 65_536
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const issued = this.bootstrapAdmissionRoomTargets.get(request.origin.token)
    if (issued === undefined || !this.sameOwner(owner, issued.owner)) return { status: 'denied', code: 'not-owner' }
    if (issued.reserved) return { status: 'denied', code: 'reused' }
    if (
      issued.connectionGeneration !== this.connectionGeneration
      || this.options.bootstrapAdmissionRoomTargetActive?.(owner, issued.origin, issued.target) !== true
    ) {
      return { status: 'denied', code: 'command-complete' }
    }
    const record = this.handleCapabilities.get(request.handle as object)
    if (record === undefined || record.generation !== request.handle.agent.generation || !this.current(record)) {
      return { status: 'denied', code: 'stale' }
    }
    if (!this.sameOwner(owner, record.owner)) return { status: 'denied', code: 'not-owner' }
    const messageId = `cx-message.${crypto.randomUUID()}` as MessageId
    const message = Object.freeze({
      id: messageId,
      role: 'user' as const,
      content: Object.freeze([{ type: 'text' as const, text: request.message.text }]),
      source: Object.freeze({ kind: 'plugin' as const, pluginId: owner.pluginId, generation: owner.generation }),
    }) as UserMessage
    const sourceCapture = this.options.captureBootstrapAdmissionRoomTarget?.(
      owner,
      issued.origin,
      issued.target,
      issued.receipt,
      record.id,
      record.generation,
      messageId,
    )
    if (sourceCapture === undefined) return { status: 'denied', code: 'target-mismatch' }
    if (
      !sourceCapture.active()
      || this.options.bootstrapAdmissionRoomTargetActive?.(owner, issued.origin, issued.target) !== true
    ) {
      sourceCapture.close()
      return { status: 'denied', code: 'command-complete' }
    }
    this.bootstrapAdmissionRoomTargets.set(
      request.origin.token,
      Object.freeze({
        ...issued,
        reserved: true,
        handleId: record.id,
        handleGeneration: record.generation,
        capture: sourceCapture,
      }),
    )
    let used = false
    let revoked = false
    const reservation = Object.freeze({
      reservationId: `cx-admission-bootstrap-room-reservation.${crypto.randomUUID()}`,
      submit: async () => {
        const current = this.bootstrapAdmissionRoomTargets.get(request.origin.token)
        if (
          used || revoked || current === undefined || !current.reserved
          || current.handleId !== record.id || current.handleGeneration !== record.generation
          || current.connectionGeneration !== this.connectionGeneration || !this.current(record)
          || !sourceCapture.active()
          || this.options.bootstrapAdmissionRoomTargetActive?.(owner, issued.origin, issued.target) !== true
        ) {
          throw new Error('agent-admission bootstrap Room reservation unavailable')
        }
        used = true
        const result = await this.submitAdmission(owner, record, message, 'next-turn', true, sourceCapture)
        if (result.status !== 'accepted') throw new Error('agent-admission bootstrap Room submit denied')
        return result
      },
      revoke: async () => {
        if (revoked || used) return
        revoked = true
        sourceCapture.close()
      },
    })
    return { status: 'reserved', reservation: reservation as never }
  }

  async declareAdmissionBootstrapRoute(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapRouteDeclarationRequest,
  ): Promise<AgentAdmissionBootstrapRouteDeclarationResult> {
    if (this.disposed || !this.validBootstrapAdmissionOrigin(request.origin)) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const target = request.target
    if (
      target === undefined || !opaque(target.roomId) || !opaque(target.participantId)
      || !opaque(target.memberId) || !opaque(target.runId)
    ) {
      return { status: 'denied', code: 'target-denied' }
    }
    if (target.route === undefined || target.route.roomId !== target.roomId) {
      return { status: 'denied', code: 'room-denied' }
    }
    if (!this.validBootstrapRouteTarget(target)) return { status: 'denied', code: 'route-denied' }
    if (this.options.bootstrapAdmissionRouteTargetActive?.(owner, request.origin, target) !== true) {
      return { status: 'denied', code: 'target-denied' }
    }
    const commandKey = this.bootstrapRouteCommandKey(owner, request.origin)
    const declaredRoom = this.bootstrapAdmissionRouteRooms.get(commandKey)
    if (declaredRoom !== undefined && declaredRoom !== target.roomId) return { status: 'denied', code: 'cross-room' }
    const issueKey = this.bootstrapRouteIssueKey(owner, request.origin, target)
    if (this.issuedBootstrapAdmissionRouteTargets.has(issueKey)) return { status: 'denied', code: 'duplicate-target' }
    const token = `cx-admission-bootstrap-route-continuation.${crypto.randomUUID()}`
    const continuation = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-continuation.v6.schema.json' as const,
      contract: 'cordisx.agent-admission-bootstrap-route-continuation/v6' as const,
      schemaVersion: 6 as const,
      token,
    }) as AgentAdmissionBootstrapRouteContinuation
    this.bootstrapAdmissionRouteRooms.set(commandKey, target.roomId)
    this.issuedBootstrapAdmissionRouteTargets.add(issueKey)
    this.bootstrapAdmissionRouteContinuations.set(
      token,
      Object.freeze({
        owner: Object.freeze(clone(owner)),
        origin: Object.freeze(clone(request.origin)),
        target: Object.freeze(clone(target)),
        continuation,
        connectionGeneration: this.connectionGeneration,
        reserved: false,
        submitted: false,
        claimed: false,
        revoked: false,
      }),
    )
    return { status: 'declared', continuation }
  }

  async reserveAdmissionBootstrapRoute(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapRouteReservationRequest,
  ): Promise<AgentAdmissionBootstrapRouteReservationResult> {
    if (
      this.disposed || !this.validBootstrapRouteContinuation(request.continuation) || request.message === undefined
      || typeof request.message.text !== 'string' || request.message.text.length < 1
      || request.message.text.length > 65_536
    ) {
      return { status: 'denied', code: 'origin-denied' }
    }
    const issued = this.bootstrapAdmissionRouteContinuations.get(request.continuation.token)
    if (issued === undefined || !this.sameOwner(owner, issued.owner)) return { status: 'denied', code: 'not-owner' }
    if (issued.revoked) return { status: 'denied', code: 'revoked' }
    if (issued.reserved || issued.claimed) return { status: 'denied', code: 'reused' }
    if (issued.connectionGeneration !== this.connectionGeneration) {
      return { status: 'denied', code: 'connection-replaced' }
    }
    if (this.options.bootstrapAdmissionRouteTargetActive?.(owner, issued.origin, issued.target) !== true) {
      return { status: 'denied', code: 'command-complete' }
    }
    const record = this.handleCapabilities.get(request.handle as object)
    if (record === undefined || record.generation !== request.handle.agent.generation || !this.current(record)) {
      return { status: 'denied', code: 'binding-replaced' }
    }
    if (!this.sameOwner(owner, record.owner)) return { status: 'denied', code: 'not-owner' }
    const messageId = `cx-message.${crypto.randomUUID()}` as MessageId
    const message = Object.freeze({
      id: messageId,
      role: 'user' as const,
      content: Object.freeze([{ type: 'text' as const, text: request.message.text }]),
      source: Object.freeze({ kind: 'plugin' as const, pluginId: owner.pluginId, generation: owner.generation }),
    }) as UserMessage
    const sourceCapture = this.options.captureBootstrapAdmissionRouteTarget?.(
      owner,
      issued.origin,
      issued.target,
      issued.continuation,
      record.id,
      record.generation,
      messageId,
    )
    if (sourceCapture === undefined) return { status: 'denied', code: 'target-mismatch' }
    if (
      !sourceCapture.active()
      || this.options.bootstrapAdmissionRouteTargetActive?.(owner, issued.origin, issued.target) !== true
    ) {
      sourceCapture.close()
      return { status: 'denied', code: 'command-complete' }
    }
    this.bootstrapAdmissionRouteContinuations.set(
      request.continuation.token,
      Object.freeze({
        ...issued,
        reserved: true,
        handleId: record.id,
        handleGeneration: record.generation,
        sourceSessionId: record.id,
        sourceMessageId: messageId,
        capture: sourceCapture,
      }),
    )
    let used = false
    let revoked = false
    const reservation = Object.freeze({
      reservationId: `cx-admission-bootstrap-route-reservation.${crypto.randomUUID()}`,
      submit: async () => {
        const current = this.bootstrapAdmissionRouteContinuations.get(request.continuation.token)
        if (
          used || revoked || current === undefined || current.revoked || !current.reserved || current.claimed
          || current.handleId !== record.id || current.handleGeneration !== record.generation
          || current.connectionGeneration !== this.connectionGeneration || !this.current(record)
          || !sourceCapture.active()
          || this.options.bootstrapAdmissionRouteTargetActive?.(owner, issued.origin, issued.target) !== true
        ) {
          throw new Error('agent-admission bootstrap route reservation unavailable')
        }
        used = true
        const result = await this.submitAdmission(owner, record, message, 'next-turn', true, sourceCapture)
        if (result.status !== 'accepted') throw new Error('agent-admission bootstrap route submit denied')
        const submitted = this.bootstrapAdmissionRouteContinuations.get(request.continuation.token)
        if (
          submitted === undefined || submitted.revoked || submitted.connectionGeneration !== this.connectionGeneration
          || submitted.handleId !== record.id || submitted.handleGeneration !== record.generation
        ) {
          throw new Error('agent-admission bootstrap route continuation unavailable')
        }
        this.bootstrapAdmissionRouteContinuations.set(
          request.continuation.token,
          Object.freeze({ ...submitted, submitted: true }),
        )
        return result
      },
      revoke: async () => {
        if (revoked || used) return
        revoked = true
        const current = this.bootstrapAdmissionRouteContinuations.get(request.continuation.token)
        if (current !== undefined && !current.claimed) {
          current.capture?.close()
          this.bootstrapAdmissionRouteContinuations.set(
            request.continuation.token,
            Object.freeze({ ...current, revoked: true }),
          )
        }
      },
    })
    return { status: 'reserved', reservation: reservation as never }
  }

  claimAdmissionBootstrapRoute(
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapRouteClaimRequest,
  ): AgentAdmissionBootstrapRouteClaimResult {
    if (this.disposed || !this.validBootstrapRouteClaimRequest(request)) {
      return { status: 'denied', code: 'continuation-denied' }
    }
    const issued = this.bootstrapAdmissionRouteContinuations.get(request.continuation.token)
    if (issued === undefined) return { status: 'denied', code: 'continuation-denied' }
    if (!this.sameOwner(owner, issued.owner)) return { status: 'denied', code: 'not-owner' }
    if (issued.revoked) return { status: 'denied', code: 'revoked' }
    if (issued.claimed) return { status: 'denied', code: 'reused' }
    if (!issued.submitted || issued.sourceSessionId === undefined || issued.sourceMessageId === undefined) {
      return { status: 'denied', code: 'not-submitted' }
    }
    if (issued.connectionGeneration !== this.connectionGeneration) {
      return { status: 'denied', code: 'connection-replaced' }
    }
    if (this.options.bootstrapAdmissionRouteClaimActive?.(issued.owner, issued.origin, issued.target) !== true) {
      return { status: 'denied', code: 'command-complete' }
    }
    if (
      request.binding.binding.ownerGeneration !== issued.origin.binding.ownerGeneration
      || request.binding.generation !== issued.origin.generation
    ) {
      return { status: 'denied', code: 'plugin-generation-replaced' }
    }
    if (request.binding.binding.bindingId === issued.origin.binding.bindingId) {
      return { status: 'denied', code: 'binding-replaced' }
    }
    if (
      !this.sameBootstrapRouteTarget({
        roomId: request.binding.route.roomId,
        participantId: issued.target.participantId,
        memberId: issued.target.memberId,
        runId: issued.target.runId,
        route: request.binding.route,
      }, issued.target)
    ) {
      return { status: 'denied', code: 'route-mismatch' }
    }
    if (request.source.sessionId !== issued.sourceSessionId || request.source.messageId !== issued.sourceMessageId) {
      return { status: 'denied', code: 'source-mismatch' }
    }
    const receipt = Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-claim-receipt.v6.schema.json' as const,
      contract: 'cordisx.agent-admission-bootstrap-route-claim-receipt/v6' as const,
      schemaVersion: 6 as const,
      receiptId: `cx-admission-bootstrap-route-claim.${crypto.randomUUID()}`,
      owner: Object.freeze(clone(issued.owner)),
      origin: Object.freeze(clone(issued.origin)),
      target: Object.freeze(clone(issued.target)),
      binding: Object.freeze(clone(request.binding)),
      source: Object.freeze(clone(request.source)),
    }) as AgentAdmissionBootstrapRouteClaimReceipt
    this.bootstrapAdmissionRouteContinuations.set(
      request.continuation.token,
      Object.freeze({ ...issued, claimed: true }),
    )
    return { status: 'claimed', code: 'claimed', receipt }
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
}
