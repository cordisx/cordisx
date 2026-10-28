import { RetryableCleanup } from './retryable-cleanup.js'
import type { ProviderAdapterRegistration, ProviderAdapterRegistry } from '../renderer/provider-registry.js'
import type { ProviderConnection, ProviderLifecycleSignal } from './contracts.js'

export interface ProviderFleetPublication {
  readonly generation: string
  disposeProvider(providerId: string): Promise<boolean>
  dispose(): Promise<void>
}

export async function publishProviderConnections(input: {
  readonly entries: readonly { readonly connection: ProviderConnection; readonly displayName: string }[]
  readonly registry: ProviderAdapterRegistry<ProviderConnection>
  readonly names: Map<string, string>
  readonly lifecycleDisposers: Map<string, () => void>
  readonly observeLifecycle: (generation: string, event: ProviderLifecycleSignal) => void
}): Promise<ProviderFleetPublication> {
  const existing = new Map(
    input.registry.snapshots()
      .filter(item => item.state === 'active')
      .map(item => [item.providerId, item.generation]),
  )
  const incoming = new Set<string>()
  const registrations: ProviderAdapterRegistration<ProviderConnection>[] = []
  const nextLifecycleDisposers = new Map<string, () => void>()
  try {
    for (const entry of input.entries) {
      const connection = entry.connection
      if (incoming.has(connection.providerId)) throw new Error(`provider ${connection.providerId} is registered twice`)
      if (existing.get(connection.providerId) === connection.generation) {
        throw new Error(`provider ${connection.providerId} generation did not change`)
      }
      incoming.add(connection.providerId)
      const disposeLifecycle = connection.subscribeLifecycle?.(event =>
        input.observeLifecycle(connection.generation, event)
      )
      if (disposeLifecycle !== undefined) nextLifecycleDisposers.set(connection.providerId, disposeLifecycle)
      registrations.push({
        providerId: connection.providerId,
        generation: connection.generation,
        adapter: connection,
        dispose: async () => await connection.close(),
      })
    }
  } catch (error) {
    for (const dispose of nextLifecycleDisposers.values()) dispose()
    throw error
  }

  await input.registry.replaceBatch(registrations)
  for (const entry of input.entries) {
    const providerId = entry.connection.providerId
    input.lifecycleDisposers.get(providerId)?.()
    const disposeLifecycle = nextLifecycleDisposers.get(providerId)
    if (disposeLifecycle === undefined) input.lifecycleDisposers.delete(providerId)
    else input.lifecycleDisposers.set(providerId, disposeLifecycle)
    input.names.set(providerId, entry.displayName)
  }

  const removals = new Map(input.entries.map(entry => {
    const { providerId, generation } = entry.connection
    const disposeLifecycle = nextLifecycleDisposers.get(providerId)
    const cleanup = new RetryableCleanup([
      async () => {
        if (input.lifecycleDisposers.get(providerId) === disposeLifecycle) {
          await disposeLifecycle?.()
          input.lifecycleDisposers.delete(providerId)
        }
      },
      async () => {
        await input.registry.removeProvider(providerId, generation)
      },
    ], 'Provider publication cleanup failed')
    return [providerId, cleanup] as const
  }))
  const disposeProvider = async (providerId: string): Promise<boolean> => {
    const cleanup = removals.get(providerId)
    if (cleanup === undefined) return false
    await cleanup.run()
    removals.delete(providerId)
    const generation = input.entries.find(entry => entry.connection.providerId === providerId)!.connection.generation
    const current = input.registry.snapshots().find(item => item.providerId === providerId && item.state === 'active')
    if (current === undefined || current.generation === generation) {
      input.lifecycleDisposers.delete(providerId)
      input.names.delete(providerId)
    }
    return true
  }
  const cleanup = new RetryableCleanup(
    [...removals.keys()].map(providerId => async () => {
      await disposeProvider(providerId)
    }),
    'Provider publications cleanup failed',
  )
  return {
    generation: input.entries.map(entry => entry.connection.generation).sort().join(','),
    disposeProvider,
    dispose: async () => await cleanup.run(),
  }
}
