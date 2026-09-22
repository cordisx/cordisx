import type { NativeModelProviderCatalogEntry } from '../native-model-provider-catalog.js'
import type { CatalogBinding, CatalogModel, DiscoveryConnection } from './contracts.js'
import { ModelCatalogService } from './service.js'
import type { DiscoveryAdapterRegistry } from './registry.js'

export interface CatalogOwnerBinding {
  readonly binding: CatalogBinding
  readonly provider: Omit<NativeModelProviderCatalogEntry, 'models'>
  readonly connection?: DiscoveryConnection
  readonly read: (signal: AbortSignal) => Promise<readonly CatalogModel[]>
}

/** The effective target owner supplies bindings; this adapter never scans native credentials. */
export function createOwnerCatalogProjection(registry: DiscoveryAdapterRegistry) {
  const bindings = new Map<string, CatalogOwnerBinding>()
  const service = new ModelCatalogService({
    registry,
    connection: binding => bindings.get(binding.bindingRef)?.connection,
    read: (binding, signal) => bindings.get(binding.bindingRef)?.read(signal) ?? Promise.resolve([]),
  })
  return {
    service,
    update(binding: CatalogOwnerBinding) {
      const duplicate = [...bindings.values()].find(value =>
        value.provider.providerId === binding.provider.providerId
        && value.binding.bindingRef !== binding.binding.bindingRef
      )
      if (duplicate) throw new Error('Ambiguous target provider identity')
      bindings.set(binding.binding.bindingRef, binding)
      service.configure(binding.binding)
    },
    remove(bindingRef: string) {
      bindings.delete(bindingRef)
      service.remove(bindingRef)
    },
    catalog(): readonly NativeModelProviderCatalogEntry[] {
      return Object.freeze([...bindings.values()].map(({ binding, provider }) => {
        const snapshot = service.snapshot(binding.bindingRef)
        return Object.freeze({ ...provider, models: snapshot?.models ?? Object.freeze([]) })
      }))
    },
    subscribe: (listener: () => void) => service.subscribe(listener),
    dispose() {
      service.dispose()
      bindings.clear()
    },
  }
}
