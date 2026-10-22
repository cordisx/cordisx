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
import { parseModelReasoningCapabilities } from '../../model-reasoning-capabilities.js'

export function isDeepSeekOfficialEndpoint(endpoint: string): boolean {
  // Check spelling before URL normalization can discard dot segments or empty delimiters.
  if (!/^https:\/\/api\.deepseek\.com(?::443)?\/?$/u.test(endpoint)) return false
  const url = new URL(endpoint)
  return url.origin === 'https://api.deepseek.com' && url.pathname === '/'
}

export function deepSeekDiscoveryAdapter(): DiscoveryAdapter {
  return Object.freeze({
    id: 'deepseek-official',
    version: '3',
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
        const discovered = body.data.map(item => {
          const model = object(item)
          if (!model || model.object !== 'model' || !boundedString(model.id) || !boundedString(model.owned_by, 256)) {
            throw new CatalogError('protocol')
          }
          const effort = object(model.effort)
          const reasoningCapabilities = effort === undefined
            ? undefined
            : parseModelReasoningCapabilities({
              efforts: effort.supported_levels,
              defaultEffort: effort.default_level,
            })
          return reasoningCapabilities === undefined
            ? { id: model.id }
            : { id: model.id, reasoningCapabilities }
        })
        const reasoningById = new Map(
          discovered.flatMap(model =>
            model.reasoningCapabilities === undefined ? [] : [[model.id, model.reasoningCapabilities] as const]
          ),
        )
        // Official Codex integration and compatibility notices document these exact accepted IDs.
        return Object.freeze(
          catalogModels(discovered.map(model => model.id)).map(model => {
            const reasoningCapabilities = reasoningById.get(model.id)
            return Object.freeze({
              ...model,
              ...(reasoningCapabilities === undefined ? {} : { reasoningCapabilities }),
              ...([
                  'deepseek-flash',
                  'deepseek-v4-pro',
                  'deepseek-v4-flash',
                  'deepseek-v4-flash-vision-exp',
                ].includes(model.id)
                ? { protocolCapabilities: Object.freeze({ responses: true }) }
                : {}),
            })
          }),
        )
      } catch (error) {
        if (error instanceof CatalogError) throw error
        throw new CatalogError('protocol')
      }
    },
  })
}
