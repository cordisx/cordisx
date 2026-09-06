import type {
  HostPermissionReviewId,
  HostPermissionReviewToken,
  HostServiceConfigurationDeclaration,
  PackageCandidatePlan,
  PackageCandidateToken,
  PackageIdentity,
  PackageImpactToken,
} from './types.js'

export interface PreparedCandidate {
  readonly transactionId: string
  readonly candidateFingerprint: string
  readonly candidateToken: PackageCandidateToken
  readonly impactToken: PackageImpactToken
  readonly permissionReviewId: HostPermissionReviewId
  readonly permissionReviewToken: HostPermissionReviewToken
  readonly plan: PackageCandidatePlan
}

export interface RuntimeModuleAccess {
  readonly packageIdentity: PackageIdentity
  readonly artifactDirectory: string
  readonly runtimeEntry: `./${string}`
}

export interface RuntimeServiceModuleAccess {
  readonly packageIdentity: PackageIdentity
  readonly pluginIdentity: {
    readonly source: string
    readonly pluginId: string
    readonly generation: string
  }
  readonly serviceId: string
  readonly serviceKind: 'channel-adapter'
  readonly configuration: HostServiceConfigurationDeclaration
  readonly artifactDirectory: string
  readonly runtimeEntry: `./services/${string}.mjs`
}

export interface PlatformProviderRuntimeServiceModuleAccess {
  readonly packageIdentity: PackageIdentity
  readonly pluginIdentity: {
    readonly source: string
    readonly pluginId: string
    readonly generation: string
  }
  readonly serviceId: string
  readonly hostGeneration: string
  readonly serviceKind: 'platform-provider'
  readonly owner: 'host'
  readonly schema: string
  readonly applicationMode: 'service-restart' | 'app-restart'
  readonly artifactDirectory: string
  readonly runtimeEntry: `./services/${string}.mjs`
}
