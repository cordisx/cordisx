import type {
  CordisXAgentHistoryPage,
  CordisXAgentHistoryQuery,
  CordisXAgentHistoryStatus,
  CordisXAgentHistoryTailQuery,
} from '../agent-contracts.js'
import type { CordisXPlatformResult } from '../platform-contracts.js'

const AGENT_HISTORY_BINDING = '__cordisxAgentHistoryRequestV1'
const AGENT_HISTORY_RECEIVER = '__cordisxAgentHistoryReceiveV1'
const REQUEST_TIMEOUT_MS = 45_000

interface TransportResponse {
  readonly requestId?: unknown
  readonly ok?: unknown
  readonly value?: unknown
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type HistoryBinding = (payload: string) => void

declare global {
  // eslint-disable-next-line no-var
  var __cordisxAgentHistoryRequestV1: HistoryBinding | undefined
  // eslint-disable-next-line no-var
  var __cordisxAgentHistoryReceiveV1: ((payload: string) => void) | undefined
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

export interface AgentHistoryBindingCaller {
  readonly ownerKey: string
  readonly generation: string
}

export interface CordisXAgentHistoryAdapter {
  status(): CordisXAgentHistoryStatus
  query(
    input: CordisXAgentHistoryQuery,
    caller: AgentHistoryBindingCaller,
  ): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>>
  tail(
    input: CordisXAgentHistoryTailQuery,
    caller: AgentHistoryBindingCaller,
  ): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>>
  dispose(): void
}

/** Token-bound renderer client for the narrow Agent history RPC. */
export class BindingAgentHistoryAdapter implements CordisXAgentHistoryAdapter {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  private constructor(
    private readonly token: string,
    private readonly binding: HistoryBinding,
    private readonly adapterStatus: CordisXAgentHistoryStatus,
  ) {
    globalThis[AGENT_HISTORY_RECEIVER] = this.receive
  }

  static async connect(token: string): Promise<BindingAgentHistoryAdapter> {
    const binding = globalThis[AGENT_HISTORY_BINDING]
    if (typeof binding !== 'function') throw new Error('Agent history bridge is unavailable')
    const fallback: CordisXAgentHistoryStatus = {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop history',
      mode: 'unavailable',
      adapterId: 'codex-history',
      adapterVersion: 'rollout-jsonl-v1',
      profileId: 'profile-unavailable',
      defaultPayloadPolicy: 'referenced',
      diagnostics: [{ code: 'history-unavailable', severity: 'warning', count: 1 }],
      filesystemExposed: false,
      rawBridgeExposed: false,
    }
    const temporary = new BindingAgentHistoryAdapter(token, binding, fallback)
    try {
      const status = await temporary.request<CordisXAgentHistoryStatus>('status', {}, undefined)
      return new BindingAgentHistoryAdapter(token, binding, clone(status))
    } finally {
      temporary.dispose()
    }
  }

  status(): CordisXAgentHistoryStatus {
    return clone(this.adapterStatus)
  }

  async query(
    input: CordisXAgentHistoryQuery,
    caller: AgentHistoryBindingCaller,
  ): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    return await this.result('query', input, caller)
  }

  async tail(
    input: CordisXAgentHistoryTailQuery,
    caller: AgentHistoryBindingCaller,
  ): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    return await this.result('tail', input, caller)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[AGENT_HISTORY_RECEIVER] === this.receive) globalThis[AGENT_HISTORY_RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Agent history bridge was disposed'))
    }
    this.pending.clear()
  }

  private async result(
    operation: 'query' | 'tail',
    input: CordisXAgentHistoryQuery | CordisXAgentHistoryTailQuery,
    caller: AgentHistoryBindingCaller,
  ): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    try {
      return clone(await this.request<CordisXPlatformResult<CordisXAgentHistoryPage>>(operation, input, caller))
    } catch {
      return {
        ok: false,
        error: { code: 'adapter-unavailable', message: 'Agent history bridge request failed', retryable: true },
      }
    }
  }

  private request<Value>(
    operation: 'status' | 'query' | 'tail',
    input: unknown,
    caller: AgentHistoryBindingCaller | undefined,
  ): Promise<Value> {
    if (this.closed) return Promise.reject(new Error('Agent history bridge is closed'))
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Agent history bridge request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve: value => resolve(value as Value), reject, timer })
      try {
        this.binding(
          JSON.stringify({
            requestId,
            token: this.token,
            operation,
            ...(caller === undefined ? {} : { caller }),
            input,
          }),
        )
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private readonly receive = (payload: string): void => {
    let response: TransportResponse
    try {
      response = JSON.parse(payload) as TransportResponse
    } catch {
      return
    }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else pending.reject(new Error('Agent history bridge rejected the request'))
  }
}

export class UnavailableAgentHistoryAdapter implements CordisXAgentHistoryAdapter {
  status(): CordisXAgentHistoryStatus {
    return {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop history',
      mode: 'unavailable',
      adapterId: 'codex-history',
      adapterVersion: 'rollout-jsonl-v1',
      profileId: 'profile-unavailable',
      defaultPayloadPolicy: 'referenced',
      diagnostics: [{ code: 'history-unavailable', severity: 'warning', count: 1 }],
      filesystemExposed: false,
      rawBridgeExposed: false,
    }
  }

  async query(): Promise<CordisXPlatformResult<never>> {
    return {
      ok: false,
      error: { code: 'adapter-unavailable', message: 'Agent history is unavailable', retryable: true },
    }
  }

  async tail(): Promise<CordisXPlatformResult<never>> {
    return {
      ok: false,
      error: { code: 'adapter-unavailable', message: 'Agent history is unavailable', retryable: true },
    }
  }

  dispose(): void {}
}
