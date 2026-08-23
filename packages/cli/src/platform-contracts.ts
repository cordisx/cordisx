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
  readonly taskIds?: readonly string[]
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

export interface CordisXModelDescriptor {
  readonly hostId: string
  readonly accountId?: string
  readonly providerId: string
  readonly id: string
  readonly label: string
  readonly isDefault?: boolean
  readonly features?: readonly string[]
}

export type CordisXTaskState = 'active' | 'archived' | 'deleted' | 'unknown'

export interface CordisXTaskSummary {
  readonly id: string
  readonly hostId: string
  readonly accountId?: string
  readonly providerId: string
  readonly modelId: string
  readonly cwd: string
  readonly title?: string
  readonly state: CordisXTaskState
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

export interface CordisXTaskProjection extends CordisXTaskSummary {
  readonly turns: readonly CordisXTurnProjection[]
}

export interface CordisXTurnStart {
  readonly taskId: string
  readonly turnId: string
}

export type CordisXTaskCreateOutcome =
  | {
    readonly status: 'created'
    readonly task: CordisXTaskSummary
    readonly initialTurn?: CordisXTurnStart
  }
  | {
    readonly status: 'created-initial-turn-failed'
    readonly task: CordisXTaskSummary
    readonly error: CordisXPlatformDiagnostic
  }

export interface CordisXModelsListInput {
  readonly providerId?: string
}

export interface CordisXTasksListInput {
  readonly providerId?: string
  readonly cwd?: string
}

export interface CordisXTaskReadInput {
  readonly taskId: string
}

export interface CordisXTaskCreateInput {
  readonly providerId: string
  readonly modelId: string
  readonly cwd: string
  readonly initialMessage?: string
}

export type CordisXTaskControlInput =
  | { readonly action: 'continue'; readonly taskId: string }
  | { readonly action: 'fork'; readonly taskId: string }
  | { readonly action: 'archive'; readonly taskId: string }
  | { readonly action: 'restore'; readonly taskId: string }
  | { readonly action: 'delete'; readonly taskId: string }

export type CordisXTaskControlOutcome =
  | { readonly action: 'continue' | 'fork' | 'archive' | 'restore'; readonly task: CordisXTaskSummary }
  | { readonly action: 'delete'; readonly taskId: string; readonly deleted: true }

export interface CordisXTurnSubmitInput {
  readonly taskId: string
  readonly message: string
}

export type CordisXTurnControlInput =
  | { readonly action: 'steer'; readonly taskId: string; readonly turnId?: string; readonly message: string }
  | { readonly action: 'interrupt'; readonly taskId: string; readonly turnId?: string }

export interface CordisXTurnControlOutcome {
  readonly action: 'steer' | 'interrupt'
  readonly taskId: string
  readonly turnId?: string
}

export interface CordisXPlatform {
  status(): CordisXPlatformAdapterStatus
  readonly models: {
    list(input?: CordisXModelsListInput): Promise<CordisXPlatformResult<readonly CordisXModelDescriptor[]>>
  }
  readonly tasks: {
    list(input?: CordisXTasksListInput): Promise<CordisXPlatformResult<readonly CordisXTaskSummary[]>>
    read(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXTaskProjection>>
    create(input: CordisXTaskCreateInput): Promise<CordisXPlatformResult<CordisXTaskCreateOutcome>>
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
