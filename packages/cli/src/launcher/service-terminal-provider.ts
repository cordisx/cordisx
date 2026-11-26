import { StartupRequirementsCoordinator } from '../cli/startup-requirements.js'
import type { ManagedCatalogComposition } from './model-catalog/managed-catalog-composition.js'
import type { ManagedServiceNativeActivation } from './managed-service-plugin-lifecycle.js'
import { nativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { createNativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { startupProviderAdmission, waitForNativeStartupProvider } from './startup-provider-admission.js'
import { createTerminalProviderAuthority } from './terminal-provider.js'

/** A headless profile owner lends bounded provider leases without starting a Desktop app. */
export function createServiceTerminalProvider(input: {
  readonly activation: ManagedServiceNativeActivation
  readonly managed?: ManagedCatalogComposition
}) {
  const { activation, managed } = input
  const pluginCatalog = nativeModelProviderCatalog(activation)
  const catalog = async () => {
    const host = managed?.catalog() ?? []
    const ids = new Set(host.map(provider => provider.providerId))
    const plugins = (await pluginCatalog()).flatMap(provider => {
      if (ids.has(provider.providerId)) return []
      if (!activation.startup.hasProvider(provider.providerId)) return [provider]
      const target = activation.startup.providerReference(provider.providerId)
      if (!target || target.pluginId !== provider.pluginId) return []
      const admission = activation.startup.nativeCatalogAdmission(target)
      if (!admission.available) return []
      const models = provider.models.filter(model => admission.modelIds.has(model.id))
      return models.length === 0 ? [] : [{ ...provider, models }]
    })
    return [...host, ...plugins]
  }
  const resolve = (id: string) =>
    managed?.owns(id) ? managed.nativeConnection(id) : activation.prepareNativeConnection(id)
  const credentials = createNativeProviderCredentialBroker({ resolve })
  const terminal = createTerminalProviderAuthority({
    startup: startupProviderAdmission(activation.startup, activation.startupObserver),
    waitRequirements: async (providerId, model, signal) => {
      const target = providerId === undefined ? undefined : activation.startup.providerReference(providerId)
      if (providerId !== undefined && target === undefined) {
        const provider = (await catalog()).find(entry => entry.providerId === providerId)
        if (!provider || model !== undefined && !provider.models.some(entry => entry.id === model)) {
          throw new Error('Selected provider/model is not available in this profile')
        }
      }
      return target === undefined
        ? await new StartupRequirementsCoordinator(activation.startup).wait({
          mode: 'command',
          timeoutMs: 55_000,
          ...(signal === undefined ? {} : { signal }),
        })
        : await waitForNativeStartupProvider(activation.startup, target, model, signal)
    },
    catalog,
    owns: id => managed?.owns(id) === true || activation.nativeProviderIds.includes(id),
    resolve,
    credentials,
  })
  return {
    request: terminal.request,
    reserveForService: terminal.reserveForService,
    reserveForLifecycle: terminal.reserveForLifecycle,
    async close() {
      terminal.close()
      await credentials.close()
    },
  }
}
