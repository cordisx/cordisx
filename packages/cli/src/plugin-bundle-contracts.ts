import type { PluginPackageSourceV1 } from './launcher/packages/source.js'

export const CORDISX_PLUGIN_BUNDLE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-bundle.v1.schema.json' as const
export const CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-bundle-lifecycle-operation.v1.schema.json' as const
export const CORDISX_PLUGIN_BUNDLE_LIFECYCLE_RESULT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-bundle-lifecycle-result.v1.schema.json' as const
export const CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-bundle-manager-snapshot.v1.schema.json' as const

export type CordisXPluginBundlePolicy = 'ask' | 'allow' | 'deny'
export type CordisXPluginBundleStatus =
  | 'active' | 'disabled' | 'partial' | 'permission-blocked' | 'version-conflict'
  | 'installing' | 'updating' | 'enabling' | 'disabling' | 'uninstalling'
  | 'failed' | 'rollback-failed'

export interface CordisXPluginBundleMemberV1 {
  readonly id: string
  readonly version: string
  readonly path: string
  readonly required: boolean
  readonly enabledByDefault: boolean
}

export interface CordisXPluginBundleManifestV1 {
  readonly $schema: typeof CORDISX_PLUGIN_BUNDLE_SCHEMA_V1
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version: string
  readonly authors: readonly string[]
  readonly readme: string
  readonly icon?: string
  readonly canonicalSource?: string
  readonly distribution: { readonly mode: 'explicit-local-v1'; readonly signature: 'unsupported' }
  readonly members: readonly CordisXPluginBundleMemberV1[]
}

export interface CordisXPluginBundlePermissionAssignmentV1 {
  readonly permissionId: string
  readonly policy: CordisXPluginBundlePolicy
}

export interface CordisXPluginBundlePluginOverrideV1 extends CordisXPluginBundlePermissionAssignmentV1 {
  readonly pluginId: string
}

export interface CordisXPluginBundlePluginPermissionReferenceV1 {
  readonly pluginId: string
  readonly permissionId: string
}

export type CordisXPluginBundleLifecycleOperationV1 =
  | { readonly kind: 'inspect-source'; readonly source: PluginPackageSourceV1 }
  | {
    readonly kind: 'install' | 'update'
    readonly candidateId: string
    readonly impactToken: string
    readonly bundlePermissions: readonly CordisXPluginBundlePermissionAssignmentV1[]
    readonly pluginOverrides: readonly CordisXPluginBundlePluginOverrideV1[]
  }
  | { readonly kind: 'enable' | 'disable' | 'uninstall'; readonly bundleId: string; readonly impactToken: string }
  | {
    readonly kind: 'set-permissions'
    readonly bundleId: string
    readonly bundlePermissions: readonly CordisXPluginBundlePermissionAssignmentV1[]
    readonly pluginOverrides: readonly CordisXPluginBundlePluginOverrideV1[]
    readonly clearPluginOverrides: readonly CordisXPluginBundlePluginPermissionReferenceV1[]
    readonly impactToken: string
  }
  | { readonly kind: 'set-optional-member'; readonly bundleId: string; readonly pluginId: string; readonly enabled: boolean; readonly impactToken: string }
  | { readonly kind: 'adopt-member'; readonly bundleId: string; readonly pluginId: string; readonly impactToken: string }

export interface CordisXPluginBundleLifecycleRequestV1 {
  readonly $schema: typeof CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1
  readonly schemaVersion: 1
  readonly requestId: string
  readonly profileId: string
  readonly expectedRevision: number
  readonly expectedPluginRevision: number
  readonly runtimeGeneration: string
  readonly operation: CordisXPluginBundleLifecycleOperationV1
}

export type CordisXPluginBundleMemberAction =
  | 'install' | 'update' | 'share' | 'enable' | 'disable' | 'retain' | 'remove' | 'skip'
export type CordisXPluginBundleMemberReason =
  | 'bundle-required' | 'bundle-optional' | 'existing-exact' | 'direct-claim'
  | 'other-bundle-claim' | 'runtime-dependency' | 'orphaned'

