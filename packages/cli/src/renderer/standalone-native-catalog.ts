import type { NativeProviderProjection } from './model-providers.js'

const BINDING = '__cordisxNativeCatalogRequestV1'
const RECEIVER = '__cordisxNativeCatalogReceiveV1'
const unavailable = () => new Error('NATIVE_CATALOG_UNAVAILABLE')

declare global {
  var __cordisxNativeCatalogRequestV1: ((payload: string) => void) | undefined
  var __cordisxNativeCatalogReceiveV1: ((payload: string) => void) | undefined
}

/** Read-only transport for the catalog owned by this standalone session. */
export class StandaloneNativeCatalog {
  private readonly pending = new Map<string, {
    readonly resolve: (providers: readonly NativeProviderProjection[]) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()
  private closed = false

  private constructor(private readonly binding: (payload: string) => void) {
    globalThis[RECEIVER] = this.receive
  }

  static connect(): StandaloneNativeCatalog | undefined {
    const binding = globalThis[BINDING]
    if (typeof binding !== 'function' || globalThis[RECEIVER] !== undefined) return undefined
    return new StandaloneNativeCatalog(binding)
  }

  async nativeProviders(): Promise<readonly NativeProviderProjection[]> {
    if (this.closed || globalThis[BINDING] !== this.binding || this.pending.size >= 32) throw unavailable()
    const requestId = crypto.randomUUID()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(unavailable())
      }, 30_000)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.binding(JSON.stringify({ version: 1, requestId, operation: 'read' }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(unavailable())
      }
    })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[RECEIVER] === this.receive) globalThis[RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(unavailable())
    }
    this.pending.clear()
  }

  private readonly receive = (payload: string): void => {
    let response: Record<string, unknown>
    try {
      response = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    if (!response || typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    const value = response.value !== null && typeof response.value === 'object' && !Array.isArray(response.value)
      ? response.value as Record<string, unknown>
      : undefined
    if (response.ok === true && value?.status === 'ok' && Array.isArray(value.providers)) {
      pending.resolve(value.providers as NativeProviderProjection[])
    } else pending.reject(unavailable())
  }
}
