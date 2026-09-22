import type {
  ScriptErrorCode,
  ScriptSourceConfig,
  ScriptSourceSnapshot,
} from './launcher/model-catalog/script-types.js'

/** Host-private management DTOs. Script configuration is write-only, never a snapshot. */
export type CatalogSourceKind = 'native' | 'auto' | 'manual' | 'script'
export type CatalogManagementCode =
  | 'unsupported'
  | 'unavailable'
  | 'conflict'
  | 'scope-changed'
  | 'permission'
  | 'source-invalid'
  | 'persist-failed'
  | 'credential-unavailable'
  | 'authentication'
  | 'account'
  | 'rate-limit'
  | 'temporary'
  | 'protocol'
  | ScriptErrorCode

export interface CatalogEditableModel {
  readonly id: string
  readonly label?: string
}

export interface CatalogConnectionSettings {
  readonly title: string
  readonly endpoint: string
  readonly protocol: 'responses' | 'chat-completions'
  readonly discoveryEnabled: boolean
  readonly strategy:
    | { readonly kind: 'auto'; readonly adapter: string; readonly ttlMs: number; readonly mode: 'only' | 'augment' }
    | { readonly kind: 'manual'; readonly ids: readonly string[] }
}

/** Host adapter evidence only; missing is unknown and does not grant submission. */
export interface CatalogProtocolCapabilities {
  readonly responses: boolean
}

export interface CatalogManagementRow {
  readonly id: string
  readonly label: string
  readonly provenance: readonly ('native' | 'auto' | 'manual' | 'manual-supplement' | 'script' | 'script-supplement')[]
  readonly notListed: boolean
  readonly present: boolean
  readonly selectable: boolean
  readonly blocked: boolean
  readonly pinned: boolean
  readonly protocolCapabilities?: CatalogProtocolCapabilities
  readonly reason?: 'blocked' | 'removed' | 'unconfirmed' | 'permission' | 'pending-apply'
}

export interface CatalogSafeDiagnostics {
  readonly code?: CatalogManagementCode
  readonly scopeConfirmed: boolean
  readonly targetState: 'applied' | 'pending-restart' | 'conflict' | 'unavailable'
  readonly lastAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly retryAt?: number
}

export type CatalogManagementOperation =
  | 'refresh'
  | 'setAutoPaused'
  | 'setOverlay'
  | 'resetOrder'
  | 'restoreBlocked'
  | 'convertToManual'
  | 'editManual'
  | 'editSupplement'
  | 'setSource'
  | 'setMode'
  | 'requestCredentialReplacement'
  | 'configureScript'
  | 'runScript'
  | 'cancelScript'
  | 'updateConnection'

export interface CatalogManagementView {
  readonly bindingRef: string
  readonly providerId: string
  readonly title: string
  readonly scopeLabel?: string
  readonly scopeRevision: string
  readonly revision: string
  readonly sourceKind: CatalogSourceKind
  readonly mode: 'only' | 'augment' | 'replace' | 'supplement'
  readonly freshness: 'unknown' | 'fresh' | 'stale'
  readonly activity: 'idle' | 'scheduled' | 'loading' | 'applying'
  readonly outcome: 'none' | 'ok' | 'empty' | 'error' | 'unsupported' | 'cancelled'
  readonly autoPaused: boolean
  readonly sourceCount: number
  readonly selectableCount: number
  /** Host orders rows and includes dormant preferences. Renderer never adds members. */
  readonly rows: readonly CatalogManagementRow[]
  readonly supplement: readonly CatalogEditableModel[]
  readonly capabilities: readonly CatalogManagementOperation[]
  readonly diagnostics: CatalogSafeDiagnostics
  readonly connection?: CatalogConnectionSettings
  readonly protocolCapabilities?: CatalogProtocolCapabilities
  readonly scriptState?: Pick<
    ScriptSourceSnapshot,
    'authorityRevision' | 'runGeneration' | 'persistence' | 'evidence'
  >
}

export interface CatalogManagementCursor {
  readonly epoch: string
  readonly sequence: number
}

export interface CatalogManagementSnapshot extends CatalogManagementCursor {
  readonly views: readonly CatalogManagementView[]
  readonly canCreateConnection?: boolean
}

interface CatalogCommandScope {
  readonly bindingRef: string
  readonly scopeRevision: string
  /** CAS across settings, source membership and overlay; issued by Host. */
  readonly expectedRevision: string
}

export type CatalogManagementCommand =
  | { readonly operation: 'createConnection'; readonly settings: CatalogConnectionSettings }
  | CatalogCommandScope
    & (
      | {
        readonly operation:
          | 'refresh'
          | 'resetOrder'
          | 'restoreBlocked'
          | 'convertToManual'
          | 'requestCredentialReplacement'
          | 'runScript'
          | 'cancelScript'
      }
      | { readonly operation: 'setAutoPaused'; readonly paused: boolean }
      | {
        readonly operation: 'setOverlay'
        readonly modelId: string
        readonly blocked?: boolean
        readonly pinned?: boolean
      }
      | { readonly operation: 'editManual' | 'editSupplement'; readonly models: readonly CatalogEditableModel[] }
      | { readonly operation: 'setSource'; readonly source: 'native' | 'auto' }
      | { readonly operation: 'setMode'; readonly mode: 'only' | 'augment' }
      | { readonly operation: 'updateConnection'; readonly settings: CatalogConnectionSettings }
      | {
        readonly operation: 'configureScript'
        readonly config: ScriptSourceConfig
        readonly mode: 'replace' | 'supplement'
      }
    )

export interface CatalogManagementResult {
  readonly status: 'applied' | 'queued' | 'conflict' | 'unavailable' | 'rejected'
  readonly snapshot?: CatalogManagementSnapshot
  readonly code?: CatalogManagementCode
  readonly retryAt?: number
}

/** Admitted Host document channel; script payloads are write-only and never exposed to plugins. */
export interface CatalogManagementChannel {
  catalogManagementRead(): Promise<CatalogManagementSnapshot>
  catalogManagementSubscribe(listener: (cursor: CatalogManagementCursor) => void): () => void
  catalogManagementCommand(command: CatalogManagementCommand): Promise<CatalogManagementResult>
}
