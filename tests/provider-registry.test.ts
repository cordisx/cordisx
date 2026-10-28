import { publishProviderConnections } from '../packages/cli/src/providers/fleet-publication.js'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ProviderAdapterRegistry, ProviderRegistryError } from '../packages/cli/src/renderer/provider-registry.js'

describe('ProviderAdapterRegistry', () => {
  it('routes equal provider-local session ids by complete composite identity', async () => {
    const registry = new ProviderAdapterRegistry<{ readonly name: string }>()
    const removeMain = registry.register({ providerId: 'main', generation: 'g1', adapter: { name: 'main-adapter' } })
    const removeBackup = registry.register({
      providerId: 'backup',
      generation: 'g1',
      adapter: { name: 'backup-adapter' },
    })
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
  it.each(['dispose', 'remove', 'replace', 'replaceBatch'] as const)(
    'retains failed generation cleanup after %s and coalesces lease-release cleanup',
    async mode => {
      const cleanup = vi.fn().mockRejectedValueOnce(new Error('close failed')).mockResolvedValue(undefined)
      const registry = new ProviderAdapterRegistry<object>()
      const remove = registry.register({ providerId: 'main', generation: 'g1', adapter: {}, dispose: cleanup })
      const lease = registry.acquire('main', 'g1')
      const replacement = { providerId: 'main', generation: 'g2', adapter: {} }
      const result = mode === 'dispose'
        ? registry.dispose()
        : mode === 'remove'
        ? remove()
        : mode === 'replace'
        ? registry.replace(replacement)
        : registry.replaceBatch([replacement])
      const rejected = expect(result).rejects.toThrow(/cleanup failed|close failed/)
      lease.release()
      lease.release()
      await rejected
      expect(cleanup).toHaveBeenCalledOnce()
      expect(registry.snapshots()).toContainEqual({
        providerId: 'main',
        generation: 'g1',
        state: 'draining',
        inFlight: 0,
      })
      expect(() => registry.acquire('main', 'g1')).toThrow()
      if (mode !== 'dispose') {
        expect(() => registry.replace({ providerId: 'main', generation: 'g1', adapter: {} }))
          .toThrow('cleanup is incomplete')
      }
      await Promise.all([registry.removeProvider('main', 'g1'), registry.removeProvider('main', 'g1')])
      expect(cleanup).toHaveBeenCalledTimes(2)
      expect(registry.snapshots().some(item => item.generation === 'g1')).toBe(false)
      await registry.dispose()
      await registry.dispose()
      expect(cleanup).toHaveBeenCalledTimes(2)
    },
  )

  it('reports all close failures, handles a synchronous throw, and retries only failed records', async () => {
    const registry = new ProviderAdapterRegistry<object>()
    const first = vi.fn().mockImplementationOnce(() => {
      throw new Error('sync close')
    }).mockResolvedValue(undefined)
    const second = vi.fn().mockRejectedValueOnce(new Error('async close')).mockResolvedValue(undefined)
    const success = vi.fn(async () => {})
    for (const [providerId, dispose] of [['first', first], ['second', second], ['success', success]] as const) {
      registry.register({ providerId, generation: 'g1', adapter: {}, dispose })
    }
    await expect(registry.dispose()).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
    await Promise.all([registry.dispose(), registry.dispose()])
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    expect(success).toHaveBeenCalledOnce()
    expect(registry.snapshots()).toEqual([])
  })

  it('keeps lease-release close failures from escaping as unhandled rejections in Node', () => {
    const source = new URL('../packages/cli/src/renderer/provider-registry.ts', import.meta.url).href
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
      import { ProviderAdapterRegistry } from ${JSON.stringify(source)};
      const registry = new ProviderAdapterRegistry();
      let attempts = 0;
      registry.register({ providerId: 'fixture', generation: 'g1', adapter: {}, dispose: async () => {
        if (++attempts === 1) throw new Error('fixture-close-failure');
      } });
      const lease = registry.acquire('fixture');
      const removal = registry.removeProvider('fixture', 'g1');
      const outcome = removal.then(() => 'success', () => 'failure');
      lease.release();
      if (await outcome !== 'failure') throw new Error('close failure was hidden');
      await new Promise(resolve => setTimeout(resolve, 0));
      if (registry.snapshots().length !== 1) throw new Error('failed generation was lost');
      await registry.dispose();
      if (attempts !== 2) throw new Error('cleanup was not retried');
    `,
    ], { encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
  it('retries a failed publication close without removing its successor metadata or repeating unsubscribe', async () => {
    const registry = new ProviderAdapterRegistry<any>()
    const names = new Map<string, string>(), lifecycleDisposers = new Map<string, () => void>()
    const unsubscribe = vi.fn(() => {})
    const close = vi.fn().mockRejectedValueOnce(new Error('close failed')).mockResolvedValue(undefined)
    const connection = { providerId: 'main', generation: 'g1', close, subscribeLifecycle: () => unsubscribe } as never
    const publication = await publishProviderConnections({
      entries: [{ connection, displayName: 'Old' }],
      registry,
      names,
      lifecycleDisposers,
      observeLifecycle: () => {},
    })
    await expect(publication.dispose()).rejects.toThrow('cleanup failed')
    const nextUnsubscribe = vi.fn(() => {})
    await publishProviderConnections({
      entries: [{
        connection: {
          providerId: 'main',
          generation: 'g2',
          close: async () => {},
          subscribeLifecycle: () => nextUnsubscribe,
        } as never,
        displayName: 'New',
      }],
      registry,
      names,
      lifecycleDisposers,
      observeLifecycle: () => {},
    })
    await publication.dispose()
    await publication.dispose()
    expect(close).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(nextUnsubscribe).not.toHaveBeenCalled()
    expect(names.get('main')).toBe('New')
    expect(lifecycleDisposers.get('main')).toBe(nextUnsubscribe)
    await registry.dispose()
  })
})