export interface CordisXPluginBundlePlanV1 {
  readonly bundle: {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly authors: readonly string[]
  }
  readonly memberActions: readonly {
    readonly pluginId: string
    readonly version: string
    readonly action: CordisXPluginBundleMemberAction
    readonly reason: CordisXPluginBundleMemberReason
  }[]
  readonly permissionRequests: readonly {
    readonly permissionId: string
    readonly pluginId: string
    readonly capability: string
    readonly scopeLabel: string
    readonly required: boolean
    readonly defaultPolicy: 'ask'
  }[]
  readonly conflicts: readonly {
    readonly pluginId: string
    readonly code: 'version-mismatch' | 'digest-mismatch' | 'dependency-conflict' | 'permission-review-required'
    readonly message: string
  }[]
}

export interface CordisXPluginBundleLifecycleResultV1 {
  readonly $schema: typeof CORDISX_PLUGIN_BUNDLE_LIFECYCLE_RESULT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly requestId: string
  readonly profileId: string
  readonly operation: CordisXPluginBundleLifecycleOperationV1['kind']
  readonly outcome: 'planned' | 'applied' | 'conflict' | 'rejected' | 'rolled-back' | 'rollback-failed'
  readonly revision: number
  readonly pluginRevision: number
  readonly runtimeGeneration: string
  readonly bundleId?: string
  readonly candidateId?: string
  readonly impactToken?: string
  readonly affectedPluginIds: readonly string[]
  readonly retainedPluginIds: readonly string[]
  readonly removedPluginIds: readonly string[]
  readonly plan?: CordisXPluginBundlePlanV1
  readonly error?: {
    readonly code: 'invalid-source' | 'invalid-bundle' | 'stale-revision' | 'stale-generation' | 'impact-changed'
      | 'version-conflict' | 'permission-review-required' | 'operation-unavailable' | 'apply-failed' | 'rollback-failed'
    readonly message: string
  }
}

export interface CordisXPluginBundleManagerMemberV1 {
  readonly pluginId: string
  readonly name?: string
  readonly requestedVersion: string
  readonly installedVersion?: string
  readonly installedDigest?: `sha256:${string}`
  readonly required: boolean
  readonly enabledByDefault: boolean
  readonly enabled: boolean
  readonly state: 'active' | 'disabled' | 'not-installed' | 'shared' | 'permission-blocked' | 'version-conflict' | 'failed'
  readonly installedViaBundle: boolean
  readonly bundleIds: readonly string[]
  readonly directClaim: boolean
  readonly runtimeDependentIds: readonly string[]
  readonly conflict?: { readonly code: 'version-mismatch' | 'digest-mismatch' | 'dependency-conflict'; readonly message: string }
}

export interface CordisXPluginBundleManagerPermissionV1 {
  readonly permissionId: string
  readonly pluginId: string
  readonly capability: string
  readonly scopeLabel: string
  readonly required: boolean
  readonly bundlePolicy: CordisXPluginBundlePolicy
  readonly pluginOverride?: CordisXPluginBundlePolicy
  readonly effectivePolicy: CordisXPluginBundlePolicy
  readonly effectiveSource: 'bundle' | 'shared-bundle-merge' | 'plugin-override' | 'safety-floor'
  readonly affectedBundleIds: readonly string[]
}

export interface CordisXPluginBundleManagerItemV1 {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly authors: readonly string[]
  readonly sourceLabel: string
  readonly canonicalSource?: string
  readonly iconHandle?: string
  readonly installedAt: string
  readonly updatedAt: string
  readonly status: CordisXPluginBundleStatus
  readonly enabled: boolean
  readonly readme: string
  readonly availableOperations: readonly ('update' | 'enable' | 'disable' | 'repair' | 'uninstall')[]
  readonly members: readonly CordisXPluginBundleManagerMemberV1[]
  readonly permissions: readonly CordisXPluginBundleManagerPermissionV1[]
  readonly claims: readonly { readonly pluginId: string; readonly kind: 'bundle' | 'direct' | 'runtime-dependency'; readonly claimantId: string }[]
  readonly dependencies: readonly { readonly pluginId: string; readonly dependencyId: string; readonly version: string }[]
  readonly records: readonly {
    readonly recordId: string
    readonly at: string
    readonly kind: CordisXPluginBundleLifecycleOperationV1['kind']
    readonly outcome: CordisXPluginBundleLifecycleResultV1['outcome']
    readonly message: string
    readonly pluginIds: readonly string[]
  }[]
}

export interface CordisXPluginBundleManagerSnapshotV1 {
  readonly $schema: typeof CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly profileId: string
  readonly revision: number
  readonly pluginRevision: number
  readonly runtimeGeneration: string
  readonly operationsAvailable: boolean
  readonly bundles: readonly CordisXPluginBundleManagerItemV1[]
}
