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
import { AgentSessionRuntimeEvents } from './agent-session-runtime-events.js'
import {
  ACQUIRE_SCHEMA,
  ADMISSION_SCHEMA,
  AgentRecord,
  clone,
  DECISION_SCHEMA_V1,
  DECISION_SCHEMA_V2,
  DISCARD_SCHEMA,
  EntityAcquireEnvelope,
  MUTATION_SCHEMA,
  ownerKey,
  QUESTION_SCHEMA_V1,
  QUESTION_SCHEMA_V2,
  SessionRecord,
} from './agent-session-runtime-types.js'

export class CordisXAgentSessionRuntime extends AgentSessionRuntimeEvents {
  protected current(record: AgentRecord): boolean {
    return !this.disposed && record.disposed === undefined && this.agents.get(record.id) === record
      && this.sessionLive(record.session)
  }

  protected sessionLive(record: SessionRecord): boolean {
    return !this.disposed && record.closed === undefined && this.sessions.get(record.id) === record
  }

  protected sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean {
    return left.pluginId === right.pluginId && left.generation === right.generation
  }

  protected sameSource(owner: PluginOwnerIdentity, source: UserMessage['source']): boolean {
    return source.kind === 'plugin' && source.pluginId === owner.pluginId && source.generation === owner.generation
  }

  protected async allowed(
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ): Promise<boolean> {
    return !this.disposed && await this.options.authorize(owner, capability, sessionId)
  }

  protected answererKey(record: AgentRecord): string {
    return `${record.id}\u0000${record.generation}`
  }

  protected acquireDenied(operation: 'create' | 'resume', mutationId?: string): AgentAcquireResult {
    return {
      $schema: ACQUIRE_SCHEMA,
      contract: 'cordisx.agent-acquire-result/v1',
      schemaVersion: 1,
      operation,
      ...(mutationId === undefined ? {} : { mutationId }),
      status: 'denied',
      code: 'permission-denied',
    }
  }

  protected acquireUnavailable(
    operation: 'create' | 'resume',
    mutationId: string | undefined,
    code: 'runtime-unavailable' | 'host-unavailable' | 'unsupported' | 'session-unavailable',
  ): AgentAcquireResult {
    return {
      $schema: ACQUIRE_SCHEMA,
      contract: 'cordisx.agent-acquire-result/v1',
      schemaVersion: 1,
      operation,
      ...(mutationId === undefined ? {} : { mutationId }),
      status: 'unavailable',
      code: code === 'session-unavailable' ? 'session-unavailable' : code,
    }
  }

  protected acquireConflict(
    operation: 'create' | 'resume',
    mutationId: string | undefined,
    code: 'mutation-conflict' | 'session-already-exists' | 'agent-already-live',
  ): AgentAcquireResult {
    return {
      $schema: ACQUIRE_SCHEMA,
      contract: 'cordisx.agent-acquire-result/v1',
      schemaVersion: 1,
      operation,
      ...(mutationId === undefined ? {} : { mutationId }),
      status: 'conflict',
      code,
    }
  }

  protected entityAcquireResult(
    envelope: EntityAcquireEnvelope,
    result: AgentAcquireResult,
    resolution: EntityDefinitionResolution,
    definitionSource: 'registry-current' | 'session-persisted',
  ): EntityAgentAcquireResult {
    if (result.status !== 'accepted') {
      return { ...envelope, status: result.status, code: result.code } as EntityAgentAcquireResult
    }
    return Object.freeze({
      ...envelope,
      status: 'accepted',
      sessionId: result.sessionId,
      agentGeneration: result.agentGeneration,
      sessionGeneration: result.sessionGeneration,
      owner: clone(result.owner),
      sessionIdSource: result.sessionIdSource,
      disposition: result.disposition,
      ...(result.handle.agent.detail === undefined ? {} : { details: clone(result.handle.agent.detail) }),
      definitionResolution: clone(resolution),
      definitionSource,
      handle: result.handle,
    }) as EntityAgentAcquireResult
  }

  protected replayEntityMutation(
    owner: PluginOwnerIdentity,
    envelope: EntityAcquireEnvelope,
    input: EntityAgentCreateOptions | EntityAgentResumeOptions,
  ): EntityAgentAcquireResult | undefined {
    if (input.mutationId === undefined) return undefined
    const prior = this.entityMutations.get(`${ownerKey(owner)}\u0000${envelope.operation}\u0000${input.mutationId}`)
    if (prior === undefined) return undefined
    if (prior.fingerprint !== JSON.stringify(clone(input))) {
      return { ...envelope, status: 'conflict', code: 'mutation-conflict' }
    }
    const record = this.handleCapabilities.get(prior.result.handle as object)
    return record !== undefined && this.current(record)
      ? Object.freeze({ ...prior.result, disposition: 'replayed' })
      : { ...envelope, status: 'unavailable', code: 'host-unavailable' }
  }

