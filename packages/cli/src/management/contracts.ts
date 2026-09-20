import type { CordisXPermissionAuthorizationPlanV1 } from '../platform-contracts.js'
import type {
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from '../permission-contracts.js'
import type {
  CordisXPluginLifecyclePackageSummaryV1,
  CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type { CordisXPluginRuntimeItemV1 } from '../plugin-lifecycle-contracts.js'

export const OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE =
  'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'

export interface PluginManagementSourceLocal {
  readonly name?: string
  readonly description?: string
  /** Retained for lossless migration from the legacy browser store. */
  readonly note?: string
}

export interface PluginManagementSourceInput {
  readonly url: string
  readonly enabled: boolean
  readonly local?: PluginManagementSourceLocal
}

export interface PluginManagementSource extends PluginManagementSourceInput {
  readonly official: boolean
  readonly removable: boolean
}

export interface PluginManagementCatalogIdentity {
  readonly sourceUrl: string
  readonly pluginId: string
}

export interface PluginManagementCatalogQuery {
  readonly query?: string
  readonly sourceUrl?: string
  readonly version?: string
  readonly includeHidden?: boolean
}

export interface PluginManagementCatalogSummary {
  readonly identity: PluginManagementCatalogIdentity
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  readonly canonicalSource: string
  readonly version: string
  readonly name: string
  readonly description: string
  readonly authors: readonly string[]
  readonly keywords: readonly string[]
  readonly hidden: boolean
  readonly installable: boolean
}

export interface PluginManagementCatalogDetail extends PluginManagementCatalogSummary {
  readonly homepage?: string
  readonly license: string
  readonly artifact?: {
    readonly publisherIdentity?: string
    readonly packageNamespace?: string
    readonly packageName: string
    readonly downloadUrl: string
    readonly integrity: string
  }
}

export interface PluginManagementCatalogSourceStatus {
  readonly url: string
  readonly enabled: boolean
  readonly status: 'disabled' | 'loaded' | 'failed'
  readonly pluginCount?: number
  readonly error?: string
}

export interface PluginManagementCatalogSnapshot {
  readonly refreshedAt: string
  readonly sources: readonly PluginManagementCatalogSourceStatus[]
  readonly plugins: readonly PluginManagementCatalogSummary[]
}

export interface PluginManagementMigrationState {
  readonly legacyBrowserSourcesV2: boolean
}

export type PluginManagementRuntimeState =
  | { readonly kind: 'active'; readonly runtimeGeneration: string }
  | { readonly kind: 'inactive'; readonly pendingActivation: boolean }

export interface PluginManagementPlugin extends Omit<CordisXPluginRuntimeItemV1, 'status'> {
  readonly status: CordisXPluginRuntimeItemV1['status'] | 'pending-activation'
}

export interface PluginManagementSnapshot {
  readonly profileId: string
  readonly revision: number
  readonly sources: readonly PluginManagementSource[]
  readonly hiddenCatalogEntries: readonly PluginManagementCatalogIdentity[]
  readonly migrations: PluginManagementMigrationState
  readonly runtime: PluginManagementRuntimeState
  readonly activationRevision: number
  readonly plugins: readonly PluginManagementPlugin[]
}

export type PluginManagementConfigRequest =
  | { readonly kind: 'source-add'; readonly source: PluginManagementSourceInput }
  | { readonly kind: 'source-edit'; readonly url: string; readonly source: PluginManagementSourceInput }
  | { readonly kind: 'source-set-enabled'; readonly url: string; readonly enabled: boolean }
  | { readonly kind: 'source-remove'; readonly url: string }
  | { readonly kind: 'catalog-hide'; readonly identity: PluginManagementCatalogIdentity }
  | { readonly kind: 'catalog-unhide'; readonly identity: PluginManagementCatalogIdentity }

export type PluginManagementPermissionPlan =
  | CordisXPermissionAuthorizationPlanV1
  | CordisXPermissionAuthorizationPlanV2
  | CordisXPermissionAuthorizationPlanV4

export type PluginManagementPluginRequest =
  | { readonly kind: 'plugin-plan-local'; readonly sourceDirectory: string }
  | {
    readonly kind: 'plugin-plan-marketplace'
    readonly pluginId: string
    readonly sourceUrl?: string
    readonly version?: string
  }
  | { readonly kind: 'plugin-enable'; readonly pluginId: string }
  | { readonly kind: 'plugin-disable'; readonly pluginId: string }
  | { readonly kind: 'plugin-uninstall'; readonly pluginId: string }
  | { readonly kind: 'plugin-execute-plan'; readonly executionToken: string }

export type PluginManagementRequest = PluginManagementConfigRequest | PluginManagementPluginRequest

export interface PluginManagementLegacySourceMigration {
  readonly sources: readonly PluginManagementSourceInput[]
}

export type PluginManagementResult =
  | {
    readonly status: 'planned'
    readonly request: PluginManagementRequest
    readonly snapshot: PluginManagementSnapshot
    readonly executionRequest?: PluginManagementRequest
    readonly affectedPluginIds?: readonly string[]
    readonly lifecycle?: CordisXPluginLifecycleResultV1
  }
  | {
    readonly status: 'applied'
    readonly request: PluginManagementRequest
    readonly snapshot: PluginManagementSnapshot
    readonly pendingActivation: boolean
    readonly lifecycle?: CordisXPluginLifecycleResultV1
  }
  | {
    readonly status: 'permission-review-required'
    readonly request: PluginManagementPluginRequest
    readonly snapshot: PluginManagementSnapshot
    readonly candidateId: string
    readonly package?: CordisXPluginLifecyclePackageSummaryV1
    readonly permissionPlan: PluginManagementPermissionPlan
  }
  | {
    readonly status: 'rejected' | 'conflict'
    readonly request: PluginManagementRequest
    readonly snapshot: PluginManagementSnapshot
    readonly error: { readonly code: string; readonly message: string }
    readonly lifecycle?: CordisXPluginLifecycleResultV1
  }

export interface PluginManagementMigrationResult {
  readonly migrated: boolean
  readonly clearLegacyStorage: boolean
  readonly snapshot: PluginManagementSnapshot
}
