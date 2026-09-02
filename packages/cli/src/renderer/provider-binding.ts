import type {
  CordisXModelPage,
  CordisXModelsListInput,
  CordisXPlatformAdapterStatus,
  CordisXPlatformResult,
  CordisXSessionPage,
  CordisXSessionProjection,
  CordisXSessionSummary,
  CordisXTaskControlInput,
  CordisXTaskControlOutcome,
  CordisXTaskCreateInput,
  CordisXTaskReadInput,
  CordisXTasksListInput,
  CordisXTurnControlInput,
  CordisXTurnControlOutcome,
  CordisXTurnStart,
  CordisXTurnSubmitInput,
} from '../contracts.js'
import type { CordisXPlatformAdapter } from './platform.js'
import type { CordisXExternalProviderAvailabilityStatus } from '../capability-availability-contracts.js'

export interface CordisXAgentLoopLifecycleEvent {
  readonly sequence: number
  readonly session: CordisXTaskReadInput['session']
  readonly turnId: string
  readonly type: 'turn.started' | 'turn.completed' | 'turn.failed' | 'turn.cancelled' | 'approval.required' | 'approval.resolved'
  readonly output?: readonly { readonly type: 'text'; readonly text: string }[]
  readonly failure?: { readonly code: string; readonly retryable: boolean }
  readonly approval?: { readonly approvalId: string; readonly kind: 'command' | 'file-change' | 'external-action' | 'other'; readonly state: 'pending' | 'resolved'; readonly outcome?: 'approved' | 'denied' | 'expired' | 'cancelled' }
  readonly cancellation?: { readonly operationId: string }
}

export interface CordisXAgentLoopLifecycleRange {
  readonly afterSequence: number
  readonly nextAfterSequence: number
  readonly events: readonly CordisXAgentLoopLifecycleEvent[]
}

export interface CordisXAgentLoopV4Scope {
  readonly profileId: string
  readonly compositionGeneration: string
  readonly ownerKey: string
}

const PROVIDER_BINDING = '__cordisxProviderRequestV1'
const PROVIDER_RECEIVER = '__cordisxProviderReceiveV1'
const REQUEST_TIMEOUT_MS = 35_000

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

type ProviderBinding = (payload: string) => void

