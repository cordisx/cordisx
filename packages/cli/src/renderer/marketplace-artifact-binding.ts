import type { CordisXPluginLifecycleResultV1 } from '../plugin-lifecycle-contracts.js'
import type { MarketplaceArtifact } from './marketplace-types.js'

export interface MarketplaceArtifactInspectionRequest {
  readonly pluginId: string
  readonly version: string
  readonly canonicalSource: string
  readonly artifact: MarketplaceArtifact
}

export interface MarketplaceArtifactPreview {
  readonly readme?: string
}

interface MarketplaceArtifactWindow extends Window {
  __cordisxMarketplaceArtifactRequestV1?: (payload: string) => void
  __cordisxMarketplaceArtifactReceiveV1?: (payload: string) => void
}

const pending = new Map<string, {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}>()
let sequence = 0

function receive(payloadText: string): void {
  try {
    const payload = JSON.parse(payloadText) as {
      readonly requestId?: unknown
      readonly ok?: unknown
      readonly value?: unknown
      readonly error?: unknown
    }
    if (typeof payload.requestId !== 'string') return
    const request = pending.get(payload.requestId)
    if (request === undefined) return
    pending.delete(payload.requestId)
    if (payload.ok === true && payload.value !== undefined) {
      request.resolve(payload.value)
    } else {
      request.reject(
        new Error(typeof payload.error === 'string' ? payload.error : 'Marketplace artifact request failed'),
      )
    }
  } catch {
    // A malformed Host response is ignored; the request remains cancellable.
  }
}

export function marketplaceArtifactBridgeAvailable(view: Window = globalThis as unknown as Window): boolean {
  return typeof (view as MarketplaceArtifactWindow).__cordisxMarketplaceArtifactRequestV1 === 'function'
}

async function requestMarketplaceArtifact<T>(
  kind: 'inspect' | 'preview',
  request: MarketplaceArtifactInspectionRequest,
  signal: AbortSignal,
  view: Window = globalThis as unknown as Window,
): Promise<T> {
  const bridge = view as MarketplaceArtifactWindow
  if (typeof bridge.__cordisxMarketplaceArtifactRequestV1 !== 'function') {
    throw new Error('Marketplace artifact installation is unavailable')
  }
  const requestBinding = bridge.__cordisxMarketplaceArtifactRequestV1
  bridge.__cordisxMarketplaceArtifactReceiveV1 = receive
  const requestId = `marketplace-artifact-${Date.now().toString(36)}-${(++sequence).toString(36)}`
  return await new Promise<T>((resolve, reject) => {
    const timeout = view.setTimeout(() => {
      if (!pending.delete(requestId)) return
      bridge.__cordisxMarketplaceArtifactRequestV1?.(JSON.stringify({
        kind: 'cancel',
        requestId: `timeout-${requestId}`,
        targetRequestId: requestId,
      }))
      signal.removeEventListener('abort', abort)
      reject(new Error('Marketplace artifact request timed out'))
    }, 40_000)
    const abort = () => {
      if (!pending.delete(requestId)) return
      view.clearTimeout(timeout)
      bridge.__cordisxMarketplaceArtifactRequestV1?.(JSON.stringify({
        kind: 'cancel',
        requestId: `cancel-${requestId}`,
        targetRequestId: requestId,
      }))
      reject(new DOMException('Marketplace installation was cancelled', 'AbortError'))
    }
    pending.set(requestId, {
      resolve: value => {
        view.clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        resolve(value as T)
      },
      reject: error => {
        view.clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    try {
      requestBinding(JSON.stringify({
        kind,
        requestId,
        request,
      }))
    } catch (error) {
      view.clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      pending.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function inspectMarketplaceArtifact(
  request: MarketplaceArtifactInspectionRequest,
  signal: AbortSignal,
  view: Window = globalThis as unknown as Window,
): Promise<CordisXPluginLifecycleResultV1> {
  return await requestMarketplaceArtifact('inspect', request, signal, view)
}

export async function previewMarketplaceArtifact(
  request: MarketplaceArtifactInspectionRequest,
  signal: AbortSignal,
  view: Window = globalThis as unknown as Window,
): Promise<MarketplaceArtifactPreview> {
  return await requestMarketplaceArtifact('preview', request, signal, view)
}
