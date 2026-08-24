import type { CordisXPluginManifestV1 } from '../../platform-contracts.js'

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
  readonly id: string
  readonly version: string
}

/** Host-normalized package metadata. Runtime plugin metadata is deliberately separate. */
export interface HostPackageManifest {
  readonly pluginId: string
  readonly version: string
  readonly dependencies: readonly PackageDependency[]
  readonly compatibility: {
    readonly runtimeAbi: 1
    readonly protocol: 1
  }
  readonly canonicalSource?: string
  readonly permissionFingerprint: string
}

export interface ResolvedRuntimeModule {
  readonly entry: string
  readonly manifest: CordisXPluginManifestV1
}

export interface ResolvedPackageCandidate {
  readonly packageManifest: HostPackageManifest
  readonly runtime: ResolvedRuntimeModule
}

/** Edge adapter. Protocol source/manifest revisions change here, not in the store core. */
export interface PackageManifestResolver {
  resolve(snapshotRoot: string): Promise<ResolvedPackageCandidate>
}

export interface PackageObjectRecord {
  readonly key: string
  readonly identity: PackageIdentity
  readonly manifest: HostPackageManifest
  readonly runtime: ResolvedRuntimeModule
  readonly objectDirectory: string
  readonly sources: readonly CanonicalPackageSource[]
  readonly createdAt: string
  readonly gcEligibleAt?: string
}

export type PackageOperation = 'install' | 'enable' | 'disable' | 'update' | 'uninstall'

export type PackageReloadLevel =
  | 'config-live'
  | 'plugin-restart'
  | 'plugin-generation'
  | 'runtime-generation'
  | 'app-restart'

export interface PackageLease {
  readonly packageKey: string
  readonly moduleGeneration: string
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
  readonly revision: number
  readonly lastGoodRevision: number
  readonly runtimeGeneration: string
  readonly lastGoodRuntimeGeneration: string
  readonly plugins: Readonly<Record<string, PluginPackageState>>
}

export interface PackageFenceEntry {
  readonly moduleGeneration: string
  readonly identity: PackageIdentity
}

export interface PackageGenerationFence {
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageFenceEntry>>
}

export interface PackageCandidatePlugin {
  readonly enabled: boolean
  readonly packageKey?: string
  readonly moduleGeneration: string
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
  readonly ownerId: string
  readonly operation: PackageOperation
  readonly profileId: string
  readonly status: PackageTransactionStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly baseRevision: number
  readonly expected: PackageGenerationFence
  readonly proposedRuntimeGeneration: string
  readonly target: Readonly<Record<string, PackageCandidatePlugin>>
  readonly changedPluginIds: readonly string[]
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
  readonly reloadLevel: PackageReloadLevel
  readonly candidateFingerprint: string
  readonly candidateTokenHash: string
  readonly impactTokenHash: string
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
  readonly artifactDirectory: string
  readonly runtimeEntry: string
  readonly runtimeManifest: CordisXPluginManifestV1
  readonly dependencies: readonly PackageDependency[]
}

export interface PackageActivationPlugin {
  readonly enabled: boolean
  readonly moduleGeneration: string
  readonly package?: ActivationPackageProjection
}

/** Complete Host-private activation tuple. Never accepted from renderer input. */
export interface PackageActivationTuple {
  readonly profileId: string
  readonly revision: number
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageActivationPlugin>>
}

export type PackageResolutionBoundary = 'plan' | 'stage' | 'publish' | 'rollback'

/** Narrow Node-only plan consumed by the separate Generation Runtime. */
export interface PackageActivationPlan {
  readonly transactionId: string
  readonly candidateId: PackageCandidateToken
  readonly boundary: PackageResolutionBoundary
  readonly profileId: string
  readonly profileActivationRevision: number
  readonly candidateFingerprint: string
  readonly expected: PackageActivationTuple
  readonly current: PackageActivationTuple
  readonly after: PackageActivationTuple
  readonly lastGood: PackageActivationTuple
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
}

export interface PackageImpactPlan {
  readonly transactionId: string
  readonly impactToken: PackageImpactToken
  readonly boundary: PackageResolutionBoundary
  readonly profileId: string
  readonly changedPluginIds: readonly string[]
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
}

export interface PackageReadinessReceipt {
  readonly transactionId: string
  readonly candidateId: PackageCandidateToken
  readonly candidateFingerprint: string
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageFenceEntry>>
}

export interface PackageCandidateAccess {
  readonly candidateId: PackageCandidateToken
  readonly ownerId: string
  readonly profileId: string
}

export interface PackageImpactAccess {
  readonly impactToken: PackageImpactToken
  readonly ownerId: string
  readonly profileId: string
}

export interface PackageRuntimeObservation {
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, PackageFenceEntry>>
}

declare const candidateTokenBrand: unique symbol
declare const impactTokenBrand: unique symbol

export type PackageCandidateToken = string & { readonly [candidateTokenBrand]: true }
export type PackageImpactToken = string & { readonly [impactTokenBrand]: true }

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
