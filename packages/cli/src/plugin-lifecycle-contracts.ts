import type {
  CordisXPermissionAuthorizationDecisionV1,
  CordisXPermissionAuthorizationPlanV1,
  CordisXPluginManifestV1,
} from './platform-contracts.js'

export const CORDISX_PLUGIN_PACKAGE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v1.schema.json' as const
export const CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-activation.v1.schema.json' as const
export const CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json' as const
export const CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-result.v1.schema.json' as const
export const CORDISX_PLUGIN_RUNTIME_SNAPSHOT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-runtime-snapshot.v1.schema.json' as const
export const CORDISX_RUNTIME_ABI_V1 = 1 as const
export const CORDISX_PLUGIN_PROTOCOL_V1 = 1 as const

export type CordisXPluginApplyScope =
  | 'config-live'
  | 'plugin-restart'
  | 'plugin-generation'
  | 'runtime-generation'
  | 'app-restart'

export interface CordisXPluginDependencyV1 {
  readonly id: string
  readonly version: string
}

export interface CordisXPluginPackageManifestV1 {
  readonly $schema: typeof CORDISX_PLUGIN_PACKAGE_SCHEMA_V1
  readonly schemaVersion: 1
  readonly id: string
  readonly version: string
  readonly entry: string
  readonly readme?: string
  readonly canonicalSource?: string
  readonly compatibility: {
    readonly runtimeAbi: typeof CORDISX_RUNTIME_ABI_V1
    readonly protocol: typeof CORDISX_PLUGIN_PROTOCOL_V1
  }
  readonly dependencies: readonly CordisXPluginDependencyV1[]
  readonly runtimeManifest: CordisXPluginManifestV1
}

export interface CordisXPluginActivationItemV1 {
  readonly id: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly moduleGeneration: string
  readonly enabled: boolean
  readonly dependencies: readonly CordisXPluginDependencyV1[]
  readonly canonicalSource?: string
}

export interface CordisXPluginActivationRecordV1 {
  readonly $schema: typeof CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1
  readonly schemaVersion: 1
  readonly recordKind: 'active' | 'candidate' | 'last-good'
  readonly transactionId?: string
  readonly profileId: string
  readonly revision: number
  readonly lastGoodRevision: number
  readonly runtimeGeneration: string
  readonly plugins: readonly CordisXPluginActivationItemV1[]
}

export type CordisXPluginLifecycleOperationV1 =
  | { readonly kind: 'inspect-local'; readonly sourceDirectory: string }
  | {
    readonly kind: 'install' | 'update'
    readonly candidateId: string
    readonly authorizationDecision: CordisXPermissionAuthorizationDecisionV1
  }
  | {
    readonly kind: 'enable'
    readonly pluginId: string
    readonly authorizationDecision?: CordisXPermissionAuthorizationDecisionV1
  }
  | { readonly kind: 'reload'; readonly pluginId: string }
  | { readonly kind: 'disable' | 'uninstall'; readonly pluginId: string; readonly impactToken: string }

export interface CordisXPluginLifecycleRequestV1 {
  readonly $schema: typeof CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1
  readonly schemaVersion: 1
  readonly requestId: string
  readonly profileId: string
  readonly expectedRevision: number
  readonly runtimeGeneration: string
  readonly operation: CordisXPluginLifecycleOperationV1
}

export type CordisXPluginLifecycleErrorCode =
  | 'invalid-source'
  | 'invalid-manifest'
  | 'incompatible-runtime'
  | 'integrity-failed'
  | 'dependency-missing'
  | 'dependency-version'
  | 'dependency-cycle'
  | 'permission-denied'
  | 'build-failed'
  | 'readiness-failed'
  | 'stale-revision'
  | 'stale-generation'
  | 'activation-failed'
  | 'rollback-failed'
  | 'operation-unavailable'

export interface CordisXPluginLifecyclePackageSummaryV1 {
  readonly id: string
  readonly name?: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly dependencies: readonly CordisXPluginDependencyV1[]
  readonly canonicalSource?: string
}

export interface CordisXPluginLifecycleResultV1 {
  readonly $schema: typeof CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly requestId: string
  readonly profileId: string
  readonly operation: CordisXPluginLifecycleOperationV1['kind']
  readonly outcome: 'planned' | 'applied' | 'conflict' | 'rejected' | 'rolled-back' | 'rollback-failed'
  readonly revision: number
  readonly runtimeGeneration: string
  readonly scope: CordisXPluginApplyScope
  readonly affectedPluginIds: readonly string[]
  readonly transactionId?: string
  readonly candidateId?: string
  readonly impactToken?: string
  readonly package?: CordisXPluginLifecyclePackageSummaryV1
  readonly authorizationPlan?: CordisXPermissionAuthorizationPlanV1
  readonly error?: { readonly code: CordisXPluginLifecycleErrorCode; readonly message: string }
}

export type CordisXPluginLifecycleStatus =
  | 'active'
  | 'disabled'
  | 'blocked'
  | 'permission-blocked'
  | 'installing'
  | 'updating'
  | 'enabling'
  | 'disabling'
  | 'reloading'
  | 'uninstalling'
  | 'rolling-back'
  | 'failed'
  | 'rollback-failed'

export interface CordisXPluginRuntimeItemV1 {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly moduleGeneration: string
  readonly enabled: boolean
  readonly status: CordisXPluginLifecycleStatus
  readonly dependencies: readonly string[]
  readonly dependents: readonly string[]
  readonly favorite: boolean
  readonly availableOperations: readonly ('update' | 'enable' | 'disable' | 'reload' | 'share' | 'uninstall')[]
  readonly canonicalSource?: string
  readonly error?: { readonly code: string; readonly message: string }
}

export interface CordisXPluginRuntimeSnapshotV1 {
  readonly $schema: typeof CORDISX_PLUGIN_RUNTIME_SNAPSHOT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly profileId: string
  readonly revision: number
  readonly runtimeGeneration: string
  readonly operationsAvailable: boolean
  readonly plugins: readonly CordisXPluginRuntimeItemV1[]
}
