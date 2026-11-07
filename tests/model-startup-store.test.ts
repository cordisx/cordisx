import { describe, expect, it, vi } from 'vitest'
import { ModelStartupStore, startupPageActionAvailable } from '../packages/cli/src/renderer/model-startup-store.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { createRuntimeModelProviders } from '../packages/cli/src/renderer/runtime-model-providers.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'
import type { CordisXRuntimeMetadata } from '../packages/cli/src/renderer/runtime-shared.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

describe('shared model startup projection', () => {
  it('composes the runtime model registry with its Host startup observer and retains owner cleanup', async () => {
    const source = startupObserver()
    const binding = vi.spyOn(BrowserManagedServiceUIBridge.prototype, 'bindHostStartup').mockReturnValue(
      source.observer,
    )
    const composed = createRuntimeModelProviders(
      { profileId: 'profile', startupHostCapability: { token: 'host-token' } } as CordisXRuntimeMetadata,
      'host-one',
    )
    try {
      expect(binding).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(composed.modelProviders.snapshot().startup?.snapshot?.entries).toHaveLength(1))
      source.emit({ kind: 'snapshot', reason: 'epoch-changed', snapshot: startupSnapshot([], 'replacement') })
      expect(composed.modelProviders.snapshot().startup?.snapshot?.entries).toHaveLength(0)
    } finally {
      composed.modelProviders.dispose()
      composed.managedServiceBridge?.dispose()
      binding.mockRestore()
    }
    await Promise.resolve()
    expect(source.close).toHaveBeenCalledOnce()
  })

  it('invalidates an in-flight directory read across observer epoch replacement', async () => {
    let resolve!: (
      value: readonly { providerId: string; pluginId: string; models: readonly { id: string; label: string }[] }[],
    ) => void
    const source = startupObserver(
      startupSnapshot([startupProvider({ catalog: { state: 'known', generation: 'catalog', modelIds: ['m'] } })]),
    )
    let calls = 0
    const registry = new ModelProviderRegistry(() =>
      ++calls === 1
        ? new Promise(done => {
          resolve = done
        })
        : Promise.resolve([])
    )
    registry.connectStartup(source.observer)
    const stale = registry.refresh()
    source.emit({ kind: 'snapshot', reason: 'epoch-changed', snapshot: startupSnapshot([], 'replacement') })
    resolve([{ providerId: 'first', pluginId: 'p', models: [{ id: 'm', label: 'stale' }] }])
    await stale
    await vi.waitFor(() => expect(registry.snapshot().providers).toEqual([]))
    registry.dispose()
  })
  it('invalidates the old exact route on source notification even when the alias is reused', async () => {
    const pending = startupProvider()
    const source = startupObserver(startupSnapshot([startupProvider({
      state: 'ready',
      catalog: { state: 'known', generation: 'same-generation', modelIds: ['Alias'] },
      actions: { ...pending.actions, execute: { available: true } },
    })]))
    const provider = (id: string) => ({
      providerId: 'first',
      pluginId: 'p',
      models: [{ id, label: 'Alias', aliases: ['Alias'] }],
    })
    let complete!: (projections: ReturnType<typeof provider>[]) => void
    let notify!: () => void
    let replace = false
    const registry = new ModelProviderRegistry(async () =>
      replace
        ? await new Promise(resolve => {
          complete = resolve
        })
        : [provider('old/model')]
    )
    registry.connectStartup(source.observer)
    registry.connectSource(listener => {
      notify = listener
      return () => {}
    })
    try {
      await vi.waitFor(() => expect(registry.snapshot().providers[0]?.models[0]?.id).toBe('old/model'))
      replace = true
      notify()
      expect(registry.snapshot().providers[0]?.models).toEqual([])
      complete([provider('new/model')])
      await vi.waitFor(() => expect(registry.snapshot().providers[0]?.models[0]?.id).toBe('new/model'))
    } finally {
      registry.dispose()
    }
  })

  it('uses explicit page action availability independently from service execution', () => {
    const snapshot = {
      ...startupSnapshot(),
      pages: [{
        pluginId: 'p',
        pageId: 'login',
        actions: [
          { actionId: 'login', availability: { available: true as const } },
          { actionId: 'retry', availability: { available: false as const, reason: 'preparing' as const } },
        ],
      }],
    }
    const state = { snapshot, connection: 'connected' as const }
    expect(startupPageActionAvailable(state, '["p","login"]', 'login')).toBe(true)
    expect(startupPageActionAvailable(state, '["p","retry"]', 'retry')).toBe(false)
    expect(startupPageActionAvailable({ ...state, connection: 'disconnected' }, '["p","login"]', 'login')).toBe(false)
  })
  it('terminally fences closed bindings and accepts authoritative same-epoch gap replacement', async () => {
    const source = startupObserver(startupSnapshot(undefined, 'epoch-1', 9))
    const store = new ModelStartupStore()
    store.connect(source.observer)
    source.emit({ kind: 'snapshot', reason: 'gap', snapshot: startupSnapshot([], 'epoch-1', 1) })
    expect(store.snapshot().snapshot?.entries).toHaveLength(0)
    source.emit({ kind: 'closed', reason: 'scope-revoked', cursor: startupSnapshot().cursor })
    source.emit({ kind: 'snapshot', reason: 'initial', snapshot: startupSnapshot() })
    source.emit({ kind: 'connection', connection: { state: 'connected' } })
    await Promise.resolve()
    expect(store.snapshot().connection).toBe('closed')
    expect(store.snapshot().snapshot?.entries).toHaveLength(0)
    expect(source.close).toHaveBeenCalledOnce()
    store.dispose()
  })

  it('does not let rejected retired subscription overwrite a replacement', async () => {
    let reject!: (error: Error) => void
    const source = startupObserver()
    const store = new ModelStartupStore()
    store.connect({
      ...source.observer,
      subscribe: () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    })
    store.connect(source.observer)
    reject(new Error('retired'))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.snapshot().connection).toBe('connected')
    store.dispose()
  })
  it('keeps last known service state separate from connection and replaces epoch snapshots', async () => {
    const source = startupObserver()
    const store = new ModelStartupStore()
    store.connect(source.observer)
    source.emit({ kind: 'connection', connection: { state: 'disconnected', reason: 'timeout' } })
    expect(store.snapshot().connection).toBe('disconnected')
    expect(store.snapshot().snapshot?.entries[0]?.state).toBe('declared')
    source.emit({ kind: 'snapshot', reason: 'update', snapshot: startupSnapshot([], 'epoch-1', 0) })
    expect(store.snapshot().snapshot?.entries).toHaveLength(1)
    source.emit({ kind: 'snapshot', reason: 'epoch-changed', snapshot: startupSnapshot([], 'epoch-2', 0) })
    expect(store.snapshot().snapshot?.entries).toHaveLength(0)
    await Promise.resolve()
    store.dispose()
    expect(source.close).toHaveBeenCalledOnce()
  })

  it('rejects callbacks from an old binding and closes its subscription', async () => {
    const first = startupObserver()
    const second = startupObserver(startupSnapshot([], 'epoch-2'))
    const store = new ModelStartupStore()
    store.connect(first.observer)
    store.connect(second.observer)
    first.emit({ kind: 'snapshot', reason: 'update', snapshot: startupSnapshot() })
    expect(store.snapshot().snapshot?.cursor.epoch).toBe('epoch-2')
    await Promise.resolve()
    expect(first.close).toHaveBeenCalledOnce()
    store.dispose()
  })

  it('shows declared identities before catalogs and never invents models from ids', async () => {
    const source = startupObserver()
    const registry = new ModelProviderRegistry(async () => [])
    registry.connectStartup(source.observer)
    expect(registry.snapshot().providers[0]?.providerId).toBe('first')
    expect(registry.snapshot().providers[0]?.models).toEqual([])
    source.emit({
      kind: 'snapshot',
      reason: 'update',
      snapshot: startupSnapshot(
        [startupProvider({
          state: 'ready',
          catalog: { state: 'known', generation: 'catalog', modelIds: ['invented'] },
        })],
        'epoch-1',
        2,
      ),
    })
    expect(registry.snapshot().providers[0]?.models).toEqual([])
    registry.dispose()
  })
})
