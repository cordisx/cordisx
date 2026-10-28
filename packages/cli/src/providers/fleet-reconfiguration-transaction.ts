import { RetryableCleanup } from './retryable-cleanup.js'
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
  let direction: 'rollback' | 'finalize' | undefined
  const cleanup = (state: FleetGenerationState, message: string, providers = state.providers) =>
    new RetryableCleanup([
      async () => await state.registry.dispose(),
      ...[...state.lifecycleDisposers].map(([key, dispose]) => async () => {
        await dispose()
        if (state.lifecycleDisposers.get(key) === dispose) state.lifecycleDisposers.delete(key)
      }),
      ...providers.map(provider => async () => {
        await input.closeProviderGeneration?.(provider)
      }),
    ], message)
  const replacement = cleanup(input.replacement, 'Provider Fleet rollback cleanup failed')
  const currentGenerations = new Set(
    input.replacement.providers.map(item => `${item.providerId}\0${item.providerGeneration}`),
  )
  const previous = cleanup(
    input.previous,
    'Provider Fleet finalize cleanup failed',
    input.previous.providers.filter(provider =>
      !currentGenerations.has(`${provider.providerId}\0${provider.providerGeneration}`)
    ),
  )
  return {
    generation: input.generation,
    rollback: async () => {
      if (direction === 'finalize') throw new Error('Provider Fleet is finalizing')
      if (direction === undefined) {
        direction = 'rollback'
        input.restore(input.previous)
      }
      await replacement.run()
    },
    finalize: async () => {
      if (direction === 'rollback') throw new Error('Provider Fleet is rolling back')
      direction = 'finalize'
      await previous.run()
    },
  }
}
