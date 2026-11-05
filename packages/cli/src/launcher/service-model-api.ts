import { loadHomeConfig } from '../config/home-config.js'
import { mergeHomeEnvironment } from '../config/home-config-environment.js'
import type { ManagedServiceNativeActivation } from './managed-service-plugin-lifecycle.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import { nativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { modelServicesOf } from './model-service-projection.js'
import { startModelApiServer } from './model-api-server.js'
import type { ManagedCatalogComposition } from './model-catalog/managed-catalog-composition.js'

export function startServiceModelApi(input: {
  homeDir: string
  configPath: string
  profileId: string
  environment: NodeJS.ProcessEnv
  activation: ManagedServiceNativeActivation
  managed?: ManagedCatalogComposition
}) {
  const pluginCatalog = nativeModelProviderCatalog(input.activation)
  const declarations = async () => {
    const config = await loadHomeConfig(input.configPath)
    return {
      providers: modelServicesOf(config.providers).filter(provider => provider.enabled !== false),
      environment: mergeHomeEnvironment(input.environment, config.environmentVariables),
    }
  }
  const connectManaged = (session: NativeManagedGatewayConnectionSession, modelId: string, signal: AbortSignal) => {
    try {
      signal.throwIfAborted()
      if (!session.value.models.aliases.some(model => model.gatewayModelId === modelId)) {
        throw new Error('Model catalog changed; refresh /v1/models')
      }
      const { endpoint } = session.value
      return {
        baseUrl: `${endpoint.origin}${endpoint.apiPath}`,
        headers: endpoint.auth.scheme === 'bearer' ? { authorization: `Bearer ${endpoint.auth.token}` } : {},
        dispose: () => session.dispose(),
      }
    } catch (error) {
      session.dispose()
      throw error
    }
  }
  return startModelApiServer({
    homeDir: input.homeDir,
    profileId: input.profileId,
    port: Number(input.environment.CORDISX_MODEL_API_PORT ?? 8398),
    async catalog() {
      const plugins = await pluginCatalog()
      const managed = input.managed?.catalog() ?? []
      const ids = new Set([...managed, ...plugins].map(provider => provider.providerId))
      const shared = (await declarations().catch(() => undefined))?.providers.filter(provider => !ids.has(provider.id))
        ?? []
      return [
        ...managed,
        ...plugins.filter(provider => !input.managed?.owns(provider.providerId)),
        ...shared.map(provider => ({
          providerId: provider.id,
          pluginId: 'cordisx.model-service',
          title: provider.displayName,
          models: [
            ...new Set(
              Object.entries(provider.models ?? {}).flatMap(([app, models]) =>
                provider.appliesTo === undefined || provider.appliesTo.includes(app) ? models : []
              ),
            ),
          ].map(id => ({ id, label: id, aliases: [] })),
        })),
      ]
    },
    async connect(providerId, modelId, signal) {
      signal.throwIfAborted()
      if (input.managed?.owns(providerId)) {
        if (!await input.managed.validateSelection(providerId, modelId)) throw new Error('Managed model is unavailable')
        return connectManaged(await input.managed.nativeConnection(providerId), modelId, signal)
      }
      if (input.activation.nativeProviderIds.includes(providerId)) {
        return connectManaged(input.activation.prepareNativeConnection(providerId), modelId, signal)
      }
      const configured = await declarations()
      const provider = configured.providers.find(provider => provider.id === providerId)
      if (
        !provider
        || !Object.entries(provider.models ?? {}).some(([app, models]) =>
          (provider.appliesTo === undefined || provider.appliesTo.includes(app)) && models.includes(modelId)
        )
      ) throw new Error('Model service is unavailable')
      const key = configured.environment[provider.apiKeyEnv]
      if (!key) throw new Error(`Provider credential is unavailable: ${provider.apiKeyEnv}`)
      return {
        baseUrl: provider.baseUrl,
        headers: { authorization: `Bearer ${key}` },
        protocols: provider.protocols,
        dispose() {},
      }
    },
    invocation: () => 'model',
  })
}
