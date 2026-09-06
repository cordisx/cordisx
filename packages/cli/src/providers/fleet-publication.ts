import type { ProviderAdapterRegistry } from '../renderer/provider-registry.js'
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
  const existing = new Set(input.registry.snapshots().map(item => item.providerId))
  const incoming = new Set<string>()
  for (const entry of input.entries) {
    if (existing.has(entry.connection.providerId) || incoming.has(entry.connection.providerId)) {
      throw new Error(`provider ${entry.connection.providerId} is already registered`)
    }
    incoming.add(entry.connection.providerId)
  }
  const removers: Array<() => Promise<void>> = []
  try {
    for (const entry of input.entries) {
      const connection = entry.connection
      input.names.set(connection.providerId, entry.displayName)
      removers.push(input.registry.register({
        providerId: connection.providerId,
        generation: connection.generation,
        adapter: connection,
        dispose: async () => await connection.close(),
      }))
      const disposeLifecycle = connection.subscribeLifecycle?.(event =>
        input.observeLifecycle(connection.generation, event)
      )
      if (disposeLifecycle !== undefined) input.lifecycleDisposers.set(connection.providerId, disposeLifecycle)
    }
  } catch (error) {
    await Promise.all(removers.reverse().map(async remove => await remove().catch(() => undefined)))
    for (const providerId of incoming) {
      input.lifecycleDisposers.get(providerId)?.()
      input.lifecycleDisposers.delete(providerId)
      input.names.delete(providerId)
    }
    throw error
  }
  const removeByProviderId = new Map([...incoming].map((providerId, index) => [providerId, removers[index]!]))
  let disposed = false
  const disposeProvider = async (providerId: string): Promise<boolean> => {
    const remove = removeByProviderId.get(providerId)
    if (remove === undefined) return false
    removeByProviderId.delete(providerId)
    input.lifecycleDisposers.get(providerId)?.()
    input.lifecycleDisposers.delete(providerId)
    await remove()
    input.names.delete(providerId)
    return true
  }
  return {
    generation: input.entries.map(entry => entry.connection.generation).sort().join(','),
    disposeProvider,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await Promise.all([...removeByProviderId.keys()].map(disposeProvider))
    },
  }
}
