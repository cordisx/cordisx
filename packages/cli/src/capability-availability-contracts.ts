import type { CordisXLocalizedText } from './contracts.js'
import type { CordisXPermissionCapabilityV2, CordisXPermissionScopeV2 } from './permission-contracts.js'

export type CordisXCapabilityAvailabilityState = 'supported' | 'unavailable' | 'degraded'

export type CordisXCapabilityProviderKind =
  | 'current-connection'
  | 'external-provider'
  | 'host-local'

export type CordisXCapabilityProviderFamily =
  | 'platform'
  | 'agent-events'
  | 'agent-history'
  | 'agent-input'
  | 'configuration'
  | 'console'
  | 'ui-rendering'
  | 'package-lifecycle'
  | 'channel'

export interface CordisXCapabilityProviderRoute {
  readonly capability: CordisXPermissionCapabilityV2
  readonly status: CordisXCapabilityAvailabilityState
  readonly reason: CordisXLocalizedText
  readonly scope: CordisXPermissionScopeV2
}

/** Private Host projection. It is not a plugin manifest or public adapter handle. */
export interface CordisXCapabilityProviderReport {
  readonly providerId: string
  readonly providerName: CordisXLocalizedText
  readonly kind: CordisXCapabilityProviderKind
  readonly family: CordisXCapabilityProviderFamily
  readonly status: CordisXCapabilityAvailabilityState
  readonly reason: CordisXLocalizedText
  readonly generation?: string
  readonly routes: readonly CordisXCapabilityProviderRoute[]
}

export interface CordisXExternalProviderAvailabilityStatus {
  readonly providerId: string
  readonly displayName: string
  readonly generation?: string
  readonly state: 'ready' | 'unavailable'
}
