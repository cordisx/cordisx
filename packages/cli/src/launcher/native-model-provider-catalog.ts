import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'

export interface NativeModelProviderCatalogEntry {
  readonly providerId: string
  readonly pluginId: string
  readonly title?: string
  readonly models: readonly {
    readonly id: string
    readonly label: string
    readonly aliases: readonly string[]
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
    models: Object.freeze([...models].map(([id, model]) =>
      Object.freeze({
        id,
        label: model.label,
        aliases: Object.freeze([...model.aliases]),
      })
    )),
    defaultModelId,
  })
}

/** Host-private, read-only catalog projection. It never writes Codex config or defaults. */
export function nativeModelProviderCatalog(
  activation: Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>,
) {
  return async (): Promise<readonly NativeModelProviderCatalogEntry[]> => {
    const sessions: NativeManagedGatewayConnectionSession[] = []
    try {
      return Object.freeze(activation.nativeProviderIds.flatMap(providerId => {
        try {
          const session = activation.prepareNativeConnection(providerId)
          sessions.push(session)
          return [projectProvider(providerId, session)]
        } catch {
          return []
        }
      }))
    } finally {
      for (const session of sessions) session.dispose()
    }
  }
}
