import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import {
  inferProviderBrand,
  type ModelBrandChoice,
  type ModelSelectorIconOverrides,
  type ProviderBrandProjection,
} from '../model-selector-branding.js'

export interface NativeModelProviderCatalogEntry {
  readonly providerId: string
  readonly pluginId: string
  readonly title?: string
  readonly selectorBrand?: ProviderBrandProjection
  readonly models: readonly {
    readonly id: string
    readonly label: string
    readonly aliases: readonly string[]
    readonly selectorBrand?: ModelBrandChoice
    readonly provenance?: readonly ('auto' | 'native' | 'manual' | 'manual-supplement')[]
    readonly notListed?: boolean
  }[]
  readonly defaultModelId?: string
}

export function combinedNativeModelProviderCatalog(
  managed: () => Promise<readonly NativeModelProviderCatalogEntry[]>,
  configured: () => Promise<readonly NativeModelProviderCatalogEntry[]>,
) {
  return async (): Promise<readonly NativeModelProviderCatalogEntry[]> => {
    const [managedProviders, configuredProviders] = await Promise.all([managed(), configured()])
    const managedIds = new Set(managedProviders.map(provider => provider.providerId))
    return Object.freeze([
      ...managedProviders,
      ...configuredProviders.filter(provider => !managedIds.has(provider.providerId)),
    ])
  }
}

function projectProvider(
  providerId: string,
  session: NativeManagedGatewayConnectionSession,
  selectorIcons?: ModelSelectorIconOverrides,
): NativeModelProviderCatalogEntry {
  const connection = session.value
  const models = new Map<string, { label: string; aliases: string[] }>()
  for (const alias of connection.models.aliases) {
    const current = models.get(alias.gatewayModelId)
    if (current === undefined) {
      models.set(alias.gatewayModelId, { label: alias.alias, aliases: [alias.alias] })
    } else if (!current.aliases.includes(alias.alias)) current.aliases.push(alias.alias)
  }
  const defaultModelId = connection.models.aliases.find(alias => alias.alias === connection.models.defaultAlias)
    ?.gatewayModelId
  if (defaultModelId === undefined) {
    throw new Error(`native managed provider ${providerId} has no default route`)
  }
  return Object.freeze({
    providerId,
    pluginId: connection.service.pluginId,
    ...(() => {
      const override = selectorIcons?.providers[providerId]
      const inferred = inferProviderBrand({ baseUrl: `${connection.endpoint.origin}${connection.endpoint.apiPath}` })
      return override !== undefined
        ? { selectorBrand: Object.freeze({ brand: override, source: 'override' as const }) }
        : inferred === undefined
        ? {}
        : { selectorBrand: Object.freeze({ brand: inferred, source: 'inferred' as const }) }
    })(),
    models: Object.freeze([...models].map(([id, model]) =>
      Object.freeze({
        id,
        label: model.label,
        aliases: Object.freeze([...model.aliases]),
        ...(selectorIcons?.models[providerId]?.[id] === undefined
          ? {}
          : { selectorBrand: selectorIcons.models[providerId]![id] }),
      })
    )),
    defaultModelId,
  })
}

/** Host-private, read-only catalog projection. It never writes Codex config or defaults. */
export function nativeModelProviderCatalog(
  activation: Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>,
  selectorIcons?: ModelSelectorIconOverrides,
) {
  return async (): Promise<readonly NativeModelProviderCatalogEntry[]> => {
    const sessions: NativeManagedGatewayConnectionSession[] = []
    try {
      return Object.freeze(activation.nativeProviderIds.flatMap(providerId => {
        try {
          const session = activation.prepareNativeConnection(providerId)
          sessions.push(session)
          return [projectProvider(providerId, session, selectorIcons)]
        } catch {
          return []
        }
      }))
    } finally {
      for (const session of sessions) session.dispose()
    }
  }
}
