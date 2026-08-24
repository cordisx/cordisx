import type { Context } from '@deepseek-ai/cordis'
import type { CordisXLocalizedText } from './contracts.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v1.schema.json'

export const CORDISX_PLATFORM_CAPABILITIES = [
  'models.read',
  'tasks.catalog.read',
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
  'agent.events.read',
  'agent.history.read',
  'agent.messages.append',
  'agent.steps.reject',
  'agent.messages.transform',
  'agent.prompt.section',
  'agent.prompt.context',
] as const

export type CordisXPlatformCapability = typeof CORDISX_PLATFORM_CAPABILITIES[number]
export type CordisXPermissionPolicy = 'ask' | 'deny' | 'allow'

/** Host-bound identity. Plugin calls never supply or override this value. */
export interface CordisXPluginIdentity {
  readonly source: string
  readonly id: string
}

/** Maximum authority requested by one manifest declaration. */
export interface CordisXCapabilityScope {
  readonly providers?: readonly string[]
  readonly cwdRoots?: readonly string[]
  readonly sessions?: readonly CordisXPlatformSessionRef[]
  readonly sessionIds?: readonly string[]
}

export interface CordisXCapabilityDeclaration {
  readonly name: CordisXPlatformCapability
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly scope: CordisXCapabilityScope
}

export interface CordisXPluginManifestV1 {
  readonly $schema: typeof CORDISX_PLUGIN_MANIFEST_SCHEMA_V1
  readonly schemaVersion: 1
  readonly id: string
  readonly name?: string
  readonly capabilities: readonly CordisXCapabilityDeclaration[]
}

export type CordisXPlatformDiagnosticCode =
  | 'permission-undeclared'
  | 'permission-denied'
  | 'permission-scope-denied'
  | 'invalid-request'
  | 'invalid-provider'
  | 'invalid-model'
  | 'task-not-found'
  | 'turn-not-found'
  | 'adapter-unavailable'
  | 'adapter-read-only'
  | 'current-connection-client-unavailable'
  | 'initial-turn-failed'
  | 'interrupted'
  | 'timeout'
  | 'adapter-failure'

export interface CordisXPlatformDiagnostic {
  readonly code: CordisXPlatformDiagnosticCode
  readonly message: string
  readonly retryable?: boolean
}

export type CordisXPlatformResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: CordisXPlatformDiagnostic }

export interface CordisXPlatformAdapterStatus {
  readonly hostId: string
  readonly hostName: string
  readonly mode: 'unavailable' | 'read-only' | 'read-write'
  readonly supportedCapabilities: readonly CordisXPlatformCapability[]
  readonly diagnostics: readonly CordisXPlatformDiagnostic[]
  readonly secondConnectionCreated: false
  readonly rawBridgeExposed: false
}

export interface CordisXPlatformModelRef {
  readonly providerId: string
  readonly modelId: string
}

export interface CordisXPlatformSessionRef {
  readonly providerId: string
  readonly remoteSessionId: string
}

export interface CordisXModelDescriptor {
  readonly contract: 'cordisx.platform-model/v1'
  readonly schemaVersion: 1
  readonly ref: CordisXPlatformModelRef
  readonly hostId: string
  readonly accountId?: string
  readonly label: string
  readonly isDefault?: boolean
  readonly features?: readonly string[]
}

export interface CordisXModelPage {
  readonly contract: 'cordisx.platform-model-page/v1'
  readonly schemaVersion: 1
  readonly providerIds: readonly string[]
  readonly models: readonly CordisXModelDescriptor[]
}

export type CordisXSessionState = 'active' | 'archived' | 'deleted' | 'unknown'

