import { CatalogError, type DiscoveryAdapter, type DiscoveryTarget } from './contracts.js'

export class DiscoveryAdapterRegistry {
  private readonly adapters: readonly DiscoveryAdapter[]

  constructor(adapters: readonly DiscoveryAdapter[]) {
    if (new Set(adapters.map(adapter => adapter.id)).size !== adapters.length) {
      throw new Error('Duplicate discovery adapter')
    }
    this.adapters = Object.freeze([...adapters])
  }

  resolve(target: DiscoveryTarget, requested = 'detect'): DiscoveryAdapter {
    const matches = this.adapters.filter(adapter =>
      (requested === 'detect' || adapter.id === requested) && adapter.matches(target)
    )
    if (matches.length === 0) throw new CatalogError('unsupported')
    if (matches.length !== 1) throw new CatalogError('ambiguous')
    return matches[0]!
  }
}
