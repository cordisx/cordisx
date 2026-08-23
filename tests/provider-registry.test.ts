import { describe, expect, it, vi } from 'vitest'
import { ProviderAdapterRegistry, ProviderRegistryError } from '../packages/cli/src/renderer/provider-registry.js'

describe('ProviderAdapterRegistry', () => {
  it('routes equal provider-local session ids by complete composite identity', async () => {
    const registry = new ProviderAdapterRegistry<{ readonly name: string }>()
    const removeMain = registry.register({ providerId: 'main', generation: 'g1', adapter: { name: 'main-adapter' } })
    const removeBackup = registry.register({ providerId: 'backup', generation: 'g1', adapter: { name: 'backup-adapter' } })
    expect(() => registry.register({ providerId: 'main', generation: 'g2', adapter: { name: 'duplicate' } }))
      .toThrow('provider main is already registered')

    const main = registry.acquireSession({ providerId: 'main', remoteSessionId: 'thread-1' })
    const backup = registry.acquireSession({ providerId: 'backup', remoteSessionId: 'thread-1' })
    expect(main.adapter.name).toBe('main-adapter')
    expect(backup.adapter.name).toBe('backup-adapter')
    main.release()
    backup.release()

    expect(() => registry.acquireSession('thread-1' as never)).toThrow(ProviderRegistryError)
    await Promise.all([removeMain(), removeBackup()])
    await registry.dispose()
  })

  it('generation-fences replacement and drains the prior adapter after its last lease', async () => {
    const oldDispose = vi.fn(async () => {})
    const registry = new ProviderAdapterRegistry<{ readonly version: number }>()
    registry.register({ providerId: 'main', generation: 'g1', adapter: { version: 1 }, dispose: oldDispose })
    const oldLease = registry.acquire('main', 'g1')

    const drained = registry.replace({ providerId: 'main', generation: 'g2', adapter: { version: 2 } })
    expect(registry.snapshots()).toEqual([
      { providerId: 'main', generation: 'g1', state: 'draining', inFlight: 1 },
      { providerId: 'main', generation: 'g2', state: 'active', inFlight: 0 },
    ])
    expect(() => registry.acquire('main', 'g1')).toThrow(expect.objectContaining({ code: 'stale-generation' }))
    const current = registry.acquire('main', 'g2')
    expect(current.adapter.version).toBe(2)
    current.release()
    expect(oldDispose).not.toHaveBeenCalled()

    oldLease.release()
    await drained
    expect(oldDispose).toHaveBeenCalledOnce()
    expect(registry.snapshots()).toEqual([
      { providerId: 'main', generation: 'g2', state: 'active', inFlight: 0 },
    ])
    await registry.dispose()
  })
})
