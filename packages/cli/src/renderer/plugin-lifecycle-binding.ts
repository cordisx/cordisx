import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleRequestV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'

const BINDING = '__cordisxPluginLifecycleRequestV1'
const RECEIVER = '__cordisxPluginLifecycleReceiveV1'

declare global {
  interface Window {
    __cordisxPluginLifecycleRequestV1?: (payload: string) => void
    __cordisxPluginLifecycleReceiveV1?: (payload: string) => void
  }
}

export class BrowserPluginLifecycleBridge {
  private readonly pending = new Map<string, {
    readonly resolve: (value: CordisXPluginLifecycleResultV1) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()
  private disposed = false

  constructor(
    private readonly token: string,
    private readonly profileId: string,
    private readonly generation: string,
  ) {
    window[RECEIVER] = payload => this.receive(payload)
  }

  request(expectedRevision: number, operation: CordisXPluginLifecycleOperationV1): Promise<CordisXPluginLifecycleResultV1> {
    if (this.disposed) return Promise.reject(new Error('plugin lifecycle bridge is disposed'))
    const binding = window[BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const request: CordisXPluginLifecycleRequestV1 = {
      $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId,
      profileId: this.profileId,
      expectedRevision,
      runtimeGeneration: this.generation,
      operation,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('plugin lifecycle request timed out'))
      }, 60_000)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        binding(JSON.stringify({ token: this.token, request }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (window[RECEIVER] !== undefined) delete window[RECEIVER]
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('plugin lifecycle bridge is disposed'))
    }
    this.pending.clear()
  }

  private receive(payload: string): void {
    let response: { readonly requestId?: unknown; readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
    try { response = JSON.parse(payload) as typeof response } catch { return }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value as CordisXPluginLifecycleResultV1)
    else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'plugin lifecycle request failed'))
  }
}
