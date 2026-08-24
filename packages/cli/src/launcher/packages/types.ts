export type LocalPackageSourceKind = 'local-directory' | 'local-package' | 'downloaded-tarball'

export interface LocalPackageSource {
  readonly kind: LocalPackageSourceKind
  readonly path: string
  readonly expectedIntegrity?: string
}

export interface CanonicalPackageSource {
  readonly kind: LocalPackageSourceKind
  readonly url: string
}

export interface PackageIdentity {
  readonly pluginId: string
  readonly version: string
  readonly integrity: string
}

export interface PackageDependency {
  readonly pluginId: string
  readonly range: string
}

/**
 * Host-normalized static package metadata. The protocol adapter constructs this
 * from the separate package manifest; runtime plugin manifests are not used as
 * package metadata.
 */
export interface HostPackageManifest {
  readonly pluginId: string
  readonly version: string
  readonly entries: {
    readonly renderer?: string
    readonly node?: readonly string[]
  }
  readonly dependencies: readonly PackageDependency[]
  readonly compatibility: {
    readonly host: string
    readonly protocol?: string
  }
  readonly permissionFingerprint: string
}

export interface PackageManifestReader {
  read(snapshotRoot: string): Promise<HostPackageManifest>
}

export interface PackageObjectRecord {
  readonly key: string
  readonly identity: PackageIdentity
  readonly manifest: HostPackageManifest
  readonly objectDirectory: string
  readonly sources: readonly CanonicalPackageSource[]
  readonly createdAt: string
  readonly gcEligibleAt?: string
}

export type PackageOperation = 'install' | 'enable' | 'disable' | 'upgrade' | 'uninstall'

export type PackageReloadLevel =
  | 'config-live'
  | 'plugin-restart'
  | 'plugin-generation'
  | 'runtime-generation'
  | 'app-restart'

export interface PackageLease {
  readonly packageKey: string
  readonly pluginGeneration: string
}

export interface PluginPackageState {
  readonly enabled: boolean
  readonly installed?: PackageLease
  readonly active?: PackageLease
  readonly lastGood?: PackageLease
  readonly rollbackLeases: readonly PackageLease[]
  readonly uninstalled?: boolean
}

export interface PackageProfileState {
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PluginPackageState>>
}

export interface PackageFenceEntry {
  readonly pluginGeneration: string
  readonly identity: PackageIdentity
}

export interface PackageGenerationFence {
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageFenceEntry>>
}

export interface PackageCandidatePlugin {
  readonly enabled: boolean
  readonly packageKey?: string
  readonly pluginGeneration: string
  readonly remove?: boolean
}

export interface PackagePermissionReview {
  readonly planId: string
  readonly fingerprint: string
  readonly requiredSatisfied: boolean
  readonly unresolvedRequired: readonly string[]
  readonly deniedRequired: readonly string[]
}

export type PackageTransactionStatus =
  | 'permission-review'
  | 'ready'
  | 'activation-requested'
  | 'readiness-confirmed'
  | 'committed'
  | 'aborted'
  | 'recovered-aborted'

export interface PackageTransactionRecord {
  readonly transactionId: string
  readonly operation: PackageOperation
  readonly profileId: string
  readonly status: PackageTransactionStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly baseRevision: number
  readonly expected: PackageGenerationFence
  readonly proposedRuntimeGeneration: string
  readonly target: Readonly<Record<string, PackageCandidatePlugin>>
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
  readonly reloadLevel: PackageReloadLevel
  readonly candidateFingerprint: string
  readonly permission?: PackagePermissionReview
  readonly failureCode?: string
}

export interface PackageStoreState {
  readonly contract: 'cordisx.launcher-package-store/v1'
  readonly schemaVersion: 1
  readonly revision: number
  readonly packages: Readonly<Record<string, PackageObjectRecord>>
  readonly profiles: Readonly<Record<string, PackageProfileState>>
  readonly transactions: Readonly<Record<string, PackageTransactionRecord>>
}

export interface ActivationPackageProjection {
  readonly identity: PackageIdentity
  readonly objectDirectory: string
  readonly rendererEntry?: string
  readonly nodeEntries: readonly string[]
  readonly dependencies: readonly PackageDependency[]
}

/** Narrow Node-only value consumed by the separate Generation Runtime. */
export interface PackageActivationCandidate {
  readonly transactionId: string
  readonly storeRevision: number
  readonly profileId: string
  readonly expected: PackageGenerationFence
  readonly proposedRuntimeGeneration: string
  readonly candidateFingerprint: string
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
  readonly plugins: Readonly<Record<string, {
    readonly enabled: boolean
    readonly pluginGeneration: string
    readonly package?: ActivationPackageProjection
  }>>
}

export interface PackageReadinessReceipt {
  readonly transactionId: string
  readonly storeRevision: number
  readonly candidateFingerprint: string
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageFenceEntry>>
}

export interface PackageRuntimeObservation {
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageFenceEntry>>
}

export class PackageStoreConflictError extends Error {
  constructor(readonly actualRevision: number, message = `package store revision conflict; actual revision is ${actualRevision}`) {
    super(message)
    this.name = 'PackageStoreConflictError'
  }
}

export class PackageLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PackageLifecycleError'
  }
}
