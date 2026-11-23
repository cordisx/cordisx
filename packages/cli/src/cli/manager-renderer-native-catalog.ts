import { loadHomeConfig } from '../config/home-config.js'
import { codexConfigModelProviders } from '../launcher/codex-config-model-providers.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'

/** Read the selected Codex profile inside its owner; connection details never leave it. */
export function createManagerRendererNativeCatalogChannel(input: {
  readonly configPath: string
  readonly codexHome: string
  readonly profileId: string
  readonly generation: string
  readonly isCurrent: (context: ManagerRendererChannelContext) => boolean
}): ManagerRendererChannel {
  const current = (context: ManagerRendererChannelContext) => {
    try {
      return !context.signal.aborted && context.admitted === true && context.profileId === input.profileId
        && context.ownerGeneration === input.generation && input.isCurrent(context)
    } catch {
      return false
    }
  }
  return {
    prepare(payload, context) {
      if (!current(context) || typeof payload !== 'string' || Buffer.byteLength(payload) > 8 * 1024) {
        throw new Error('NATIVE_CATALOG_UNAVAILABLE')
      }
      const value: unknown = JSON.parse(payload)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('NATIVE_CATALOG_INVALID')
      }
      const request = value as Record<string, unknown>
      if (
        Object.keys(request).length !== 3 || request.version !== 1 || request.operation !== 'read'
        || typeof request.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId)
      ) throw new Error('NATIVE_CATALOG_INVALID')
      const requestId = request.requestId
      return {
        mode: 'read',
        channelConfigurationIndependent: true,
        dispatch: async () => {
          if (!current(context)) throw new Error('NATIVE_CATALOG_UNAVAILABLE')
          try {
            const first = await loadHomeConfig(input.configPath)
            const profile = first.apps.codex?.profiles[input.profileId]
            if (!profile || !current(context)) throw new Error('unavailable')
            const identity = JSON.stringify([profile.configModelCatalogs ?? null, profile.selectorIcons ?? null])
            const catalog = await codexConfigModelProviders(
              input.codexHome,
              profile.configModelCatalogs,
              profile.selectorIcons,
            )
            const second = await loadHomeConfig(input.configPath)
            const latest = second.apps.codex?.profiles[input.profileId]
            if (
              !catalog.sourceAvailable || !latest || !current(context)
              || JSON.stringify([latest.configModelCatalogs ?? null, latest.selectorIcons ?? null]) !== identity
            ) throw new Error('unavailable')
            // The discovery result also contains endpoint and credential metadata.
            // Project only the fields used by the existing read-only model page.
            const providers = catalog.providers.map(provider => ({
              providerId: provider.providerId,
              pluginId: provider.pluginId,
              readOnly: true as const,
              ...(provider.title === undefined ? {} : { title: provider.title }),
              ...(provider.selectorBrand === undefined ? {} : { selectorBrand: provider.selectorBrand }),
              ...(provider.defaultModelId === undefined ? {} : { defaultModelId: provider.defaultModelId }),
              models: provider.models.map(model => ({
                id: model.id,
                label: model.label,
                aliases: model.aliases,
                ...(model.selectorBrand === undefined ? {} : { selectorBrand: model.selectorBrand }),
                ...(model.reasoningCapabilities === undefined
                  ? {}
                  : { reasoningCapabilities: model.reasoningCapabilities }),
              })),
            }))
            if (Buffer.byteLength(JSON.stringify(providers)) > 6 * 1024 * 1024) throw new Error('unavailable')
            return { requestId, ok: true, value: { status: 'ok', providers } }
          } catch {
            throw new Error('NATIVE_CATALOG_UNAVAILABLE')
          }
        },
      }
    },
  }
}
