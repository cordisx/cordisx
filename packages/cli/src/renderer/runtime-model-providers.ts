import { BrowserManagedServiceUIBridge } from './managed-service-ui-bridge.js'
import { nativeModelProviderRegistry } from './model-providers.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'
import { StandaloneModelServices } from './standalone-model-services.js'
import { StandaloneNativeCatalog } from './standalone-native-catalog.js'

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
  const nativeCatalog = metadata.hostKind === 'standalone' ? StandaloneNativeCatalog.connect() : undefined
  const modelProviders = nativeModelProviderRegistry(managedServiceBridge, nativeCatalog)
  if (metadata.hostKind === 'standalone') {
    const services = StandaloneModelServices.connect()
    if (services) modelProviders.attachStandaloneModelServices(services)
  }
  const hostStartup = managedServiceBridge?.bindHostStartup()
  if (hostStartup !== undefined) modelProviders.connectStartup(hostStartup)
  return { managedServiceBridge, modelProviders }
}
