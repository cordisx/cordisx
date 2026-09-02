import type { Context, Disposable } from '@deepseek-ai/cordis'
import type { CordisXPlatformResult } from './platform-contracts.js'

export const CORDISX_AGENT_EVENT_CONTRACT = 'cordisx.agent-events/v2' as const
export const CORDISX_AGENT_EVENT_SCHEMA_VERSION = 2 as const
export const CORDISX_AGENT_DELIVERY_CONTRACT = 'cordisx.agent-delivery/v1' as const
export const CORDISX_AGENT_DELIVERY_SCHEMA_VERSION = 1 as const
export const CORDISX_AGENT_HISTORY_CONTRACT = 'cordisx.agent-history/v1' as const
export const CORDISX_AGENT_HISTORY_SCHEMA_VERSION = 1 as const

export type CordisXAgentEventType =
  | 'session.lifecycle'
  | 'turn.lifecycle'
  | 'step.lifecycle'
  | 'item.lifecycle'
  | 'message.observed'
  | 'message.delivery'
  | 'input.contribution'
  | 'content.chunk'
  | 'diagnostic'

export type CordisXAgentEventProvenance = 'observed' | 'cordisx' | 'inferred'

export interface CordisXAgentAdapterSource {
  readonly kind: 'adapter'
  readonly adapterId: string
  readonly adapterVersion: string
  readonly hostId: string
}

export interface CordisXAgentRuntimeSource {
  readonly kind: 'cordisx'
  readonly component: string
  readonly generation: string
}

export interface CordisXAgentPluginSource {
  readonly kind: 'plugin'
  readonly source: string
  readonly id: string
  readonly version: string | null
  readonly generation: string
}

export type CordisXAgentEventSource =
  | CordisXAgentAdapterSource
  | CordisXAgentRuntimeSource
  | CordisXAgentPluginSource

export type CordisXAgentContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reference'; readonly ref: string; readonly mediaType: string; readonly summary?: string }

export interface CordisXUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly CordisXAgentContentBlock[]
  readonly source: CordisXAgentEventSource
}

export type CordisXMessageDeliveryStage =
  | 'requested'
  | 'permission'
  | 'queued'
  | 'claimed'
  | 'projected'
  | 'forwarded'
  | 'failed'
  | 'expired'
  | 'cancelled'

export type CordisXMessageDeliveryCancelReason =
  | 'requested'
  | 'clear-pending'
  | 'owner-disposed'
  | 'plugin-blocked'
  | 'permission-blocked'
  | 'generation-replaced'

export type CordisXInputContributionKind =
  | 'pre-step.append'
  | 'system-prompt.section'
  | 'system-prompt.context'

export type CordisXInputContributionStage =
  | 'registered'
  | 'evaluated'
  | 'projected'
  | 'forwarded'
  | 'released'
  | 'failed'

export type CordisXInputContributionReleaseReason =
  | 'explicit'
  | 'owner-disposed'
  | 'plugin-blocked'
  | 'permission-blocked'
  | 'generation-replaced'

export type CordisXAgentTarget = 'next-turn' | 'next-step'

export interface CordisXAgentDiagnosticData {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly status?: 'implemented' | 'verified' | 'experimental' | 'unavailable'
}

export interface CordisXAgentEventDataMap {
  readonly 'session.lifecycle': {
    readonly phase: 'opened' | 'resumed' | 'forked' | 'compacted' | 'closed'
    readonly parentSessionId?: string
    readonly seedThroughEventId?: string
    readonly history?: 'visible' | 'hidden' | 'partial' | 'unknown'
  }
  readonly 'turn.lifecycle': {
    readonly phase: 'started' | 'completed' | 'failed' | 'cancelled'
    readonly status?: string
  }
  readonly 'step.lifecycle': {
    readonly phase: 'started' | 'completed' | 'failed' | 'cancelled'
    readonly status?: string
  }
  readonly 'item.lifecycle': {
    readonly phase: 'started' | 'updated' | 'completed' | 'failed' | 'cancelled'
    readonly kind: 'user-message' | 'assistant-message' | 'reasoning' | 'plan' | 'tool-call' | 'tool-result' | 'command' | 'file-change' | 'compaction' | 'other'
    readonly status?: string
  }
  readonly 'message.observed': { readonly message: CordisXUserMessage }
  readonly 'message.delivery': {
    readonly stage: CordisXMessageDeliveryStage
    readonly target: CordisXAgentTarget
    readonly wakeup: boolean
    readonly owner: CordisXAgentPluginSource
    readonly message?: CordisXUserMessage
    readonly capability?: string
    readonly policy?: 'ask' | 'deny' | 'allow'
    readonly decision?: 'allow' | 'deny' | 'timeout'
    readonly declarationFingerprint?: string
    readonly cancelReason?: CordisXMessageDeliveryCancelReason
    readonly diagnostic?: CordisXAgentDiagnosticData
  }
  readonly 'input.contribution': {
    readonly kind: CordisXInputContributionKind
    readonly stage: CordisXInputContributionStage
    readonly evaluationId?: string
    readonly messageIds?: readonly string[]
    readonly capability?: string
    readonly releaseReason?: CordisXInputContributionReleaseReason
    readonly diagnostic?: CordisXAgentDiagnosticData
  }
  readonly 'content.chunk': {
    readonly channel: 'assistant' | 'reasoning' | 'plan' | 'command' | 'file-change' | 'tool' | 'other'
    readonly index: number
    readonly delta?: string
    readonly ref?: string
    readonly final?: boolean
  }
  readonly diagnostic: CordisXAgentDiagnosticData
}

