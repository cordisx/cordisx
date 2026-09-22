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

const BASE_URL = 'https://opencode.ai/zen/go/v1'

export function isOpenCodeGoEndpoint(endpoint: string): boolean {
  if (!/^https:\/\/opencode\.ai(?::443)?\/zen\/go\/v1\/?$/u.test(endpoint)) return false
  const url = new URL(endpoint)
  return url.origin === 'https://opencode.ai' && url.pathname.replace(/\/$/u, '') === '/zen/go/v1'
}

export function openCodeGoDiscoveryAdapter(): DiscoveryAdapter {
  return Object.freeze({
    id: 'opencode-go',
    version: '1',
    pagination: 'none',
    matches: (target: DiscoveryTarget) => isOpenCodeGoEndpoint(target.endpoint),
    async discover(connection: DiscoveryConnection, signal: AbortSignal) {
      if (!isOpenCodeGoEndpoint(connection.endpoint)) throw new CatalogError('unsupported')
      const body = object(await discoverJson(connection, BASE_URL, signal))
      if (
        !body || body.object !== undefined && body.object !== 'list'
        || !Array.isArray(body.data) || body.data.length > 1000
        || body.has_more === true || body.nextCursor != null || body.next_cursor != null
      ) throw new CatalogError('protocol')
      const labels = new Map<string, string>()
      const ids = body.data.map(value => {
        const model = object(value)
        if (
          !model || !boundedString(model.id)
          || model.object !== undefined && model.object !== 'model'
          || model.name !== undefined && !boundedString(model.name, 256)
          || model.owned_by !== undefined && !boundedString(model.owned_by, 256)
        ) throw new CatalogError('protocol')
        labels.set(model.id, typeof model.name === 'string' ? model.name : model.id)
        return model.id
      })
      return Object.freeze(catalogModels(ids).map(model => Object.freeze({ ...model, label: labels.get(model.id)! })))
    },
  })
}
