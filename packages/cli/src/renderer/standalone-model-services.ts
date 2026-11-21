import {
  type ModelServicesClient,
  type ModelServicesReadResult,
  type ModelServicesSaveRequest,
  type ModelServicesSaveResult,
  STANDALONE_MODEL_SERVICES_MARKER,
} from '../model-service-contracts.js'

const BINDING = '__cordisxModelServicesRequestV1'
const RECEIVER = '__cordisxModelServicesReceiveV1'
const unavailable = (): ModelServicesReadResult => ({ status: 'rejected', code: 'unavailable' })
const unknown = (): ModelServicesSaveResult => ({ status: 'unknown', code: 'result-unknown' })

declare global {
  var __cordisxModelServicesRequestV1: ((payload: string) => void) | undefined
  var __cordisxModelServicesReceiveV1: ((payload: string) => void) | undefined
}

/** Browser-side transport for the owner's existing write-only model-service store. */
export class StandaloneModelServices implements ModelServicesClient {
  private readonly pending = new Map<string, {
    readonly write: boolean
    readonly resolve: (value: ModelServicesReadResult | ModelServicesSaveResult) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()
  private closed = false

  private constructor(private readonly binding: (payload: string) => void) {
    globalThis[RECEIVER] = this.receive
  }

  static connect(): StandaloneModelServices | undefined {
    const binding = globalThis[BINDING]
    if (typeof binding !== 'function' || globalThis[RECEIVER] !== undefined) return undefined
    return new StandaloneModelServices(binding)
  }

  get modelServicesAvailable(): boolean {
    return !this.closed
  }

  async modelServicesRead(): Promise<ModelServicesReadResult> {
    return await this.request('read') as ModelServicesReadResult
  }

  async modelServicesSave(request: ModelServicesSaveRequest): Promise<ModelServicesSaveResult> {
    return await this.request('save', request) as ModelServicesSaveResult
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[RECEIVER] === this.receive) globalThis[RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(pending.write ? unknown() : unavailable())
    }
    this.pending.clear()
  }

  private async request(
    operation: 'read' | 'save',
    request?: ModelServicesSaveRequest,
  ): Promise<ModelServicesReadResult | ModelServicesSaveResult> {
    if (this.closed || globalThis[BINDING] !== this.binding) return unavailable()
    const requestId = crypto.randomUUID()
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(operation === 'save' ? unknown() : unavailable())
      }, 60_000)
      this.pending.set(requestId, { write: operation === 'save', resolve, timer })
      try {
        this.binding(JSON.stringify({
          version: 1,
          token: STANDALONE_MODEL_SERVICES_MARKER,
          requestId,
          operation,
          ...(request === undefined ? {} : { request }),
        }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(unavailable())
      }
    })
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
    if (response.ok === true && value) {
      if (
        !pending.write && value.status === 'ok' && typeof value.revision === 'string' && Array.isArray(value.services)
      ) {
        pending.resolve(value as unknown as ModelServicesReadResult)
        return
      }
      if (
        pending.write && value.status === 'applied' && value.applies === 'app-restart'
        && typeof value.revision === 'string'
      ) {
        pending.resolve(value as unknown as ModelServicesSaveResult)
        return
      }
      if (!pending.write && value.status === 'rejected' && value.code === 'unavailable') {
        pending.resolve(unavailable())
        return
      }
      if (
        pending.write && value.status === 'rejected'
        && ['unavailable', 'conflict', 'invalid'].includes(String(value.code))
      ) {
        pending.resolve(value as unknown as ModelServicesSaveResult)
        return
      }
    }
    pending.resolve(pending.write ? unknown() : unavailable())
  }
}
