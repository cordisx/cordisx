import {
  boundedString,
  CatalogError,
  type CatalogModel,
  type DiscoveryAdapter,
  type DiscoveryConnection,
  type DiscoveryTarget,
  object,
} from './contracts.js'
import { discoverJson } from './discovery-http.js'

const BASE_URL = 'https://openrouter.ai/api/v1'

export function isOpenRouterEndpoint(endpoint: string): boolean {
  if (!/^https:\/\/openrouter\.ai(?::443)?\/api\/v1\/?$/u.test(endpoint)) return false
  const url = new URL(endpoint)
  return url.origin === 'https://openrouter.ai' && url.pathname.replace(/\/$/u, '') === '/api/v1'
}

const stringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.length <= 256 && value.every(item => boundedString(item, 128))
    ? value as string[]
    : undefined

function candidate(value: unknown): CatalogModel | undefined {
  const model = object(value)
  if (
    !model || !boundedString(model.id)
    || !/^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,447}$/u.test(model.id)
  ) {
    throw new CatalogError('protocol')
  }
  if (model.name !== undefined && !boundedString(model.name, 256)) throw new CatalogError('protocol')
  const architecture = object(model.architecture)
  const supported = stringList(model.supported_parameters)
  const inputs = stringList(architecture?.input_modalities)
  const outputs = stringList(architecture?.output_modalities)
  if (!architecture || !supported || !inputs || !outputs) throw new CatalogError('protocol')
  if (!inputs.includes('text') || !outputs.includes('text') || !supported.includes('tools')) return undefined
  return Object.freeze({
    id: model.id,
    label: typeof model.name === 'string' ? model.name : model.id,
    aliases: Object.freeze([]),
  })
}

export function openRouterDiscoveryAdapter(): DiscoveryAdapter {
  return Object.freeze({
    id: 'openrouter',
    version: '1',
    pagination: 'none',
    matches: (target: DiscoveryTarget) => isOpenRouterEndpoint(target.endpoint),
    async discover(connection: DiscoveryConnection, signal: AbortSignal) {
      if (!isOpenRouterEndpoint(connection.endpoint)) throw new CatalogError('unsupported')
      const body = object(await discoverJson(connection, BASE_URL, signal))
      if (!body || !Array.isArray(body.data) || body.data.length > 1000) throw new CatalogError('protocol')
      if (body.total_count !== undefined) {
        if (!Number.isSafeInteger(body.total_count) || Number(body.total_count) < body.data.length) {
          throw new CatalogError('protocol')
        }
        if (Number(body.total_count) > body.data.length) throw new CatalogError('protocol')
      }
      const links = body.links === undefined ? undefined : object(body.links)
      if ((body.links !== undefined && !links) || links?.next != null) throw new CatalogError('protocol')
      const models = body.data.flatMap(value => {
        const model = candidate(value)
        return model ? [model] : []
      })
      const ids = new Set<string>()
      return Object.freeze(models.filter(model => {
        if (ids.has(model.id)) return false
        ids.add(model.id)
        return true
      }))
    },
  })
}
