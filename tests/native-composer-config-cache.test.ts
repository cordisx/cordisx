import { describe, expect, it, vi } from 'vitest'
import {
  NativeComposerConfigCache,
  nativeComposerConfigCache,
  reconcileNativeComposerConfig,
} from '../packages/cli/src/renderer/native-composer-config-cache.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('native composer config cache', () => {
  it('coalesces concurrent cold reads but requires a fresh response for a later cold composer', async () => {
    const cache = new NativeComposerConfigCache()
    const pending = deferred<unknown>()
    const request = vi.fn(() => pending.promise)
    const first = cache.read(request)
    const second = cache.read(request)
    expect(first.config).toBe(second.config)
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve({ config: { model: 'old' } })
    await expect(first.config).resolves.toEqual({ model: 'old' })
    const fresh = deferred<unknown>()
    const read = cache.read(() => fresh.promise)
    const settled = vi.fn()
    void read.config.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    fresh.resolve({ config: { model: 'new' } })
    await expect(read.config).resolves.toEqual({ model: 'new' })
  })

  it('returns last-good defaults immediately for confirmed background reads and refreshes them once', async () => {
    const cache = new NativeComposerConfigCache()
    await cache.read(async () => ({ config: { model: 'old' } })).config
    const pending = deferred<unknown>()
    const request = vi.fn(() => pending.promise)
    const read = cache.read(request, true)
    const parallel = cache.read(request, true)
    await expect(read.config).resolves.toEqual({ model: 'old' })
    await expect(parallel.config).resolves.toEqual({ model: 'old' })
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve({ config: { model: 'new' } })
    await expect(read.refreshed).resolves.toEqual({ model: 'new' })
    const failed = cache.read(async () => {
      throw new Error('offline')
    }, true)
    await expect(failed.config).resolves.toEqual({ model: 'new' })
    await expect(failed.refreshed).resolves.toBeUndefined()
    await expect(
      cache.read(async () => {
        throw new Error('offline')
      }).config,
    ).rejects.toThrow('offline')
  })

  it('fences invalidated readback so old defaults cannot replace a newer configuration', async () => {
    const cache = new NativeComposerConfigCache()
    const pending = deferred<unknown>()
    const old = cache.read(() => pending.promise)
    cache.invalidate()
    await cache.read(async () => ({ config: { model: 'new' } })).config
    pending.resolve({ config: { model: 'old' } })
    await old.config
    const read = cache.read(async () => ({ config: { model: 'latest' } }), true)
    await expect(read.config).resolves.toEqual({ model: 'new' })
    await read.refreshed
  })

  it('scopes retained configuration to the exact native bridge and Host', () => {
    const bridge = { sendMessageFromView: vi.fn() }
    expect(nativeComposerConfigCache(bridge, 'local')).toBe(nativeComposerConfigCache(bridge, 'local'))
    expect(nativeComposerConfigCache(bridge, 'remote')).not.toBe(nativeComposerConfigCache(bridge, 'local'))
    expect(nativeComposerConfigCache({ ...bridge }, 'local')).not.toBe(nativeComposerConfigCache(bridge, 'local'))
  })

  it('only reconciles changed defaults while the original composer refresh is still current', async () => {
    const reconcile = vi.fn(async () => {})
    const baseline = { model: 'old' }
    reconcileNativeComposerConfig(Promise.resolve({ ...baseline }), baseline, () => true, reconcile)
    reconcileNativeComposerConfig(Promise.resolve({ model: 'new' }), baseline, () => false, reconcile)
    await Promise.resolve()
    expect(reconcile).not.toHaveBeenCalled()
    reconcileNativeComposerConfig(Promise.resolve({ model: 'new' }), baseline, () => true, reconcile)
    await Promise.resolve()
    expect(reconcile).toHaveBeenCalledWith({ model: 'new' })
  })
})
