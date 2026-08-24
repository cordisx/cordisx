import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from '../launcher/service-config.js'

const SERVICE_CONFIG_BINDING = '__cordisxServiceConfigRequestV1'
const SERVICE_CONFIG_RECEIVER = '__cordisxServiceConfigReceiveV1'
const REQUEST_TIMEOUT_MS = 15_000

type Binding = (payload: string) => void
interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxServiceConfigRequestV1: Binding | undefined
  // eslint-disable-next-line no-var
  var __cordisxServiceConfigReceiveV1: ((payload: string) => void) | undefined
}

function clone<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}

/** Renderer client for descriptors and full-CAS service configuration mutation. */
export class BrowserServiceConfigBridge {
  private readonly pending = new Map<string, Pending>()
  private readonly listRequests = new Map<string, Promise<readonly HostServiceConfigDescriptor[]>>()
  private closed = false

  private constructor(private readonly token: string, private readonly profileId: string, private readonly generation: string) {
    globalThis[SERVICE_CONFIG_RECEIVER] = this.receive
  }

  /**
   * The CDP injector may publish a binding after the renderer bundle has begun
   * evaluating.  Resolve the Host-owned binding per request, as the existing
   * configuration bridge does, so a legitimate late publication cannot turn
   * into a permanently empty service list.
   */
  static connect(token: string, profileId: string, generation: string): BrowserServiceConfigBridge {
    return new BrowserServiceConfigBridge(token, profileId, generation)
  }

  async list(pluginId: string): Promise<readonly HostServiceConfigDescriptor[]> {
    const active = this.listRequests.get(pluginId)
    if (active !== undefined) return clone(await active)
    const request = this.request('list', {
      pluginId,
      scope: { profileId: this.profileId, generation: this.generation },
    }) as Promise<readonly HostServiceConfigDescriptor[]>
    this.listRequests.set(pluginId, request)
    try {
      return clone(await request)
    } finally {
      if (this.listRequests.get(pluginId) === request) this.listRequests.delete(pluginId)
    }
  }

  async mutate(mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult> {
    return clone(await this.request('mutate', { mutation }) as HostServiceConfigMutationResult)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[SERVICE_CONFIG_RECEIVER] === this.receive) globalThis[SERVICE_CONFIG_RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Service configuration bridge was disposed'))
    }
    this.pending.clear()
  }

  private request(operation: 'list' | 'mutate', payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Service configuration bridge is unavailable'))
    const binding = globalThis[SERVICE_CONFIG_BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('Service configuration bridge is unavailable'))
    const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Service configuration bridge request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        binding(JSON.stringify({ version: 1, token: this.token, requestId, operation, ...payload }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private readonly receive = (payload: string): void => {
    let response: { requestId?: unknown; ok?: unknown; value?: unknown; code?: unknown; error?: unknown }
    try { response = JSON.parse(payload) as typeof response } catch { return }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else pending.reject(new Error(typeof response.code === 'string' ? response.code : 'service-config-unavailable'))
  }
}