export interface CordisXSessionSummary {
  readonly contract: 'cordisx.platform-session/v1'
  readonly schemaVersion: 1
  readonly ref: CordisXPlatformSessionRef
  readonly hostId: string
  readonly accountId?: string
  readonly model: CordisXPlatformModelRef
  readonly cwd: string
  readonly title?: string
  readonly state: CordisXSessionState
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface CordisXTaskContentItem {
  readonly id: string
  readonly kind: 'user-message' | 'assistant-message' | 'reasoning' | 'tool' | 'unknown'
  readonly text?: string
}

export interface CordisXTurnProjection {
  readonly id: string
  readonly state: 'in-progress' | 'completed' | 'interrupted' | 'failed' | 'unknown'
  readonly items: readonly CordisXTaskContentItem[]
}

export interface CordisXSessionProjection extends CordisXSessionSummary {
  readonly turns: readonly CordisXTurnProjection[]
}

export interface CordisXTurnStart {
  readonly session: CordisXPlatformSessionRef
  readonly turnId: string
}

export type CordisXSessionCreateOutcome =
  | {
    readonly status: 'created'
    readonly session: CordisXSessionSummary
    readonly initialTurn?: CordisXTurnStart
  }
  | {
    readonly status: 'created-initial-turn-failed'
    readonly session: CordisXSessionSummary
    readonly error: CordisXPlatformDiagnostic
  }

export interface CordisXModelsListInput {
  readonly providerIds?: readonly string[]
}

export interface CordisXTasksListInput {
  readonly providerIds?: readonly string[]
  readonly cwd?: string
  readonly searchTerm?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface CordisXSessionPage {
  readonly contract: 'cordisx.platform-session-page/v1'
  readonly schemaVersion: 1
  readonly query: Omit<CordisXTasksListInput, 'cursor'>
  readonly snapshotId: string
  readonly nextCursor?: string
  readonly sessions: readonly CordisXSessionSummary[]
}

export interface CordisXTaskReadInput {
  readonly session: CordisXPlatformSessionRef
}

export interface CordisXTaskCreateInput {
  readonly model: CordisXPlatformModelRef
  readonly cwd: string
  readonly initialMessage?: string
}

export type CordisXTaskControlInput =
  | { readonly action: 'continue'; readonly session: CordisXPlatformSessionRef }
  | { readonly action: 'fork'; readonly session: CordisXPlatformSessionRef }
  | { readonly action: 'archive'; readonly session: CordisXPlatformSessionRef }
  | { readonly action: 'restore'; readonly session: CordisXPlatformSessionRef }
  | { readonly action: 'delete'; readonly session: CordisXPlatformSessionRef }

export type CordisXTaskControlOutcome =
  | { readonly action: 'continue' | 'fork' | 'archive' | 'restore'; readonly session: CordisXSessionSummary }
  | { readonly action: 'delete'; readonly session: CordisXPlatformSessionRef; readonly deleted: true }

export interface CordisXTurnSubmitInput {
  readonly session: CordisXPlatformSessionRef
  readonly message: string
}

export type CordisXTurnControlInput =
  | { readonly action: 'steer'; readonly session: CordisXPlatformSessionRef; readonly turnId?: string; readonly message: string }
  | { readonly action: 'interrupt'; readonly session: CordisXPlatformSessionRef; readonly turnId?: string }

export interface CordisXTurnControlOutcome {
  readonly action: 'steer' | 'interrupt'
  readonly session: CordisXPlatformSessionRef
  readonly turnId?: string
}

export interface CordisXPlatform {
  status(): CordisXPlatformAdapterStatus
  readonly models: {
    list(input?: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>>
  }
  readonly tasks: {
    list(input?: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>>
    read(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>>
    create(input: CordisXTaskCreateInput): Promise<CordisXPlatformResult<CordisXSessionCreateOutcome>>
    control(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>>
  }
  readonly turns: {
    submit(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>>
    control(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Permission-brokered adapter-neutral host capabilities. */
    platform: CordisXPlatform
  }
}

// Keep Context in this module's public type graph so augmentation is emitted.
export type CordisXPlatformContext = Context
