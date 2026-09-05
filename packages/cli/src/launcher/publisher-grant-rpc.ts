import type { DirectPublisherGrantAuthority, PublisherGrantTarget } from './publisher-grants.js'

export const PUBLISHER_GRANT_BINDING = '__cordisxPublisherGrantRequestV1'
export const PUBLISHER_GRANT_RECEIVER = '__cordisxPublisherGrantReceiveV1'
export const MAX_PUBLISHER_GRANT_REQUEST_BYTES = 1_048_576

export type PublisherGrantBindingRequest =
  | { readonly requestId: string; readonly operation: 'challenge' }
  | { readonly requestId: string; readonly operation: 'import'; readonly statement: unknown }
  | { readonly requestId: string; readonly operation: 'status'; readonly target: PublisherGrantTarget }

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,96}$/.test(value)) {
    throw new Error('PublisherGrant request id is invalid')
  }
  return value
}
function target(value: unknown): PublisherGrantTarget {
  const input = object(value, 'PublisherGrant target')
  exact(input, ['pluginId', 'version', 'requestedFeatures'], 'PublisherGrant target')
  if (typeof input.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(input.pluginId)) {
    throw new Error('PublisherGrant target plugin id is invalid')
  }
  if (typeof input.version !== 'string' || input.version.length === 0 || input.version.length > 160) {
    throw new Error('PublisherGrant target version is invalid')
  }
  if (
    input.requestedFeatures !== undefined
    && (!Array.isArray(input.requestedFeatures) || input.requestedFeatures.some(item => typeof item !== 'string'))
  ) throw new Error('PublisherGrant requested features are invalid')
  return {
    pluginId: input.pluginId,
    version: input.version,
    ...(input.requestedFeatures === undefined ? {} : { requestedFeatures: input.requestedFeatures as string[] }),
  }
}

export function parsePublisherGrantBindingRequest(value: unknown): PublisherGrantBindingRequest {
  const input = object(value, 'PublisherGrant request')
  const operation = input.operation
  if (operation === 'challenge') {
    exact(input, ['version', 'requestId', 'operation'], 'PublisherGrant request')
    if (input.version !== 1) throw new Error('PublisherGrant request version is unsupported')
    return { requestId: requestId(input.requestId), operation }
  }
  if (operation === 'import') {
    exact(input, ['version', 'requestId', 'operation', 'statement'], 'PublisherGrant request')
    if (input.version !== 1 || input.statement === undefined) {
      throw new Error('PublisherGrant import request is invalid')
    }
    return { requestId: requestId(input.requestId), operation, statement: input.statement }
  }
  if (operation === 'status') {
    exact(input, ['version', 'requestId', 'operation', 'target'], 'PublisherGrant request')
    if (input.version !== 1) throw new Error('PublisherGrant status request is invalid')
    return { requestId: requestId(input.requestId), operation, target: target(input.target) }
  }
  throw new Error('PublisherGrant request operation is unsupported')
}

export interface PublisherGrantBridgeHandler {
  handle(request: PublisherGrantBindingRequest): Promise<unknown>
}
export function createPublisherGrantBridgeHandler(
  authority: DirectPublisherGrantAuthority,
): PublisherGrantBridgeHandler {
  return {
    async handle(request) {
      if (request.operation === 'challenge') return await authority.challenge()
      if (request.operation === 'import') return await authority.import(request.statement)
      return await authority.status(request.target)
    },
  }
}
