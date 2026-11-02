import { describe, expect, it } from 'vitest'
import { ModelStartupStore } from '../packages/cli/src/renderer/model-startup-store.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

describe('shared model startup projection', () => {
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
