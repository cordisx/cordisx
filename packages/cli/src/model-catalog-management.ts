import type {
  ScriptErrorCode,
  ScriptSourceConfig,
  ScriptSourceSnapshot,
} from './launcher/model-catalog/script-types.js'

/** Host-private management DTOs. Script configuration is write-only, never a snapshot. */
export type CatalogSourceKind = 'native' | 'plugin' | 'auto' | 'manual' | 'script'
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
  /** User declaration for this exact connection scope and model ID, not adapter evidence. */
  readonly protocolCapabilities?: CatalogProtocolCapabilities
}

export interface CatalogConnectionSettings {
  /** Optional manual-model metadata, saved atomically with the connection. */
  readonly models?: readonly CatalogEditableModel[]
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

export type CatalogModelCompatibility = 'supported' | 'unsupported' | 'unknown'

export interface CatalogManagementRow {
  readonly id: string
  readonly label: string
  readonly provenance: readonly ('native' | 'auto' | 'manual' | 'manual-supplement' | 'script' | 'script-supplement')[]
  readonly notListed: boolean
  readonly present: boolean
  /** Host submission compatibility. Missing is accepted only from transitional producers and means unknown. */
  readonly compatibility?: CatalogModelCompatibility
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
  | 'setProviderFavorite'
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

export type CatalogPreferenceOperation = Extract<
  CatalogManagementOperation,
  'setProviderFavorite' | 'setOverlay' | 'resetOrder' | 'restoreBlocked'
>
export type CatalogSourceOperation = Exclude<CatalogManagementOperation, CatalogPreferenceOperation>

const preferenceOperations: readonly CatalogPreferenceOperation[] = [
  'setProviderFavorite',
  'setOverlay',
  'resetOrder',
  'restoreBlocked',
]
export function catalogPreferenceCapabilities(view: CatalogManagementView): readonly CatalogPreferenceOperation[] {
  return view.preferenceCapabilities
    ?? view.capabilities.filter((operation): operation is CatalogPreferenceOperation =>
      preferenceOperations.includes(operation as CatalogPreferenceOperation)
    )
}
export function catalogSourceCapabilities(view: CatalogManagementView): readonly CatalogSourceOperation[] {
  return view.sourceCapabilities
    ?? view.capabilities.filter((operation): operation is CatalogSourceOperation =>
      !preferenceOperations.includes(operation as CatalogPreferenceOperation)
    )
}
export function catalogOperationAvailable(
  view: CatalogManagementView,
  operation: CatalogManagementOperation,
): boolean {
  return preferenceOperations.includes(operation as CatalogPreferenceOperation)
    ? catalogPreferenceCapabilities(view).includes(operation as CatalogPreferenceOperation)
    : catalogSourceCapabilities(view).includes(operation as CatalogSourceOperation)
}

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
  readonly providerFavorite: boolean
  /** Present source members explicitly supported by the current Host. */
  readonly sourceCount: number
  /** Supported source members that are also currently route-available and not user-blocked. */
  readonly selectableCount: number
  /** Host orders rows and includes dormant preferences. Renderer never adds members. */
  readonly rows: readonly CatalogManagementRow[]
  readonly supplement: readonly CatalogEditableModel[]
  /** Source membership/configuration authority. Empty means the source itself is read-only. */
  readonly sourceCapabilities?: readonly CatalogSourceOperation[]
  /** Host-owned profile preferences, independent from source mutability. */
  readonly preferenceCapabilities?: readonly CatalogPreferenceOperation[]
  /** Transitional combined list consumed by existing Manager controls. */
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
      | { readonly operation: 'setProviderFavorite'; readonly favorite: boolean }
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

/** Stable favorite-first partition; unfavoriting restores the owner's canonical order. */
export function favoriteCatalogManagementViews(
  views: readonly CatalogManagementView[],
): readonly CatalogManagementView[] {
  return Object.freeze([
    ...views.filter(view => view.providerFavorite),
    ...views.filter(view => !view.providerFavorite),
  ])
}

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