  protected rememberEntityMutation(
    owner: PluginOwnerIdentity,
    input: EntityAgentCreateOptions | EntityAgentResumeOptions,
    result: EntityAgentAcquireResult,
  ): EntityAgentAcquireResult {
    if (input.mutationId !== undefined && result.status === 'accepted') {
      this.entityMutations.set(
        `${ownerKey(owner)}\u0000${result.operation}\u0000${input.mutationId}`,
        { fingerprint: JSON.stringify(clone(input)), result },
      )
    }
    return result
  }

  protected remember(key: string | undefined, fingerprint: string, result: AgentAcquireResult): AgentAcquireResult {
    if (key !== undefined) this.mutations.set(key, { fingerprint, result })
    return result
  }

  protected admission(
    messageId: string,
    status: 'accepted' | 'denied' | 'unavailable',
    code?: 'source-denied' | 'permission-denied' | 'agent-replaced' | 'host-unavailable',
  ): Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never {
    return Object.freeze({
      $schema: ADMISSION_SCHEMA,
      contract: 'cordisx.agent-admission/v1',
      schemaVersion: 1,
      status,
      messageId,
      ...(status === 'accepted' ? {} : { code }),
    }) as never
  }

  protected discard(
    messageId: string,
    status: AgentMessageDiscardResult['status'],
    code?: string,
  ): AgentMessageDiscardResult {
    return Object.freeze({
      $schema: DISCARD_SCHEMA,
      contract: 'cordisx.agent-message-cancellation-result/v1',
      schemaVersion: 1,
      status,
      messageId,
      ...(code === undefined ? {} : { code }),
    }) as AgentMessageDiscardResult
  }

  protected mutation(
    operation: 'cancel' | 'dispose',
    mutationId: string | undefined,
    status: 'accepted' | 'denied' | 'unavailable',
    code?: string,
  ): AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'> {
    return Object.freeze({
      $schema: MUTATION_SCHEMA,
      contract: 'cordisx.agent-mutation-result/v1',
      schemaVersion: 1,
      operation,
      ...(mutationId === undefined ? {} : { mutationId }),
      status,
      ...(code === undefined ? {} : { code }),
    }) as AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'>
  }

  protected approvalQuestion(
    record: AgentRecord,
    id: string,
    toolName: string,
    callId?: string,
    reason?: string,
  ): ApprovalQuestionV1 {
    return Object.freeze({
      $schema: QUESTION_SCHEMA_V1,
      contract: 'cordisx.approval-question/v1',
      schemaVersion: 1,
      id,
      agentId: record.id,
      sessionId: record.id,
      agentGeneration: record.generation,
      toolName,
      ...(callId === undefined ? {} : { callId }),
      ...(reason === undefined ? {} : { reason }),
    })
  }

  protected approvalDecision(
    record: AgentRecord | Agent,
    id: string,
    toolName: string,
    callId: string | undefined,
    outcome: ApprovalOutcome,
  ): ApprovalDecisionV1 {
    return Object.freeze({
      $schema: DECISION_SCHEMA_V1,
      contract: 'cordisx.approval-decision/v1',
      schemaVersion: 1,
      id,
      agentId: record.id,
      sessionId: record.session.id,
      agentGeneration: record.generation,
      outcome,
    })
  }

  protected approvalBinding(record: AgentRecord): ApprovalAgentBinding {
    return Object.freeze({
      agentId: record.id,
      sessionId: record.id,
      agentGeneration: record.generation,
      definition: clone(record.definition!),
    })
  }

  protected approvalQuestionV2(
    requester: AgentRecord,
    authority: AgentRecord,
    id: string,
    toolName: string,
    callId: string | undefined,
    reason: ApprovalRequestV2['reason'],
  ): ApprovalQuestionV2 {
    return Object.freeze({
      $schema: QUESTION_SCHEMA_V2,
      contract: 'cordisx.approval-question/v2',
      schemaVersion: 2,
      id,
      requester: this.approvalBinding(requester),
      authority: this.approvalBinding(authority),
      toolName,
      ...(callId === undefined ? {} : { callId }),
      reason: clone(reason),
    })
  }

  protected approvalDecisionV2(
    requester: AgentRecord,
    authority: AgentRecord,
    id: string,
    outcome: ApprovalOutcome,
  ): ApprovalDecisionV2 {
    return Object.freeze({
      $schema: DECISION_SCHEMA_V2,
      contract: 'cordisx.approval-decision/v2',
      schemaVersion: 2,
      id,
      requester: this.approvalBinding(requester),
      authority: this.approvalBinding(authority),
      outcome,
    })
  }
}
