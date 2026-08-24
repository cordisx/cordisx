import type {
  CordisXPluginActivationRecordV1,
  CordisXPluginDependencyV1,
} from '../../plugin-lifecycle-contracts.js'

export type LocalPackageSourceKind = 'local-directory' | 'local-package' | 'downloaded-tarball'

export interface LocalPackageSource {
  readonly kind: LocalPackageSourceKind
  readonly path: string
  readonly downloadedFrom?: string
  readonly expectedIntegrity?: `sha256:${string}`
}

export interface CanonicalPackageSource {
  readonly kind: LocalPackageSourceKind
  readonly url: string
  readonly downloadedFrom?: string
}

export interface PackageIdentity {
  readonly pluginId: string
  readonly version: string
  readonly integrity: `sha256:${string}`
}

export type PackageDependency = CordisXPluginDependencyV1

/** Package-v2 metadata. The referenced runtime manifest is a distinct object. */
export interface HostPackageManifest {
  readonly pluginId: string
  readonly version: string
  readonly entry: string
  readonly readme?: string
  readonly dependencies: readonly PackageDependency[]
  readonly compatibility: {
    readonly runtimeAbi: 1
    readonly protocolSchemas: readonly string[]
  }
  readonly distribution: {
    readonly mode: 'explicit-local-v1'
    readonly signature: 'unsupported'
  }
  readonly canonicalSource?: string
  readonly runtimeManifest: {
    readonly path: string
    readonly schema: string
    readonly digest: `sha256:${string}`
  }
  readonly permissionFingerprint: string
}

export type HostServiceConfigurationDeclaration =
  | { readonly kind: 'none' }
  | { readonly kind: 'host'; readonly schema: string; readonly configApplies: 'restart' }

export interface HostRuntimeServiceDeclaration {
  readonly id: string
  readonly kind: string
  readonly entry: string
  readonly configuration?: HostServiceConfigurationDeclaration
}

export interface HostResolvedRuntimeManifest {
  readonly $schema: string
  readonly schemaVersion: 1 | 2 | 3
  readonly id: string
  readonly name?: string
  readonly capabilities: readonly unknown[]
  readonly services?: readonly HostRuntimeServiceDeclaration[]
}

export interface ResolvedPackageCandidate {
  readonly packageManifest: HostPackageManifest
  readonly runtimeManifest: HostResolvedRuntimeManifest
}

export interface PackageManifestResolver {
  resolve(snapshotRoot: string): Promise<ResolvedPackageCandidate>
}

export type PackageResolutionBoundary = 'plan' | 'stage' | 'publish' | 'rollback'

export interface PackageActivationTuple {
  readonly profileId: string
  readonly revision: number
  readonly lastGoodRevision: number
  readonly runtimeGeneration: string
  readonly plugins: CordisXPluginActivationRecordV1['plugins']
}

export interface PackageCandidatePlan {
  readonly transactionId: string
  readonly boundary: PackageResolutionBoundary
  readonly profileActivationRevision: number
  readonly expectedRegistryEpoch: number
  readonly afterRegistryEpoch: number
  readonly expected: PackageActivationTuple
  readonly current: PackageActivationTuple
  readonly after: PackageActivationTuple
  readonly lastGood: PackageActivationTuple
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
}

export interface PackageRuntimeObservation {
  readonly profileActivationRevision: number
  readonly registryEpoch: number
  readonly runtimeGeneration: string
  readonly plugins: Readonly<Record<string, {
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly moduleGeneration: string
    readonly dependencies: readonly PackageDependency[]
  }>>
}

declare const candidateTokenBrand: unique symbol
declare const impactTokenBrand: unique symbol
declare const permissionReviewIdBrand: unique symbol
declare const permissionReviewTokenBrand: unique symbol
declare const rollbackTokenBrand: unique symbol

export type PackageCandidateToken = string & { readonly [candidateTokenBrand]: true }
export type PackageImpactToken = string & { readonly [impactTokenBrand]: true }
export type HostPermissionReviewId = string & { readonly [permissionReviewIdBrand]: true }
export type HostPermissionReviewToken = string & { readonly [permissionReviewTokenBrand]: true }
export type PackageRollbackToken = string & { readonly [rollbackTokenBrand]: true }

export class PackageLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PackageLifecycleError'
  }
}
