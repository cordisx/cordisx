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

export const ACQUIRE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-acquire-result.v1.schema.json' as const

export const ADMISSION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json' as const

export const MUTATION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json' as const

export const DISCARD_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json' as const

export const SNAPSHOT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-snapshot.v1.schema.json' as const

export const PAGE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event-page.v1.schema.json' as const

export const SUBSCRIPTION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-page.v1.schema.json' as const

export const QUESTION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v1.schema.json' as const

export const DECISION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v1.schema.json' as const

export const QUESTION_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v2.schema.json' as const

export const DECISION_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v2.schema.json' as const

export const ROUTING_REGISTRATION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-registration.v1.schema.json' as const

export const ROUTING_QUESTION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-question.v1.schema.json' as const

export const ROUTING_RESULT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json' as const

export const ROUTING_CLOSE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-resolver-close.v1.schema.json' as const

export const ENTITY_ACQUIRE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-agent-acquire-result.v1.schema.json' as const

export const PAGE_ORIGIN_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-origin.v1.schema.json' as const

export const PAGE_CONTEXT_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-context.v2.schema.json' as const

export const PAGE_TARGET_ORIGIN_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-target-origin.v1.schema.json' as const

export const PAGE_TARGET_RECEIPT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-target-receipt.v1.schema.json' as const

export const PAGE_ROUTE_CONTINUATION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-route-continuation.v1.schema.json' as const

export const PAGE_ROUTE_CLAIM_RECEIPT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-route-claim-receipt.v1.schema.json' as const

export const PAGE_FRESH_NAVIGATION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-fresh-room-navigation.v1.schema.json' as const

export type EntityAcquireEnvelope = {
  readonly $schema: typeof ENTITY_ACQUIRE_SCHEMA
  readonly contract: 'cordisx.entity-agent-acquire-result/v1'
  readonly schemaVersion: 1
  readonly operation: 'create' | 'resume'
  readonly mutationId?: string
}

export type AcceptedEntityAcquire = Extract<EntityAgentAcquireResult, { readonly status: 'accepted' }>

export const clone = <Value>(value: Value): Value => structuredClone(value)

export const opaque = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512

export const ownerKey = (owner: PluginOwnerIdentity) => `${owner.pluginId}\u0000${owner.generation}`

export const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export type CordisXDriverSessionEventType =
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'
  | 'assistant/chunk'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'agent/inbox/spliced'
  | 'playground/scenario'

export type CordisXDriverSessionEvent = {
  [K in CordisXDriverSessionEventType]: {
    readonly sessionId: string
    readonly type: K
    readonly data: SessionEventDataMap[K]
    readonly ignorable?: true
  }
}[CordisXDriverSessionEventType]

