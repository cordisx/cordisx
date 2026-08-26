import { useSyncExternalStore } from 'react'
import useSWR from 'swr'
import { BrowserMarketplaceModel, type MarketplaceFetcher, type MarketplaceModel, type MarketplaceSnapshot, type MarketplaceStorage } from '../../marketplace.js'

interface MarketplaceBridgeWindow extends Window {
  __cordisxMarketplaceRequestV1?: (payload: string) => void
  __cordisxMarketplaceReceiveV1?: (payload: string) => void
}

function storage(view: Window | null): MarketplaceStorage | undefined {
  try { return view?.localStorage } catch { return undefined }
}

function bridgeFetcher(view: Window | null): { readonly fetcher?: MarketplaceFetcher; readonly dispose: () => void } {
  if (view === null) return { dispose: () => {} }
  const bridge = view as MarketplaceBridgeWindow
  if (typeof bridge.__cordisxMarketplaceRequestV1 !== 'function') {
    return { ...(typeof view.fetch === 'function' ? { fetcher: (url: string, init: RequestInit) => view.fetch(url, init) } : {}), dispose: () => {} }
  }
  const pending = new Map<string, { readonly resolve: (value: { readonly ok: boolean; readonly status: number; readonly text: () => Promise<string> }) => void; readonly reject: (error: Error) => void; readonly timeout: number }>()
  let sequence = 0
  const receiver = (payloadText: string) => {
    try {
      const payload = JSON.parse(payloadText) as { requestId?: unknown; ok?: unknown; status?: unknown; text?: unknown; error?: unknown }
      if (typeof payload.requestId !== 'string') return
      const request = pending.get(payload.requestId)
      if (request === undefined) return
      view.clearTimeout(request.timeout); pending.delete(payload.requestId)
      if (typeof payload.status === 'number' && typeof payload.text === 'string') request.resolve({ ok: payload.ok === true, status: payload.status, text: async () => payload.text as string })
      else request.reject(new Error(typeof payload.error === 'string' ? payload.error : 'marketplace launcher bridge failed'))
    } catch { /* malformed bridge messages are ignored until timeout */ }
  }
  bridge.__cordisxMarketplaceReceiveV1 = receiver
  const fetcher: MarketplaceFetcher = async url => await new Promise((resolve, reject) => {
    const requestId = `marketplace-${Date.now().toString(36)}-${(++sequence).toString(36)}`
    const timeout = view.setTimeout(() => { pending.delete(requestId); reject(new Error('marketplace launcher bridge timed out')) }, 12_000)
    pending.set(requestId, { resolve, reject, timeout })
    try { bridge.__cordisxMarketplaceRequestV1?.(JSON.stringify({ requestId, url })) }
    catch (error) { view.clearTimeout(timeout); pending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))) }
  })
  return { fetcher, dispose: () => {
    if (bridge.__cordisxMarketplaceReceiveV1 === receiver) delete bridge.__cordisxMarketplaceReceiveV1
    for (const request of pending.values()) { view.clearTimeout(request.timeout); request.reject(new Error('CordisX Manager 已关闭')) }
    pending.clear()
  } }
}

export interface ManagerMarketplaceStore {
  readonly model: MarketplaceModel
  readonly dispose: () => void
}

export function createManagerMarketplaceStore(document: Document): ManagerMarketplaceStore {
  const transport = bridgeFetcher(document.defaultView)
  const model = new BrowserMarketplaceModel(storage(document.defaultView), transport.fetcher)
  return { model, dispose: () => { model.dispose(); transport.dispose() } }
}

export function useMarketplaceSnapshot(model: MarketplaceModel): MarketplaceSnapshot {
  const store = marketplaceReactStore(model)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useSWR(marketplaceSWRKey(model), async () => {
    await model.reload()
    return model.snapshot()
  }, {
    fallbackData: snapshot,
    keepPreviousData: true,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: 60_000,
    dedupingInterval: 5_000,
  })
  return snapshot
}

interface MarketplaceReactStore {
  readonly getSnapshot: () => MarketplaceSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

const reactStores = new WeakMap<MarketplaceModel, MarketplaceReactStore>()
const swrKeys = new WeakMap<MarketplaceModel, string>()
let swrSequence = 0

function marketplaceSWRKey(model: MarketplaceModel): string {
  const existing = swrKeys.get(model)
  if (existing !== undefined) return existing
  const key = `cordisx-marketplace-${++swrSequence}`
  swrKeys.set(model, key)
  return key
}

function marketplaceReactStore(model: MarketplaceModel): MarketplaceReactStore {
  const existing = reactStores.get(model)
  if (existing !== undefined) return existing
  let current = model.snapshot()
  const store: MarketplaceReactStore = {
    getSnapshot: () => current,
    subscribe: listener => model.subscribe(() => { current = model.snapshot(); listener() }),
  }
  reactStores.set(model, store)
  return store
}