declare global {
  // eslint-disable-next-line no-var
  var __cordisxProviderRequestV1: ProviderBinding | undefined
  // eslint-disable-next-line no-var
  var __cordisxProviderReceiveV1: ((payload: string) => void) | undefined
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

function unavailable(message: string): CordisXPlatformResult<never> {
  return { ok: false, error: { code: 'adapter-unavailable', message, retryable: true } }
}

/** Token-bound renderer client for the narrow public Platform RPC surface. */
export class BindingPlatformAdapter implements CordisXPlatformAdapter {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  private constructor(
    private readonly token: string,
    private readonly binding: ProviderBinding,
    private readonly adapterStatus: CordisXPlatformAdapterStatus,
    private readonly externalProviders: readonly CordisXExternalProviderAvailabilityStatus[],
  ) {
    globalThis[PROVIDER_RECEIVER] = this.receive
  }

  static async connect(token: string): Promise<BindingPlatformAdapter> {
    const binding = globalThis[PROVIDER_BINDING]
    if (typeof binding !== 'function') throw new Error('External provider bridge is unavailable')
    const temporary = new BindingPlatformAdapter(token, binding, {
      hostId: 'cordisx-provider-fleet',
      hostName: 'CordisX External Provider Fleet',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [{ code: 'adapter-unavailable', message: 'External provider status has not been read' }],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }, [])
    try {
      const status = await temporary.request<CordisXPlatformAdapterStatus>('status', {})
      const providers = await temporary.request<readonly CordisXExternalProviderAvailabilityStatus[]>('availability', {})
        .then(value => Array.isArray(value) ? value : [])
        .catch(() => [])
      return new BindingPlatformAdapter(token, binding, clone(status), clone(providers))
    } finally {
      temporary.dispose()
    }
  }

  status(): CordisXPlatformAdapterStatus {
    return clone(this.adapterStatus)
  }

  capabilityProviderStatuses(): readonly CordisXExternalProviderAvailabilityStatus[] {
    return clone(this.externalProviders)
  }

  async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>> {
    return await this.result('models.list', input)
  }

  async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    return await this.result('tasks.list', input)
  }

  async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    return await this.result('tasks.read', input)
  }

  async createTask(input: Omit<CordisXTaskCreateInput, 'initialMessage'>): Promise<CordisXPlatformResult<CordisXSessionSummary>> {
    return await this.result('tasks.create', input)
  }

  async controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    return await this.result('tasks.control', input)
  }

  async submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    return await this.result('turns.submit', input)
  }

  async controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    return await this.result('turns.control', input)
  }

  async createAgentLoopTask(input: {
    readonly model: CordisXTaskCreateInput['model']
    readonly cwd: string
    readonly developerInstructions?: string
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh'
  }): Promise<CordisXPlatformResult<CordisXSessionSummary>> {
    return await this.result('agent-loop.create', input)
  }

  async readAgentLoopLifecycle(
    session: CordisXTaskReadInput['session'],
    afterSequence: number,
  ): Promise<CordisXAgentLoopLifecycleRange> {
    return await this.request<CordisXAgentLoopLifecycleRange>('agent-loop.lifecycle.read', { session, afterSequence })
  }

  async createAgentLoopV4(input: {
    readonly scope: CordisXAgentLoopV4Scope
    readonly command: unknown
    readonly operationId: string
    readonly definition: { readonly agentId: string; readonly revision: string }
    readonly model: CordisXTaskCreateInput['model']
    readonly cwd: string
    readonly developerInstructions?: string
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh'
  }): Promise<unknown> { return await this.request('agent-loop.v4.create', input) }

  async bindAgentLoopV4(input: {
    readonly scope: CordisXAgentLoopV4Scope
    readonly command: unknown
    readonly operationId: string
    readonly task: string
    readonly definition: { readonly agentId: string; readonly revision: string }
  }): Promise<unknown> { return await this.request('agent-loop.v4.bind', input) }

  async sendAgentLoopV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: { readonly agentId: string; readonly revision: string }; readonly message: string }): Promise<unknown> {
    return await this.request('agent-loop.v4.send', input)
  }

  async decideAgentLoopApprovalV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: { readonly agentId: string; readonly revision: string }; readonly turn: string; readonly approvalId: string; readonly decision: 'approved' | 'denied' | 'cancelled' }): Promise<unknown> {
    return await this.request('agent-loop.v4.approval.decide', input)
  }

  async requestAgentLoopIntroductionV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: { readonly agentId: string; readonly revision: string }; readonly participantId: string; readonly memberId: string; readonly runId: string }): Promise<unknown> {
    return await this.request('agent-loop.v4.introduction.request', input)
  }

  async cancelAgentLoopIntroductionV4(input: { readonly scope: CordisXAgentLoopV4Scope; readonly command: unknown; readonly operationId: string; readonly requestOperationId: string; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: { readonly agentId: string; readonly revision: string }; readonly participantId: string; readonly memberId: string; readonly runId: string }): Promise<unknown> {
    return await this.request('agent-loop.v4.introduction.cancel', input)
  }

  async readAgentLoopV4Lifecycle(input: { readonly scope: CordisXAgentLoopV4Scope; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: { readonly agentId: string; readonly revision: string }; readonly afterSequence: number }): Promise<unknown> {
    return await this.request('agent-loop.v4.lifecycle.read', input)
  }

  async resolveAgentLoopV4Session(input: { readonly scope: CordisXAgentLoopV4Scope; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: { readonly agentId: string; readonly revision: string } }): Promise<unknown> {
    return await this.request('agent-loop.v4.session.resolve', input)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[PROVIDER_RECEIVER] === this.receive) globalThis[PROVIDER_RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('External provider bridge was disposed'))
    }
    this.pending.clear()
  }

  private async result<Value>(operation: string, input: unknown): Promise<CordisXPlatformResult<Value>> {
    try {
      return clone(await this.request<CordisXPlatformResult<Value>>(operation, input))
    } catch {
      return unavailable('External provider bridge request failed')
    }
  }

  private request<Value>(operation: string, input: unknown): Promise<Value> {
    if (this.closed) return Promise.reject(new Error('External provider bridge is closed'))
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('External provider bridge request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve: value => resolve(value as Value), reject, timer })
      try {
        this.binding(JSON.stringify({ requestId, token: this.token, operation, input }))
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
    else pending.reject(new Error('External provider bridge rejected the request'))
  }
}
