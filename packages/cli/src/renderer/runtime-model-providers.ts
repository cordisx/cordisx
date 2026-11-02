import { BrowserManagedServiceUIBridge } from './managed-service-ui-bridge.js'
import { nativeModelProviderRegistry } from './model-providers.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

/** Compose the runtime-owned model bridge and its startup observation once. */
export function createRuntimeModelProviders(metadata: CordisXRuntimeMetadata, generation: string) {
  const managedServiceBridge =
    metadata.managedServiceCapabilities === undefined && metadata.startupHostCapability === undefined
      ? undefined
      : BrowserManagedServiceUIBridge.connect(
        metadata.managedServiceCapabilities ?? [],
        metadata.profileId,
        generation,
        metadata.startupHostCapability,
      )
  const modelProviders = nativeModelProviderRegistry(managedServiceBridge)
  const hostStartup = managedServiceBridge?.bindHostStartup()
  if (hostStartup !== undefined) modelProviders.connectStartup(hostStartup)
  return { managedServiceBridge, modelProviders }
}
