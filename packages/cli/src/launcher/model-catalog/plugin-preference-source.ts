import type { CatalogManagementCommand } from '../../model-catalog-management.js'
import type { ModelSelectorIconOverrides } from '../../model-selector-branding.js'
import type {
  PluginPreferenceAuthorityOptions,
  PluginPreferenceProvider,
} from '../../model-catalog/plugin-preference-authority.js'
import { nativeModelProviderCatalog, type NativeModelProviderCatalogEntry } from '../native-model-provider-catalog.js'
import type { NativeManagedGatewayConnectionSession } from '../managed-service-native-connection.js'
import type { ManagedServiceNodeActivation } from '../managed-service-node-host.js'

export interface LivePluginModelCatalogActivation
  extends Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>
{
  subscribeNativeProviders(listener: () => void): () => void
}

export type PluginPreferenceSourceOptions = Pick<
  PluginPreferenceAuthorityOptions,
  'load' | 'subscribeSource' | 'sourceCurrent'
>

function exactCurrentSource(
  activation: LivePluginModelCatalogActivation,
  provider: PluginPreferenceProvider,
  command: Exclude<CatalogManagementCommand, { operation: 'createConnection' }>,
): boolean {
  let session: NativeManagedGatewayConnectionSession | undefined
  try {
    session = activation.prepareNativeConnection(provider.providerId)
    if (session.value.service.pluginId !== provider.pluginId) return false
    return command.operation !== 'setOverlay'
      || session.value.models.aliases.some(model => model.gatewayModelId === command.modelId)
  } catch {
    return false
  } finally {
    session?.dispose()
  }
}

/** Production plugin catalog hook; source membership stays owned by the live managed-service generation. */
export function pluginPreferenceSource(
  activation: LivePluginModelCatalogActivation,
  selectorIcons?: ModelSelectorIconOverrides,
): PluginPreferenceSourceOptions {
  const load = nativeModelProviderCatalog(activation, selectorIcons) as () => Promise<
    readonly NativeModelProviderCatalogEntry[]
  >
  let sourceRevision = 0
  return Object.freeze({
    load: async () =>
      Object.freeze((await load()).map(provider =>
        Object.freeze({
          ...provider,
          sourceRevision: String(sourceRevision),
        })
      )),
    subscribeSource: (listener: () => void) => {
      const changed = () => {
        sourceRevision++
        listener()
      }
      return activation.subscribeNativeProviders(changed)
    },
    sourceCurrent: (
      provider: PluginPreferenceProvider,
      command: Exclude<CatalogManagementCommand, { operation: 'createConnection' }>,
    ) => provider.sourceRevision === String(sourceRevision) && exactCurrentSource(activation, provider, command),
  })
}
