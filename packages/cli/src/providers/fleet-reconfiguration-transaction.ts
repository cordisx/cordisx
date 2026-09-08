import type { CordisXPlatformDiagnostic } from '../contracts.js'
import type { ProviderAdapterRegistry } from '../renderer/provider-registry.js'
import type { ProviderConnection } from './contracts.js'

export interface FleetGenerationState {
  readonly registry: ProviderAdapterRegistry<ProviderConnection>
  readonly failures: Map<string, CordisXPlatformDiagnostic>
  readonly names: Map<string, string>
  readonly lifecycleDisposers: Map<string, () => void>
  readonly providers: readonly { readonly providerId: string; readonly providerGeneration: string }[]
}

export function fleetReconfigurationTransaction(input: {
  readonly generation: string
  readonly previous: FleetGenerationState
  readonly replacement: FleetGenerationState
  readonly restore: (state: FleetGenerationState) => void
  readonly closeProviderGeneration?: (
    provider: { readonly providerId: string; readonly providerGeneration: string },
  ) => Promise<void>
}) {
  let state: 'open' | 'rolled-back' | 'finalized' = 'open'
  let previousRegistryDisposed = false
  const previousLifecycleDisposers = new Set(input.previous.lifecycleDisposers.values())
  const currentGenerations = new Set(
    input.replacement.providers.map(item => `${item.providerId}\0${item.providerGeneration}`),
  )
  const previousProviders = new Map(
    input.previous.providers
      .filter(provider => !currentGenerations.has(`${provider.providerId}\0${provider.providerGeneration}`))
      .map(provider => [`${provider.providerId}\0${provider.providerGeneration}`, provider]),
  )
  return {
    generation: input.generation,
    rollback: async () => {
      if (state !== 'open') return
      state = 'rolled-back'
      input.restore(input.previous)
      const failures: unknown[] = []
      await input.replacement.registry.dispose().catch(error => failures.push(error))
      for (const dispose of input.replacement.lifecycleDisposers.values()) {
        try {
          dispose()
        } catch (error) {
          failures.push(error)
        }
      }
      for (const provider of input.replacement.providers) {
        await input.closeProviderGeneration?.(provider).catch(error => failures.push(error))
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Provider Fleet rollback cleanup failed')
    },
    finalize: async () => {
      if (state === 'finalized' || state === 'rolled-back') return
      const failures: unknown[] = []
      if (!previousRegistryDisposed) {
        await input.previous.registry.dispose()
          .then(() => {
            previousRegistryDisposed = true
          })
          .catch(error => failures.push(error))
      }
      for (const dispose of [...previousLifecycleDisposers]) {
        try {
          dispose()
          previousLifecycleDisposers.delete(dispose)
        } catch (error) {
          failures.push(error)
        }
      }
      for (const [key, provider] of previousProviders) {
        await input.closeProviderGeneration?.(provider)
          .then(() => previousProviders.delete(key))
          .catch(error => failures.push(error))
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Provider Fleet finalize cleanup failed')
      state = 'finalized'
    },
  }
}
