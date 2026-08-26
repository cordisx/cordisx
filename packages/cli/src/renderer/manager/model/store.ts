import { useSyncExternalStore } from 'react'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'

interface ReactManagerStore {
  readonly getSnapshot: () => ManagerSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

const stores = new WeakMap<ManagerModel, ReactManagerStore>()

function storeFor(model: ManagerModel): ReactManagerStore {
  const existing = stores.get(model)
  if (existing !== undefined) return existing
  let current = model.snapshot()
  const store: ReactManagerStore = {
    getSnapshot: () => current,
    subscribe: listener => model.subscribe(() => { current = model.snapshot(); listener() }),
  }
  stores.set(model, store)
  return store
}

export function useManagerSnapshot(model: ManagerModel): ManagerSnapshot {
  const store = storeFor(model)
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