export type CordisXAgentEvent<Type extends CordisXAgentEventType = CordisXAgentEventType> = {
  readonly contract: typeof CORDISX_AGENT_EVENT_CONTRACT
  readonly schemaVersion: typeof CORDISX_AGENT_EVENT_SCHEMA_VERSION
  readonly eventId: string
  readonly sessionId: string
  readonly turnId?: string
  readonly stepId?: string
  readonly itemId?: string
  readonly messageId?: string
  readonly deliveryId?: string
  readonly contributionId?: string
  readonly toolCallId?: string
  readonly contextId?: string
  readonly seq: number
  readonly time: number
  readonly type: Type
  readonly provenance: CordisXAgentEventProvenance
  readonly source: CordisXAgentEventSource
  readonly causalParentId?: string
  readonly data: CordisXAgentEventDataMap[Type]
}

export type CordisXAgentEventDraft<Type extends CordisXAgentEventType = CordisXAgentEventType> =
  Omit<CordisXAgentEvent<Type>, 'contract' | 'schemaVersion' | 'eventId' | 'seq' | 'time'> & {
    readonly time?: number
  }

export interface CordisXAgentEventPage {
  readonly contract: typeof CORDISX_AGENT_EVENT_CONTRACT
  readonly schemaVersion: typeof CORDISX_AGENT_EVENT_SCHEMA_VERSION
  readonly sessionId: string
  readonly snapshotSeq: number
  readonly afterSeq: number
  readonly limit: number
  readonly fromSeq?: number
  readonly toSeq?: number
  readonly nextAfterSeq?: number
  readonly events: readonly CordisXAgentEvent[]
}

export interface CordisXAgentEventStatus {
  readonly hostId: string
  readonly hostName: string
  readonly mode: 'unavailable' | 'read-only' | 'read-write'
  readonly adapterId: string
  readonly adapterVersion: string
  readonly experimental: readonly string[]
  readonly diagnostics: readonly CordisXAgentDiagnosticData[]
  readonly secondConnectionCreated: false
  readonly rawBridgeExposed: false
}

export interface CordisXAgentEventQuery {
  readonly sessionId: string
  readonly afterSeq?: number
  readonly limit?: number
  readonly snapshotSeq?: number
}

export interface CordisXAgentEventSubscription {
  readonly sessionId?: string
  readonly afterSeq?: number
}

export interface CordisXAgentEventRange {
  readonly sessionId: string
  readonly fromSeq: number
  readonly toSeq: number
}

export interface CordisXAgentEvents {
  status(): CordisXAgentEventStatus
  query(input: CordisXAgentEventQuery): Promise<CordisXPlatformResult<CordisXAgentEventPage>>
  subscribe(input: CordisXAgentEventSubscription, listener: (range: CordisXAgentEventRange) => void): Disposable<void>
}

export type CordisXAgentHistoryPayloadPolicy = 'referenced' | 'summarized' | 'inline'
export type CordisXAgentHistoryCoverageState = 'complete' | 'partial' | 'indexing' | 'unavailable'

export interface CordisXAgentHistorySource {
  readonly kind: 'historical'
  readonly adapterId: string
  readonly adapterVersion: string
  readonly hostId: string
  readonly profileId: string
}

export interface CordisXAgentHistoryCoverage {
  readonly state: CordisXAgentHistoryCoverageState
  readonly earliestTime?: number
  readonly latestTime?: number
  readonly compacted: boolean
  readonly corruptLines: number
  readonly oversizedLines: number
  readonly redactedFields: number
  readonly tailAvailable: boolean
}

export type CordisXAgentHistoryDiagnosticCode =
  | 'history-unavailable'
  | 'history-indexing'
  | 'history-corrupt-line'
  | 'history-oversized-line'
  | 'history-source-changed'
  | 'history-content-redacted'
  | 'history-resource-limit'

export interface CordisXAgentHistoryDiagnostic {
  readonly code: CordisXAgentHistoryDiagnosticCode
  readonly severity: 'info' | 'warning' | 'error'
  readonly count: number
}

export interface CordisXAgentHistoryPage {
  readonly contract: typeof CORDISX_AGENT_HISTORY_CONTRACT
  readonly schemaVersion: typeof CORDISX_AGENT_HISTORY_SCHEMA_VERSION
  readonly sessionId: string
  readonly snapshotId: string
  readonly limit: number
  readonly requestedPayloadPolicy: CordisXAgentHistoryPayloadPolicy
  readonly effectivePayloadPolicy: CordisXAgentHistoryPayloadPolicy
  readonly source: CordisXAgentHistorySource
  readonly coverage: CordisXAgentHistoryCoverage
  readonly fromSeq?: number
  readonly toSeq?: number
  readonly nextCursor?: string
  readonly tailCursor?: string
  readonly events: readonly CordisXAgentEvent[]
  readonly diagnostics?: readonly CordisXAgentHistoryDiagnostic[]
}

