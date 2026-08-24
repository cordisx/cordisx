import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
  HostServiceConfigNarrowApi,
} from './service-config.js'

export const SERVICE_CONFIG_BINDING = '__cordisxServiceConfigRequestV1'
export const SERVICE_CONFIG_RECEIVER = '__cordisxServiceConfigReceiveV1'
export const MAX_SERVICE_CONFIG_REQUEST_BYTES = 1_048_576

type ServiceConfigRequest =
  | {
    readonly requestId: string
    readonly operation: 'list'
    readonly pluginId: string
    readonly scope: { readonly profileId: string; readonly generation: string }
  }
  | {
    readonly requestId: string
    readonly operation: 'mutate'
    readonly mutation: HostServiceConfigMutation
  }

export interface ServiceConfigBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  handle(request: ServiceConfigRequest): Promise<readonly HostServiceConfigDescriptor[] | HostServiceConfigMutationResult>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label)
  const unknown = Object.keys(result).find(key => !keys.includes(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is not supported`)
  return result
}

function localId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,96}$/.test(value)) throw new Error('service configuration request id is invalid')
  return value
}

function scope(value: unknown, profileId: string, generation: string): { readonly profileId: string; readonly generation: string } {
  const result = exact(value, ['profileId', 'generation'], 'service configuration scope')
  if (result.profileId !== profileId || result.generation !== generation) throw new Error('service configuration scope is stale or spoofed')
  return { profileId, generation }
}

function mutation(value: unknown, profileId: string, generation: string): HostServiceConfigMutation {
  const result = exact(value, ['contract', 'schemaVersion', 'identity', 'scope', 'expectedRevision', 'configuration'], 'service configuration mutation')
  if (result.contract !== 'cordisx.service-config-mutation/v1' || result.schemaVersion !== 1) {
    throw new Error('service configuration mutation contract is unsupported')
  }
  const identity = exact(result.identity, ['source', 'pluginId', 'serviceId'], 'service configuration identity')
  if (typeof identity.source !== 'string' || (!identity.source.startsWith('https:') && !identity.source.startsWith('file:'))) {
    throw new Error('service configuration source is invalid')
  }
  if (!Number.isSafeInteger(result.expectedRevision) || (result.expectedRevision as number) < 0) {
    throw new Error('service configuration expectedRevision is invalid')
  }
  return {
    contract: 'cordisx.service-config-mutation/v1',
    schemaVersion: 1,
    identity: { source: identity.source, pluginId: localId(identity.pluginId, 'service configuration plugin id'), serviceId: localId(identity.serviceId, 'service configuration id') },
    scope: scope(result.scope, profileId, generation),
    expectedRevision: result.expectedRevision as number,
    configuration: result.configuration as HostServiceConfigMutation['configuration'],
  }
}

/** Parse the token-bound, intentionally narrow renderer service-config surface. */
export function parseServiceConfigBindingRequest(value: unknown, token: string, profileId: string, generation: string): ServiceConfigRequest {
  const result = exact(value, ['version', 'token', 'requestId', 'operation', 'pluginId', 'scope', 'mutation'], 'service configuration request')
  if (result.version !== 1 || result.token !== token) throw new Error('service configuration request is not authorized')
  const id = requestId(result.requestId)
  if (result.operation === 'list') {
    return { requestId: id, operation: 'list', pluginId: localId(result.pluginId, 'service configuration plugin id'), scope: scope(result.scope, profileId, generation) }
  }
  if (result.operation === 'mutate') return { requestId: id, operation: 'mutate', mutation: mutation(result.mutation, profileId, generation) }
  throw new Error('service configuration operation is invalid')
}

export function createServiceConfigBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly services: readonly { readonly pluginId: string; readonly serviceId: string; readonly api: HostServiceConfigNarrowApi }[]
}): ServiceConfigBridgeHandler {
  const services = new Map<string, HostServiceConfigNarrowApi>()
  for (const service of input.services) {
    services.set(`${service.pluginId}\u0000${service.serviceId}`, service.api)
  }
  return {
    token: input.token,
    profileId: input.profileId,
    generation: input.generation,
    async handle(request) {
      if (request.operation === 'list') {
        const descriptors = await Promise.all([...services.values()].map(async service => await service.descriptor()))
        return descriptors.filter(descriptor => descriptor.identity.pluginId === request.pluginId)
      }
      const key = `${request.mutation.identity.pluginId}\u0000${request.mutation.identity.serviceId}`
      const service = services.get(key)
      if (service === undefined) throw new Error('service configuration identity is unavailable')
      return await service.mutate(request.mutation)
    },
  }
}

export function serviceConfigBridgeError(error: unknown): { readonly code: string; readonly error: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (/permission/iu.test(message)) return { code: 'permission-denied', error: 'Service configuration permission was denied.' }
  return { code: 'unavailable', error: 'Service configuration is unavailable.' }
}
