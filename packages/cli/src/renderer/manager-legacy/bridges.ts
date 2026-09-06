import { type MarketplaceFetcher } from '.././marketplace.js'

export interface MarketplaceBridgePayload {
  readonly requestId: string
  readonly ok: boolean
  readonly status?: number
  readonly text?: string
  readonly error?: string
}

export interface MarketplaceBridgeWindow extends Window {
  __cordisxMarketplaceRequestV1?: (payload: string) => void
  __cordisxMarketplaceReceiveV1?: (payload: string) => void
}

export interface MarketplaceFetcherHandle {
  readonly fetcher?: MarketplaceFetcher
  dispose(): void
}

export interface PublisherGrantBridgeWindow extends Window {
  __cordisxPublisherGrantRequestV1?: (payload: string) => void
  __cordisxPublisherGrantReceiveV1?: (payload: string) => void
}
export interface PublisherGrantClient {
  request(operation: 'challenge' | 'import' | 'status', value?: unknown): Promise<unknown>
  dispose(): void
}
export function createPublisherGrantClient(view: Window | null): PublisherGrantClient {
  if (view === null || typeof (view as PublisherGrantBridgeWindow).__cordisxPublisherGrantRequestV1 !== 'function') {
    return {
      async request() {
        throw new Error('PublisherGrant launcher bridge is unavailable')
      },
      dispose() {},
    }
  }
  const bridge = view as PublisherGrantBridgeWindow
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>()
  const receiver = (payloadText: string): void => {
    try {
      const payload = JSON.parse(payloadText) as { requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown }
      if (typeof payload.requestId !== 'string') return
      const request = pending.get(payload.requestId)
      if (request === undefined) return
      view.clearTimeout(request.timer)
      pending.delete(payload.requestId)
      if (payload.ok === true) request.resolve(payload.value)
      else {request.reject(
          new Error(typeof payload.error === 'string' ? payload.error : 'PublisherGrant request failed'),
        )}
    } catch { /* keep pending request timeout authoritative */ }
  }
  bridge.__cordisxPublisherGrantReceiveV1 = receiver
  let sequence = 0
  return {
    async request(operation, value) {
      return await new Promise((resolve, reject) => {
        const requestId = `grant-${Date.now().toString(36)}-${(++sequence).toString(36)}`
        const timer = view.setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('PublisherGrant launcher bridge timed out'))
        }, 12_000)
        pending.set(requestId, { resolve, reject, timer })
        try {
          bridge.__cordisxPublisherGrantRequestV1?.(
            JSON.stringify({
              version: 1,
              requestId,
              operation,
              ...(operation === 'import' ? { statement: value } : operation === 'status' ? { target: value } : {}),
            }),
          )
        } catch (error) {
          view.clearTimeout(timer)
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    dispose() {
      if (bridge.__cordisxPublisherGrantReceiveV1 === receiver) delete bridge.__cordisxPublisherGrantReceiveV1
      for (const request of pending.values()) {
        view.clearTimeout(request.timer)
        request.reject(new Error('CordisX manager disposed'))
      }
      pending.clear()
    },
  }
}

export let marketplaceRequestSequence = 0

export function createMarketplaceFetcher(view: Window | null): MarketplaceFetcherHandle {
  if (view === null) return { dispose: () => {} }
  const bridge = view as MarketplaceBridgeWindow
  if (typeof bridge.__cordisxMarketplaceRequestV1 !== 'function') {
    return {
      ...(typeof view.fetch === 'function'
        ? { fetcher: (url: string, init: RequestInit) => view.fetch(url, init) }
        : {}),
      dispose: () => {},
    }
  }

  const pending = new Map<string, {
    readonly resolve: (response: { readonly ok: boolean; readonly status: number; text(): Promise<string> }) => void
    readonly reject: (error: Error) => void
    readonly cleanup: () => void
  }>()
  const receiver = (payloadText: string): void => {
    try {
      const payload = JSON.parse(payloadText) as MarketplaceBridgePayload
      const request = pending.get(payload.requestId)
      if (request === undefined) return
      request.cleanup()
      if (typeof payload.status === 'number' && typeof payload.text === 'string') {
        request.resolve({ ok: payload.ok, status: payload.status, text: async () => payload.text ?? '' })
      } else {
        request.reject(new Error(payload.error ?? 'marketplace launcher bridge failed'))
      }
    } catch {
      // Ignore malformed host messages; each pending request still has a timeout.
    }
  }
  bridge.__cordisxMarketplaceReceiveV1 = receiver

  const fetcher: MarketplaceFetcher = async (url, init) =>
    await new Promise((resolve, reject) => {
      const requestId = `${Date.now().toString(36)}-${(++marketplaceRequestSequence).toString(36)}`
      const timeout = view.setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('marketplace launcher bridge timed out'))
      }, 12_000)
      const signal = init.signal
      const abort = (): void => {
        view.clearTimeout(timeout)
        pending.delete(requestId)
        reject(new Error('marketplace launcher bridge aborted'))
      }
      const cleanup = (): void => {
        view.clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        pending.delete(requestId)
      }
      pending.set(requestId, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted === true) {
        abort()
        return
      }
      try {
        bridge.__cordisxMarketplaceRequestV1?.(JSON.stringify({ requestId, url }))
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  return {
    fetcher,
    dispose: () => {
      if (bridge.__cordisxMarketplaceReceiveV1 === receiver) delete bridge.__cordisxMarketplaceReceiveV1
      for (const request of pending.values()) {
        request.cleanup()
        request.reject(new Error('CordisX manager disposed'))
      }
      pending.clear()
    },
  }
}
