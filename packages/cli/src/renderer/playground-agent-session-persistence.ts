import type {
  CordisXPersistedSession,
  CordisXSessionEventPersistence,
} from './agent-session-runtime.js'

const REQUEST = '__cordisxPlaygroundAgentSessionRequestV1'
const RECEIVE = '__cordisxPlaygroundAgentSessionReceiveV1'
const REQUEST_TIMEOUT_MS = 5_000
const MAX_PENDING_REQUESTS = 64

declare global {
  var __cordisxPlaygroundAgentSessionRequestV1: ((payload: string) => void) | undefined
  var __cordisxPlaygroundAgentSessionReceiveV1: ((payload: string) => void) | undefined
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type StoreResult =
  | { readonly status: 'loaded'; readonly sessions: readonly CordisXPersistedSession[] }
  | { readonly status: 'accepted'; readonly nextSeq: number; readonly disposition: 'committed' | 'replayed' }
  | { readonly status: 'unavailable'; readonly code: string }

function clone<Value>(value: Value): Value { return structuredClone(value) }

/** Host-private loopback transport; never installed outside an explicit Playground. */
export class BrowserPlaygroundAgentSessionPersistence implements CordisXSessionEventPersistence {
  private readonly pending = new Map<string, PendingRequest>()
  private requestSequence = 0
  private disposed = false
  private readonly receive = (payload: string): void => {
    let response: Record<string, unknown>
    try {
      const parsed = JSON.parse(payload) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      response = parsed as Record<string, unknown>
    } catch { return }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'Playground Session store rejected request'))
  }

  static connect(token: string, runtimeGeneration: string): BrowserPlaygroundAgentSessionPersistence | undefined {
    if (typeof globalThis[REQUEST] !== 'function') return undefined
    return new BrowserPlaygroundAgentSessionPersistence(token, runtimeGeneration)
  }

  private constructor(
    private readonly token: string,
    private readonly runtimeGeneration: string,
  ) {
    globalThis[RECEIVE] = this.receive
  }

  async load(): Promise<readonly CordisXPersistedSession[]> {
    const result = await this.request({ operation: 'load' })
    if (result.status !== 'loaded') throw new Error(`Playground Session recovery failed: ${result.status === 'unavailable' ? result.code : 'invalid-response'}`)
    return clone(result.sessions)
  }

  async create(session: CordisXPersistedSession): Promise<void> {
    const result = await this.request({ operation: 'create', session: clone(session) })
    if (result.status !== 'accepted' || result.nextSeq !== session.events.length) throw new Error('Playground Session create was not committed')
  }

  async append(input: Parameters<CordisXSessionEventPersistence['append']>[0]): Promise<void> {
    const result = await this.request({ operation: 'append', ...clone(input) })
    if (result.status !== 'accepted' || result.nextSeq !== input.expectedSeq + input.events.length) {
      throw new Error(`Playground Session append failed: ${result.status === 'unavailable' ? result.code : 'invalid-response'}`)
    }
  }

  async updateSetup(input: Parameters<NonNullable<CordisXSessionEventPersistence['updateSetup']>>[0]): Promise<void> {
    const result = await this.request({ operation: 'update-setup', ...clone(input) })
    if (result.status !== 'accepted') {
      throw new Error(`Playground Session setup update failed: ${result.status === 'unavailable' ? result.code : 'invalid-response'}`)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (globalThis[RECEIVE] === this.receive) globalThis[RECEIVE] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Playground Session store is disposed'))
    }
    this.pending.clear()
  }

  private async request(operation: Record<string, unknown>): Promise<StoreResult> {
    if (this.disposed) throw new Error('Playground Session store is disposed')
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error('Playground Session store request limit reached')
    const binding = globalThis[REQUEST]
    if (typeof binding !== 'function') throw new Error('Playground Session store bridge is unavailable')
    const requestId = `agent-sessions-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`
    return await new Promise<StoreResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(requestId)
        if (current === undefined) return
        this.pending.delete(requestId)
        current.reject(new Error('Playground Session store request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve: value => resolve(value as StoreResult), reject, timer })
      try {
        binding(JSON.stringify({ version: 1, requestId, token: this.token, runtimeGeneration: this.runtimeGeneration, ...operation }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
