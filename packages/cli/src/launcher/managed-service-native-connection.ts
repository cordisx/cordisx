import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceRuntime } from './managed-service-runtime.js'

export interface NativeManagedGatewayConnection {
  readonly service: {
    readonly pluginId: string
    readonly serviceId: string
    readonly generation: string
  }
  readonly endpoint: {
    readonly origin: string
    readonly apiPath: `/${string}`
    readonly auth: { readonly scheme: 'bearer'; readonly token: string } | { readonly scheme: 'none' }
  }
  readonly models: {
    readonly generation: string
    readonly defaultAlias: string
    readonly aliases: readonly { readonly alias: string; readonly gatewayModelId: string }[]
  }
  readonly cleanup: { readonly authorityId: string }
}

export interface NativeManagedGatewayConnectionSession {
  readonly value: NativeManagedGatewayConnection
  dispose(): void
}

export interface NativeManagedGatewayConnectionRequest {
  readonly binding: ManagedServiceBindingV1
  readonly compositionOrigin: string
  readonly models: NativeManagedGatewayConnection['models']
}

export const NATIVE_MANAGED_GATEWAY_PROVIDER = Symbol.for('cordisx.host.native-managed-gateway-provider/v1')

export interface NativeManagedGatewayProviderCapability {
  resolve(providerId: string): NativeManagedGatewayConnectionRequest | undefined
}

export function nativeManagedGatewayProviderCapability(
  root: object,
): NativeManagedGatewayProviderCapability | undefined {
  const capability = Reflect.get(root, NATIVE_MANAGED_GATEWAY_PROVIDER) as unknown
  if (capability === undefined) return undefined
  if (
    capability === null || typeof capability !== 'object'
    || typeof (capability as { readonly resolve?: unknown }).resolve !== 'function'
  ) throw new Error('native managed gateway provider capability is invalid')
  return capability as NativeManagedGatewayProviderCapability
}

function catalogText(value: string, maxLength: number): boolean {
  const length = [...value].length
  return length > 0 && length <= maxLength
}

export function createNativeManagedGatewayConnection(input: {
  readonly pluginId: string
  readonly serviceId: string
  readonly serviceGeneration: string
  readonly origin: string
  readonly apiPath: `/${string}`
  readonly token?: string
  readonly models: NativeManagedGatewayConnection['models']
  readonly authorityId: string
  readonly dispose: () => void
}): NativeManagedGatewayConnectionSession {
  if (
    input.models.aliases.length === 0
    || new Set(input.models.aliases.map(item => item.alias)).size !== input.models.aliases.length
    || !input.models.aliases.some(item => item.alias === input.models.defaultAlias)
    || input.models.aliases.some(item => !catalogText(item.alias, 256) || !catalogText(item.gatewayModelId, 512))
  ) throw new Error('selected managed service model snapshot is invalid')
  let disposed = false
  return Object.freeze({
    value: Object.freeze({
      service: Object.freeze({
        pluginId: input.pluginId,
        serviceId: input.serviceId,
        generation: input.serviceGeneration,
      }),
      endpoint: Object.freeze({
        origin: input.origin,
        apiPath: input.apiPath,
        auth: input.token === undefined
          ? Object.freeze({ scheme: 'none' as const })
          : Object.freeze({ scheme: 'bearer' as const, token: input.token }),
      }),
      models: Object.freeze({
        generation: input.models.generation,
        defaultAlias: input.models.defaultAlias,
        aliases: Object.freeze(input.models.aliases.map(item => Object.freeze({ ...item }))),
      }),
      cleanup: Object.freeze({ authorityId: input.authorityId }),
    }),
    dispose: () => {
      if (disposed) return
      disposed = true
      input.dispose()
    },
  })
}

/** Host-private only. This value must never enter renderer or plugin projections. */
export function prepareNativeManagedGatewayConnection(
  runtime: ManagedServiceRuntime,
  request: NativeManagedGatewayConnectionRequest,
): NativeManagedGatewayConnectionSession {
  return runtime.prepareNativeConnection(request)
}
