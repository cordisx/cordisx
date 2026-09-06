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

  const removeByProviderId = new Map(input.entries.map(entry => [
    entry.connection.providerId,
    async () => await input.registry.removeProvider(entry.connection.providerId, entry.connection.generation),
  ]))
  let disposed = false
  const disposeProvider = async (providerId: string): Promise<boolean> => {
    const remove = removeByProviderId.get(providerId)
    if (remove === undefined) return false
    removeByProviderId.delete(providerId)
    const generation = input.entries.find(entry => entry.connection.providerId === providerId)?.connection.generation
    const current = input.registry.snapshots().some(item =>
      item.state === 'active' && item.providerId === providerId && item.generation === generation
    )
    if (!current) return false
    input.lifecycleDisposers.get(providerId)?.()
    input.lifecycleDisposers.delete(providerId)
    const removed = await remove()
    if (!removed) return false
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
