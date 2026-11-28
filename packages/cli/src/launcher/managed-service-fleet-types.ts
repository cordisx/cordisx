import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ManagedServiceUICapabilityMutation } from './plugin-lifecycle-model.js'
import type { ManagedServiceFleetLease } from './managed-service-fleet.js'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import type { ManagedServiceUIBridgeHandler, ManagedServiceUIOwner } from './managed-service-ui-rpc.js'

export interface ManagedServiceOwnerRoute {
  readonly key: string
  readonly token: string
  readonly owner: ManagedServiceUIOwner
  readonly startup?: true
  readonly handler: ManagedServiceUIBridgeHandler
}

export interface ManagedServiceFleet {
  readonly leases: readonly ManagedServiceFleetLease[]
  readonly activation: ManagedServiceNodeActivation | undefined
  readonly record?: CordisXPluginActivationRecordV1
  readonly routes: ReadonlyMap<string, ManagedServiceOwnerRoute>
}

export interface ManagedServiceTransaction {
  readonly previous: ManagedServiceFleet
  readonly candidate: ManagedServiceFleet
  readonly newCapabilities: readonly ManagedServiceUICapabilityMutation[]
  published: boolean
}
