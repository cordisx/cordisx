import { BrowserPluginLifecycleBridge } from './plugin-lifecycle-binding.js'
import { BrowserPluginManagementBinding } from './management-binding.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

export function createRuntimeManagementBindings(metadata: CordisXRuntimeMetadata, generation: string): {
  readonly lifecycleBridge: BrowserPluginLifecycleBridge | undefined
  readonly pluginManagementBinding: BrowserPluginManagementBinding | undefined
} {
  return {
    lifecycleBridge: metadata.pluginLifecycleBridgeToken === undefined
      ? undefined
      : new BrowserPluginLifecycleBridge(metadata.pluginLifecycleBridgeToken, metadata.profileId, generation),
    pluginManagementBinding: metadata.pluginManagement === undefined
      ? undefined
      : new BrowserPluginManagementBinding(metadata.pluginManagement.token, metadata.pluginManagement.profileId),
  }
}
