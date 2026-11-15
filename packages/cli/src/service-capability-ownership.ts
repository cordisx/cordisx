import type { CordisXPermissionCapabilityV2, CordisXPermissionScopeV2 } from './permission-contracts.js'

/** Host composition input from a service that actually started, never a plugin claim. */
export interface HostServiceCapabilityOwner {
  readonly source: string
  readonly pluginId: string
  readonly serviceId: string
  readonly serviceKind: string
  /** The management service incarnation, distinct from a restarted account transport. */
  readonly serviceGeneration: string
  readonly capabilities: readonly {
    readonly name: CordisXPermissionCapabilityV2
    readonly scope: CordisXPermissionScopeV2
  }[]
}

/** Launcher-private metadata. The renderer adds its own registered module generation. */
export interface RuntimeServiceCapabilityOwner extends HostServiceCapabilityOwner {
  readonly runtimeGeneration: string
  readonly moduleGeneration: string
}

export interface RegisteredServiceCapabilityOwner {
  /** Host-private registration incarnation, including replacement under identical labels. */
  readonly registrationToken: object
  readonly source: string
  readonly pluginId: string
  readonly serviceId: string
  readonly serviceKind: string
  readonly serviceGeneration: string
  readonly runtimeGeneration: string
  readonly moduleGeneration: string
  readonly scope: CordisXPermissionScopeV2
}