export type SessionEventInput = {
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
  create(
    input: {
      readonly sessionId: string
      readonly owner: PluginOwnerIdentity
      readonly options: AgentOptions
      readonly setup?: AgentSetup
    },
  ): Promise<
    { readonly status: 'accepted'; readonly detail?: AgentDetailReference } | {
      readonly status: 'unavailable'
      readonly code: 'host-unavailable' | 'unsupported'
    }
  >
  resume(
    input: {
      readonly sessionId: string
      readonly owner: PluginOwnerIdentity
      readonly options: AgentOptions
      readonly setup?: AgentSetup
    },
  ): Promise<
    { readonly status: 'accepted'; readonly detail?: AgentDetailReference } | {
      readonly status: 'unavailable'
      readonly code: 'host-unavailable' | 'unsupported'
    }
  >
  /** Explicit inline recovery only; the driver must verify a persisted native binding. */
  recover?(
    input: {
      readonly sessionId: string
      readonly owner: PluginOwnerIdentity
      readonly options: AgentOptions
      readonly setup: AgentSetup
    },
  ): ReturnType<CordisXPrivateAgentDriver['resume']>
  submit(
    input: {
      readonly sessionId: string
      readonly message: UserMessage
      readonly target: 'next-turn' | 'next-step'
      readonly wakeup: boolean
    },
  ): Promise<'accepted' | 'replayed' | 'unavailable'>
  discard(
    input: { readonly sessionId: string; readonly messageId: MessageId },
  ): Promise<'accepted' | 'not-found' | 'already-claimed' | 'unavailable'>
  cancel(
    input: { readonly sessionId: string; readonly cause: AgentCancelCause; readonly keepInbox: boolean },
  ): Promise<'accepted' | 'unavailable'>
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
  readonly authorize: (
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId?: string,
  ) => Promise<boolean>
  /** Host-only v8 authority lease minting after an accepted v3 resolver correlation. */
  readonly mintApprovalAuthorityLease?: (owner: PluginOwnerIdentity, input: {
    readonly routingId: string
    readonly registrationId: string
    readonly requester: ApprovalAgentBinding
    readonly authority: ApprovalAgentBinding
  }) => Promise<PluginApprovalAuthorityLeaseV8 | undefined>
  readonly requiresApprovalAuthorityLease?: (owner: PluginOwnerIdentity) => boolean
  readonly approvalAuthorityLeaseActive?: (
    owner: PluginOwnerIdentity,
    lease: PluginApprovalAuthorityLeaseV8,
    requester: ApprovalAgentBinding,
    authority: ApprovalAgentBinding,
  ) => boolean
  readonly releaseApprovalAuthorityLease?: (lease: PluginApprovalAuthorityLeaseV8) => void
  /** Host-only manifest/route declaration check; it must not materialize permission authority. */
  readonly declares?: (owner: PluginOwnerIdentity, capability: AgentRuntimeCapability) => boolean
  readonly now?: () => number
  readonly persistence?: CordisXSessionEventPersistence
  readonly initialSessions?: readonly CordisXPersistedSession[]
  /** Host Playground only: captures the current Shell authority for an accepted submission. */
  readonly captureSubmission?: (
    owner: PluginOwnerIdentity,
    sessionId: string,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Shell v8 only: capture an exact admitted Session before driver submission. */
  readonly captureAdmission?: (
    owner: PluginOwnerIdentity,
    origin: AgentCommandOrigin,
    sessionId: string,
    agentGeneration: number,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Shell v8/v3 only: validates one exact delivery while its command authority remains live. */
  readonly admissionTargetActive?: (
    owner: PluginOwnerIdentity,
    origin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
  ) => boolean
  /** Shell v8/v3 only: captures one exact delivery/handle before its driver submission. */
  readonly captureAdmissionTarget?: (
    owner: PluginOwnerIdentity,
    origin: AgentCommandOrigin,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Shell v9/v4 only: validates one target declared under a live bootstrap command. */
  readonly bootstrapAdmissionTargetActive?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionTarget,
  ) => boolean
  /** Shell v9/v4 only: captures an exact newly admitted target before driver submission. */
  readonly captureBootstrapAdmissionTarget?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Shell v9/v5 only: validates one exact same-binding Room target while its bootstrap command is live. */
  readonly bootstrapAdmissionRoomTargetActive?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRoomTarget,
  ) => boolean
  /** Shell v9/v5 only: retains the exact Room receipt with its current-binding source capture. */
  readonly captureBootstrapAdmissionRoomTarget?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRoomTarget,
    receipt: AgentAdmissionBootstrapRoomTargetReceipt,
    sessionId: string,
    agentGeneration: number,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Shell v9/v6 only: validates a same-owner Room route target while its bootstrap command is live. */
  readonly bootstrapAdmissionRouteTargetActive?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
  ) => boolean
  /** v6 claim keeps command liveness distinct from its replaced old page binding. */
  readonly bootstrapAdmissionRouteClaimActive?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
  ) => boolean
  /** Shell v9/v6 only: captures the exact source pending a Host-only Room-route claim. */
  readonly captureBootstrapAdmissionRouteTarget?: (
    owner: PluginOwnerIdentity,
    origin: AgentBootstrapCommandOrigin,
    target: AgentAdmissionBootstrapRouteTarget,
    continuation: AgentAdmissionBootstrapRouteContinuation,
    sessionId: string,
    agentGeneration: number,
    messageId: MessageId,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Product-page admission bridge. The lifecycle registry is Host-private and page-bound. */
  readonly pageAdmissionBindings?: PageAdmissionBindingRegistry
  readonly capturePageAdmission?: (
    owner: PluginOwnerIdentity,
    origin: AgentPageComposerOrigin,
    target: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget,
    sessionId: string,
    agentGeneration: number,
    messageId: MessageId,
    /** Host-derived command liveness; never exposed to a plugin. */
    commandActive: () => boolean,
    /** Host-derived origin-binding liveness after a successful submit. */
    originActive: () => boolean,
  ) => PlaygroundScenarioSubmissionCapture | undefined
  /** Host-only scenario-source transfer after the page lifecycle has claimed a destination binding. */
  readonly claimPageAdmission?: (
    owner: PluginOwnerIdentity,
    receipt: AgentPageAdmissionRouteClaimReceipt,
    bindingActive: () => boolean,
  ) => boolean
  readonly navigatePageAdmission?: (
    owner: PluginOwnerIdentity,
    command: PageAdmissionCommand,
    route: AgentPageRoomRoute,
  ) => Promise<'accepted' | 'navigation-failed'>
  /** Read-only historical detail capabilities; absent bridges remain unavailable. */
  readonly historicalAgentDetails?: import('./native-session-detail-references.js').HistoricalAgentDetailProvider
  /** Host-owned only; resolves a current ref through the private navigator. */
  readonly navigateAgentDetail?: (detail: AgentDetailReference, sessionId: SessionId) => Promise<void> | void
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
  | {
    readonly status: 'unavailable'
    readonly code:
      | 'binding-unresolved'
      | 'binding-closed'
      | 'plugin-generation-replaced'
      | 'connection-replaced'
      | 'host-unavailable'
      | 'unsupported'
  }

export type CordisXLegacyAgentLoopBindingResolver = (
  binding: CordisXAgentSessionLegacyAcquireRequestV1['binding'],
) => Promise<CordisXLegacyAgentLoopBindingResolution>

export interface SessionRecord {
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

export interface AgentRecord {
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

export interface SessionSubscriber {
  readonly generation: number
  readonly replayThrough: number
  readonly owner: PluginOwnerIdentity
  readonly observer: SessionEventObserver
  lastSeq: number
  closed?: SessionSubscriptionClosed
  resolveClosed: (value: SessionSubscriptionClosed) => void
  delivery: Promise<void>
}

export interface AgentSubscriber {
  readonly owner: PluginOwnerIdentity
  readonly observer: AgentLiveEventObserver
  closed?:
    | 'unsubscribed'
    | 'agent-replaced'
    | 'plugin-generation-replaced'
    | 'connection-replaced'
    | 'permission-revoked'
}

export interface AnswererRecord {
  readonly owner: PluginOwnerIdentity
  readonly answerer: ApprovalAnswererV1
  closed?: 'disposed' | 'agent-replaced' | 'plugin-generation-replaced' | 'permission-revoked'
}

export interface AuthorityAnswererRecord {
  readonly owner: PluginOwnerIdentity
  readonly answerer: ApprovalAnswererV2
  closed?:
    | 'disposed'
    | 'authority-replaced'
    | 'plugin-generation-replaced'
    | 'permission-revoked'
    | 'connection-replaced'
}

export interface RequestResolverRecord {
  readonly owner: PluginOwnerIdentity
  readonly requester: AgentRecord
  readonly resolver: ApprovalRequestResolver
  readonly registration: ApprovalRequestRoutingRegistration
  readonly connectionGeneration: number
  readonly controllers: Set<AbortController>
  readonly closed: Promise<ApprovalRequestResolverClosed>
  resolveClosed: (value: ApprovalRequestResolverClosed) => void
  terminal?: ApprovalRequestResolverClosed
}

export interface PageAdmissionCommandRecord {
  readonly owner: PluginOwnerIdentity
  readonly command: PageAdmissionCommand
  readonly origin: AgentPageComposerOrigin
  readonly route: HostPageAdmissionRoute
  readonly freshNavigation?: AgentPageFreshRoomNavigation
  navigation?: AgentPageFreshRoomNavigationResult
}

export interface PageAdmissionTargetRecord {
  readonly owner: PluginOwnerIdentity
  readonly command: PageAdmissionCommand
  readonly origin: AgentPageComposerOrigin
  readonly target: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget
  readonly declaration: import('./page-admission-lifecycle.js').PageAdmissionDeclaration
  readonly targetOrigin?: AgentPageAdmissionTargetOrigin
  readonly receipt?: AgentPageAdmissionTargetReceipt
  readonly continuation?: AgentPageAdmissionRouteContinuation
  readonly fresh: boolean
  reserved: boolean
  submitted: boolean
  revoked: boolean
  handleId?: string
  handleGeneration?: number
  sourceSessionId?: string
  sourceMessageId?: MessageId
  capture?: PlaygroundScenarioSubmissionCapture
}
