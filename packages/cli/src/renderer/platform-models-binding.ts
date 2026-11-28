import type { CordisXModelPage, CordisXModelsListInput, CordisXPlatformResult } from '../contracts.js'
import type { CordisXPlatformAdapterStatus } from '../contracts.js'
import { UnavailableCodexHostAdapter } from '../adapters/codex-agent.js'

declare global {
  var __cordisxPlatformModelsRequestV1: ((payload: string) => void) | undefined
  var __cordisxPlatformModelsReceiveV1: ((payload: string) => void) | undefined
}

/** Plugin tokens stay inside Host-owned bindings; the service checks each invocation. */
export class BrowserPlatformModelsBridge {
  private readonly pending = new Map<string, { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private constructor(private readonly binding: (payload: string) => void) {
    globalThis.__cordisxPlatformModelsReceiveV1 = this.receive
  }

  static connect(): BrowserPlatformModelsBridge | undefined {
    const binding = globalThis.__cordisxPlatformModelsRequestV1
    return typeof binding === 'function' && globalThis.__cordisxPlatformModelsReceiveV1 === undefined
      ? new BrowserPlatformModelsBridge(binding)
      : undefined
  }

  async list(
    token: string,
    authorizationRequestId: string,
    input: CordisXModelsListInput,
  ): Promise<CordisXPlatformResult<CordisXModelPage>> {
    const unavailable = {
      ok: false as const,
      error: { code: 'adapter-unavailable' as const, message: 'Service model catalog unavailable' },
    }
    if (this.closed || this.pending.size >= 64) return unavailable
    const requestId = globalThis.crypto.randomUUID()
    if (this.pending.has(requestId)) return unavailable
    const result = await new Promise<unknown>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(undefined)
      }, 15_000)
      this.pending.set(requestId, { resolve, timer })
      try {
        this.binding(JSON.stringify({
          version: 1,
          requestId,
          token,
          authorizationRequestId,
          ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
        }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(undefined)
      }
    })
    if (!result || typeof result !== 'object' || !('ok' in result)) return unavailable
    return result as CordisXPlatformResult<CordisXModelPage>
  }

  private readonly receive = (payload: string): void => {
    try {
      const response = JSON.parse(payload) as { requestId?: unknown; ok?: unknown; value?: unknown }
      if (typeof response.requestId !== 'string') return
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      clearTimeout(pending.timer)
      pending.resolve(response.ok === true ? response.value : undefined)
    } catch { /* malformed responses cannot grant access */ }
  }

  dispose(): void {
    this.closed = true
    if (globalThis.__cordisxPlatformModelsReceiveV1 === this.receive) {
      globalThis.__cordisxPlatformModelsReceiveV1 = undefined
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(undefined)
    }
    this.pending.clear()
  }
}

class StandaloneModelStatusAdapter extends UnavailableCodexHostAdapter {
  override status(): CordisXPlatformAdapterStatus {
    return {
      hostId: 'cordisx-service',
      hostName: 'CordisX Service',
      mode: 'read-only',
      supportedCapabilities: ['models.read'],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }
}

export function createStandaloneModelBridge(hostKind: string | undefined, hasBindings: boolean) {
  return hostKind === 'standalone' && hasBindings ? BrowserPlatformModelsBridge.connect() : undefined
}

export function standaloneModelFallback(
  bridge: BrowserPlatformModelsBridge | undefined,
  fallback: UnavailableCodexHostAdapter,
) {
  return bridge ? new StandaloneModelStatusAdapter() : fallback
}
