import { CatalogError, type DiscoveryAdapter } from './contracts.js'

export class DiscoveryAdapterRegistry {
  private readonly adapters: readonly DiscoveryAdapter[]

  constructor(adapters: readonly DiscoveryAdapter[]) {
    if (new Set(adapters.map(adapter => adapter.id)).size !== adapters.length) {
      throw new Error('Duplicate discovery adapter')
    }
    this.adapters = Object.freeze([...adapters])
  }

  resolve(endpoint: string, requested = 'detect'): DiscoveryAdapter {
    const matches = this.adapters.filter(adapter =>
      (requested === 'detect' || adapter.id === requested) && adapter.matches(endpoint)
    )
    if (matches.length === 0) throw new CatalogError('unsupported')
    if (matches.length !== 1) throw new CatalogError('ambiguous')
    return matches[0]!
  }
}
