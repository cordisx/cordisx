import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedBindingCurrent, managedHandle } from './managed-service-runtime-support.js'
import { ManagedNativeProviderPublications } from './managed-service-native-publications.js'
import {
  createNativeManagedGatewayConnection,
  type NativeManagedGatewayConnectionRequest,
  type NativeManagedGatewayConnectionSession,
} from './managed-service-native-connection.js'

/** Native connection authorities share the registrar's exact record lifetime. */
export class ManagedServiceRuntimeNative {
  readonly authorities = new Map<string, ManagedServiceRecord>()
  readonly publications = new ManagedNativeProviderPublications()

  constructor(private readonly registrations: ReadonlyMap<string, ManagedServiceRecord>) {}

  prepareNativeConnection(
    request: NativeManagedGatewayConnectionRequest,
  ): NativeManagedGatewayConnectionSession {
    const record = this.registrations.get(request.binding.registrationHandle)
    if (
      record === undefined || !managedBindingCurrent(request.binding, record.binding, record.disposed)
      || record.state !== 'ready'
      || record.origin === undefined
    ) throw new Error('selected managed service connection is unavailable or stale')
    const declaredOrigin = record.definition.compositionOrigins?.find(origin => origin.id === request.compositionOrigin)
    const authentication = record.definition.httpAuthentication
    const token = authentication.mode === 'authorization-header' ? record.secrets.get(authentication.slot) : undefined
    if (declaredOrigin === undefined || (authentication.mode === 'authorization-header' && token === undefined)) {
      throw new Error('selected managed service connection is incomplete')
    }
    const authorityId = managedHandle('msn')
    this.authorities.set(authorityId, record)
    return createNativeManagedGatewayConnection({
      pluginId: record.binding.identity.pluginId,
      serviceId: record.binding.identity.serviceId,
      serviceGeneration: record.binding.serviceGeneration,
      origin: record.origin,
      apiPath: declaredOrigin.path,
      ...(token === undefined ? {} : { token }),
      models: request.models,
      authorityId,
      dispose: () => {
        if (this.authorities.get(authorityId) === record) this.authorities.delete(authorityId)
      },
    })
  }

  listNativeProviderIds(pluginIds?: readonly string[]): readonly string[] {
    return this.publications.listProviderIds(pluginIds)
  }

  subscribeNativeProviders(listener: () => void): () => void {
    return this.publications.subscribe(listener)
  }

  preparePublishedNativeConnection(providerId: string): NativeManagedGatewayConnectionSession {
    const published = this.publications.resolve(providerId)
    if (published === undefined) throw new Error('native managed gateway provider is unavailable')
    return this.prepareNativeConnection({
      binding: published.record.binding,
      compositionOrigin: published.projection.compositionOrigin,
      models: {
        generation: published.projection.catalog.generation,
        defaultAlias: published.projection.catalog.defaultAlias,
        aliases: published.projection.catalog.routes.map(route => ({
          alias: route.alias,
          gatewayModelId: route.gatewayModelId,
          ...(() => {
            const reasoningCapabilities = parseModelReasoningCapabilities(
              'reasoningCapabilities' in route ? route.reasoningCapabilities : undefined,
            )
            return reasoningCapabilities === undefined ? {} : { reasoningCapabilities }
          })(),
        })),
      },
    })
  }
}
