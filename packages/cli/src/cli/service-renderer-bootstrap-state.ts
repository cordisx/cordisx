import type { CordisXConfig, CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import type { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import type { ServiceRendererConfiguredChannel } from './service-renderer-configured-channel.js'
import type { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import type { ServiceRendererManagementPlans } from './service-renderer-management-plans.js'

export type ServiceRendererSnapshot = ReturnType<OwnerRendererLifecycle['snapshot']>
export type ServiceRendererConfiguredChannelInput = {
  readonly plugin: CordisXConfigPlugin
  readonly service: LocalChannelService
  readonly bridge: ReadonlyChannelRendererBridge
}
export type ServiceRendererPendingIdentity = {
  readonly transactionId: string
  readonly previous: CordisXPluginActivationRecordV1
  readonly candidate: CordisXPluginActivationRecordV1
  readonly projectedPrevious: CordisXPluginActivationRecordV1
  readonly projectedCandidate: CordisXPluginActivationRecordV1
}
export type ServiceRendererBootstrapEntry = {
  readonly peer: ManagerRendererCommandPeer
  readonly leases: PluginGenerationGraphLease[]
  readonly checks: Set<Promise<boolean>>
  readonly unsubscribe: () => void
  readonly startupAbort: AbortController
  stale: boolean
  bootstrapConfirmed: boolean
  snapshot?: ServiceRendererSnapshot
  config?: CordisXConfig
  plugins?: readonly CordisXConfigPlugin[]
  projectedConfigs?: ReadonlyMap<string, unknown>
  desktopPackageConfigPlugins?: readonly string[]
  desktopLifecycleConfigPlugins?: readonly string[]
  packageInputs?: Map<string, string>
  policies?: readonly CordisXPersistedPermissionPolicyRecord[]
  managedOwners?: ReadonlyMap<string, string>
  managedContext?: ManagerRendererChannelContext
  identity?: ServiceRendererIdentityProjection
  identityContext?: ManagerRendererChannelContext
  identityAliases?: ReadonlyMap<string, string>
  managementPlans?: ServiceRendererManagementPlans
  restrictedLifecycleIds?: ReadonlySet<string>
  pendingIdentity?: ServiceRendererPendingIdentity
  needsIdentityProjection?: boolean
  releasePermissionFence?: () => Promise<void>
  releasePluginConfigFence?: () => Promise<void>
  retirement?: Promise<boolean>
  cleanupFailed?: boolean
  configuredChannel?: ServiceRendererConfiguredChannel
  channelTransition?: { readonly isCurrent: () => boolean }
  lifecycleTransition?: { readonly isCurrent: () => boolean }
  preparing?: Promise<unknown>
  completing?: Promise<unknown>
  permissionKey?: string
}
