export type TraceLane = 'input' | 'model' | 'tools' | 'injection'
export type TraceTruth = 'observed' | 'cordisx' | 'inferred'
export type TraceOrigin = 'live' | 'historical' | 'fixture'
export type TraceContractEventType =
  | 'session.lifecycle'
  | 'turn.lifecycle'
  | 'step.lifecycle'
  | 'item.lifecycle'
  | 'message.observed'
  | 'message.delivery'
  | 'input.contribution'
  | 'content.chunk'
  | 'diagnostic'
export type TracePhase =
  | 'requested'
  | 'permission'
  | 'queued'
  | 'claimed'
  | 'registered'
  | 'evaluated'
  | 'projected'
  | 'forwarded'
  | 'released'
  | 'failed'
  | 'expired'
  | 'cancelled'

export type TraceAdapterMode = 'live' | 'fixture' | 'partial' | 'unavailable'
export type TraceCompleteness = 'complete' | 'partial' | 'unavailable'
export type TraceDemoKind =
  | 'followup'
  | 'steer'
  | 'inject'
  | 'pre-step'
  | 'system-prompt-section'
  | 'system-prompt-context'

export interface TraceSource {
  readonly kind: 'user' | 'host' | 'model' | 'tool' | 'plugin'
  readonly id: string
  readonly label: string
}

export interface TracePluginAttribution {
  readonly source: string
  readonly id: string
  readonly version: string | null
  readonly generation: string
}

export interface TracePermission {
  readonly capability: string
  readonly policy: 'allow' | 'ask' | 'deny'
  readonly outcome: 'allowed' | 'ask-pending' | 'denied'
  readonly reason?: string
}

export interface TraceTiming {
  readonly startedAt: string
  readonly durationMs?: number
}

/** One immutable public-ledger projection consumed by the Showcase. */
export interface TraceEvent {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  /** Original provider sequence when a merged Timeline assigns a display sequence. */
  readonly sourceSeq?: number
  readonly recordedAt: string
  /** Acquisition channel, distinct from the event contract's truth/provenance. */
  readonly origin: TraceOrigin
  readonly turnId?: string
  readonly turnNumber?: number
  readonly stepId?: string
  readonly stepNumber?: number
  readonly itemId?: string
  readonly messageId?: string
  readonly toolCallId?: string
  readonly contextId?: string
  readonly parentId?: string
  readonly requestId?: string
  readonly lane: TraceLane
  /** One of the nine event types in cordisx.agent-events/v2. */
  readonly type: TraceContractEventType
  /** UI projection label; never exposed as a parallel protocol event type. */
  readonly semanticType: string
  readonly truth: TraceTruth
  readonly phase?: TracePhase
  readonly summary: string
  readonly source: TraceSource
  readonly plugin?: TracePluginAttribution
  readonly permission?: TracePermission
  readonly timing?: TraceTiming
  readonly payload?: Readonly<Record<string, unknown>>
  readonly modelConsumption: 'proved' | 'unproved' | 'not-applicable'
}

export interface TraceAdapterStatus {
  readonly mode: TraceAdapterMode
  readonly completeness: TraceCompleteness
  readonly contractVersion?: string
  readonly coreHead?: string
  readonly diagnostics: readonly string[]
  readonly supportedOperations: readonly TraceDemoKind[]
  readonly payloadPolicy: 'inline' | 'summarized' | 'referenced'
  readonly origins: readonly TraceOrigin[]
  readonly historyCoverage?: {
    readonly state: 'complete' | 'partial' | 'indexing' | 'unavailable'
    readonly compacted: boolean
    readonly corruptLines: number
    readonly oversizedLines: number
    readonly redactedFields: number
    readonly tailAvailable: boolean
  }
}

export interface TraceLoadedRange {
  readonly firstSeq?: number
  readonly lastSeq?: number
  readonly loaded: number
  readonly totalAvailable?: number
  readonly renderedLimit: number
}

export interface TraceSnapshot {
  readonly sessionId?: string
  readonly status: TraceAdapterStatus
  readonly events: readonly TraceEvent[]
  readonly hasEarlier: boolean
  readonly loadingEarlier: boolean
  readonly range: TraceLoadedRange
}

export interface TraceDemoRequest {
  readonly kind: TraceDemoKind
  readonly content?: string
}

/**
 * Consumer-only adapter/store seam. The core contract adapter and fixture are
 * providers; page components never read host or fixture state directly.
 */
export interface TraceShowcaseStore {
  getSnapshot(): TraceSnapshot
  subscribe(listener: () => void): () => void
  loadEarlier(): Promise<void>
  requestDemo(request: TraceDemoRequest): Promise<string>
  cancelQueued(requestId: string): Promise<boolean>
  clearQueued(): Promise<number>
  dispose(): void
}
