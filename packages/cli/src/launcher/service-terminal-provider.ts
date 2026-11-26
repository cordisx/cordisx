import type { ManagedServiceNativeActivation } from './managed-service-plugin-lifecycle.js'
import type { ManagedCatalogComposition } from './model-catalog/managed-catalog-composition.js'
import { nativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { createNativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { createTerminalProviderAuthority } from './terminal-provider.js'
import { startupProviderAdmission } from './startup-provider-admission.js'
import { StartupRequirementsCoordinator } from '../cli/startup-requirements.js'

export function createServiceTerminalProvider(input: {
  activation: ManagedServiceNativeActivation
  managed?: ManagedCatalogComposition
}) {
  const plugins = nativeModelProviderCatalog(input.activation)
  const catalog = async () => [
    ...(input.managed?.catalog() ?? []),
    ...(await plugins()).filter(provider => !input.managed?.owns(provider.providerId)),
  ]
  const resolve = (providerId: string) =>
    input.managed?.owns(providerId)
      ? input.managed.nativeConnection(providerId)
      : input.activation.prepareNativeConnection(providerId)
  const credentials = createNativeProviderCredentialBroker({ resolve })
  const authority = createTerminalProviderAuthority({
    startup: startupProviderAdmission(input.activation.startup, input.activation.startupObserver),
    catalog,
    owns: providerId =>
      input.managed?.owns(providerId) === true
      || input.activation.nativeProviderIds.includes(providerId),
    resolve,
    credentials,
    waitRequirements: async (providerId, modelId, signal) => {
      const target = providerId === undefined ? undefined : input.activation.startup.providerReference(providerId)
      if (providerId !== undefined && target === undefined) {
        const provider = (await catalog()).find(entry => entry.providerId === providerId)
        if (!provider || (modelId !== undefined && !provider.models.some(model => model.id === modelId))) {
          throw new Error('Selected provider/model is not available in this profile')
        }
      }
      return new StartupRequirementsCoordinator(input.activation.startup).wait({
        mode: 'command',
        timeoutMs: 55_000,
        ...(target === undefined ? {} : { explicit: { target, ...(modelId === undefined ? {} : { modelId }) } }),
        ...(signal === undefined ? {} : { signal }),
      })
    },
  })
  return {
    request: authority.request,
    async close() {
      authority.close()
      await credentials.close()
    },
  }
}
