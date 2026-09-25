import {
  boundedString,
  CatalogError,
  catalogModels,
  type DiscoveryAdapter,
  type DiscoveryConnection,
  type DiscoveryTarget,
  object,
} from './contracts.js'
import { discoverJson } from './discovery-http.js'

export function isDeepSeekOfficialEndpoint(endpoint: string): boolean {
  // Check spelling before URL normalization can discard dot segments or empty delimiters.
  if (!/^https:\/\/api\.deepseek\.com(?::443)?\/?$/u.test(endpoint)) return false
  const url = new URL(endpoint)
  return url.origin === 'https://api.deepseek.com' && url.pathname === '/'
}

export function deepSeekDiscoveryAdapter(): DiscoveryAdapter {
  return Object.freeze({
    id: 'deepseek-official',
    version: '2',
    pagination: 'none',
    matches: (target: DiscoveryTarget) => isDeepSeekOfficialEndpoint(target.endpoint),
    async discover(connection: DiscoveryConnection, externalSignal: AbortSignal) {
      if (!isDeepSeekOfficialEndpoint(connection.endpoint)) throw new CatalogError('unsupported')
      const body = object(await discoverJson(connection, 'https://api.deepseek.com', externalSignal))
      try {
        if (
          !body || body.object !== 'list' || !Array.isArray(body.data) || body.data.length > 1000
          || body.has_more === true || body.nextCursor != null || body.next_cursor != null
        ) throw new CatalogError('protocol')
        const ids = body.data.map(item => {
          const model = object(item)
          if (!model || model.object !== 'model' || !boundedString(model.id) || !boundedString(model.owned_by, 256)) {
            throw new CatalogError('protocol')
          }
          return model.id
        })
        // Official Codex integration and compatibility notices document these exact accepted IDs.
        return Object.freeze(
          catalogModels(ids).map(model =>
            Object.freeze({
              ...model,
              ...([
                  'deepseek-flash',
                  'deepseek-v4-pro',
                  'deepseek-v4-flash',
                  'deepseek-v4-flash-vision-exp',
                ].includes(model.id)
                ? { protocolCapabilities: Object.freeze({ responses: true }) }
                : {}),
            })
          ),
        )
      } catch (error) {
        if (error instanceof CatalogError) throw error
        throw new CatalogError('protocol')
      }
    },
  })
}