export interface CordisXAgentHistoryQuery {
  readonly sessionId: string
  readonly cursor?: string
  readonly limit?: number
  readonly payloadPolicy?: CordisXAgentHistoryPayloadPolicy
}

export interface CordisXAgentHistoryTailQuery {
  readonly sessionId: string
  readonly tailCursor: string
  readonly limit?: number
  readonly payloadPolicy?: CordisXAgentHistoryPayloadPolicy
}

export interface CordisXAgentHistoryStatus {
  readonly hostId: string
  readonly hostName: string
  readonly mode: 'available' | 'unavailable'
  readonly adapterId: string
  readonly adapterVersion: string
  readonly profileId: string
  readonly defaultPayloadPolicy: 'referenced'
  readonly diagnostics: readonly CordisXAgentHistoryDiagnostic[]
  readonly filesystemExposed: false
  readonly rawBridgeExposed: false
}

export interface CordisXAgentHistory {
  status(): CordisXAgentHistoryStatus
  query(input: CordisXAgentHistoryQuery): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>>
  tail(input: CordisXAgentHistoryTailQuery): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>>
}

export type CordisXAgentMessageInput = string | readonly CordisXAgentContentBlock[]

export interface CordisXAgentDeliverySnapshot {
  readonly contract: typeof CORDISX_AGENT_DELIVERY_CONTRACT
  readonly schemaVersion: typeof CORDISX_AGENT_DELIVERY_SCHEMA_VERSION
  readonly deliveryId: string
  readonly messageId: string
  readonly sessionId: string
  readonly target: CordisXAgentTarget
  readonly wakeup: boolean
  readonly owner: CordisXAgentPluginSource
  readonly stage: CordisXMessageDeliveryStage
  readonly terminal: boolean
  readonly cancellable: boolean
  readonly valid: boolean
  readonly stageEventId: string
  readonly turnId?: string
  readonly stepId?: string
  readonly contextId?: string
  readonly diagnostic?: CordisXAgentDiagnosticData
}

export type CordisXAgentDeliveryCancelResult =
  | { readonly ok: true; readonly snapshot: CordisXAgentDeliverySnapshot }
  | {
      readonly ok: false
      readonly reason: 'irreversible' | 'terminal' | 'stale-generation' | 'owner-mismatch'
      readonly snapshot: CordisXAgentDeliverySnapshot
    }

export interface CordisXAgentDeliveryHandle {
  readonly deliveryId: string
  snapshot(): CordisXAgentDeliverySnapshot
  cancel(): CordisXAgentDeliveryCancelResult
}

export interface CordisXAgentDeliveryClearResult {
  readonly cancelled: readonly CordisXAgentDeliverySnapshot[]
  readonly retained: readonly CordisXAgentDeliverySnapshot[]
}

export interface CordisXAgent {
  send(message: CordisXAgentMessageInput, target: CordisXAgentTarget, wakeup: boolean): CordisXAgentDeliveryHandle
  followup(message: CordisXAgentMessageInput): CordisXAgentDeliveryHandle
  steer(message: CordisXAgentMessageInput): CordisXAgentDeliveryHandle
  inject(message: CordisXAgentMessageInput): CordisXAgentDeliveryHandle
  clearPending(): CordisXAgentDeliveryClearResult
}

export type CordisXPreStepOperation =
  | { readonly type: 'remove'; readonly messageId: string }
  | { readonly type: 'replace'; readonly messageId: string; readonly content: CordisXAgentMessageInput }
  | { readonly type: 'move'; readonly messageId: string; readonly beforeMessageId?: string }

export type CordisXPreStepDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'append'; readonly messages: readonly CordisXAgentMessageInput[] }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'transform'; readonly operations: readonly CordisXPreStepOperation[]; readonly append?: readonly CordisXAgentMessageInput[] }

export interface CordisXPreStepInput {
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly messages: readonly CordisXUserMessage[]
}

export type CordisXPreStepHandler = (input: CordisXPreStepInput) => CordisXPreStepDecision | Promise<CordisXPreStepDecision>

export interface CordisXAgents {
  get(sessionId: string): CordisXAgent
  preStep(handler: CordisXPreStepHandler): Disposable<void>
}

export interface CordisXPromptContribution {
  readonly sessionId: string
  readonly id: string
  readonly content: string
  readonly order?: number
}

export interface CordisXSystemPrompt {
  section(contribution: CordisXPromptContribution): Disposable<void>
  context(contribution: CordisXPromptContribution): Disposable<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Brokered system-prompt sections and dynamic context. */
    systemPrompt: CordisXSystemPrompt
  }
}

export type CordisXAgentContext = Context
