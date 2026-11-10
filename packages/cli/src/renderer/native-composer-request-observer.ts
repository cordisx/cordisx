import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'
import type {
  EffectiveSelection,
  PendingNativeRequest,
  SelectionPatch,
  SelectionSnapshot,
} from './native-model-provider-state.js'
import { record, string } from './native-model-provider-state.js'

interface NativeRequestOwner {
  threadId(): string | undefined
  navigationGeneration(): number
  snapshot(): SelectionSnapshot
  busy(): boolean
  setBusy(busy: boolean): void
  advanceTurn(): void
  clearTurnStatusRetry(): void
  scheduleTurnStatusRefresh(threadId: string): void
  publishPatch(patch?: SelectionPatch): void
  refreshSelection(): Promise<void>
  refreshConfiguration(): void
  receiveOwnRequest(message: Record<string, unknown> | undefined): boolean
  modelControl(): NativeModelSelectionControl | undefined
  confirmEffective(threadId: string, selection: EffectiveSelection): void
  confirmModel(provider: string | undefined, model: string | undefined): void
}

/** The native bridge request/result subscriptions share one owning transport lifetime. */
export class NativeComposerRequestObserver {
  private readonly requests = new Map<string, PendingNativeRequest>()
  private disposed = false

  constructor(
    private readonly view: Window,
    private readonly hostId: string,
    private readonly owner: NativeRequestOwner,
  ) {
    view.addEventListener('message', this.receive, true)
    view.addEventListener('codex-message-from-view', this.observeNativeRequest as EventListener, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.view.removeEventListener('message', this.receive, true)
    this.view.removeEventListener('codex-message-from-view', this.observeNativeRequest as EventListener, true)
    this.requests.clear()
  }

  retireResumes(threadId: string | undefined): void {
    // A later resume or accepted selection supersedes pending native readback for that thread.
    if (threadId === undefined) return
    for (const [id, request] of this.requests) {
      if (request.method === 'thread/resume' && request.threadId === threadId) this.requests.delete(id)
    }
  }

  private readonly observeNativeRequest = (event: CustomEvent<unknown>): void => {
    if (this.disposed) return
    const envelope = record(event.detail)
    const request = record(envelope?.request)
    if (envelope?.type !== 'mcp-request' || envelope.hostId !== this.hostId || request === undefined) return
    const requestId = string(request.id)
    const method = string(request.method)
    const params = record(request.params)
    if (requestId === undefined || params === undefined) return
    if (method === 'thread/start' || method === 'thread/resume') {
      const threadId = string(params.threadId)
      if (method === 'thread/resume') this.retireResumes(threadId)
      const provider = string(params.modelProvider)
      const model = string(params.model)
      this.requests.set(requestId, {
        method,
        navigationGeneration: this.owner.navigationGeneration(),
        ...(threadId === undefined ? {} : { threadId }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
      })
      return
    }
    if (method === 'turn/start') {
      const threadId = string(params.threadId)
      if (threadId === undefined || threadId !== this.owner.threadId()) return
      this.owner.clearTurnStatusRetry()
      this.owner.advanceTurn()
      this.owner.setBusy(true)
      this.owner.publishPatch({ threadId, model: string(params.model) ?? this.owner.snapshot().model ?? null })
      this.owner.scheduleTurnStatusRefresh(threadId)
    }
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    if (this.disposed || (event.source !== null && event.source !== this.view)) return
    const envelope = record(event.data)
    if (envelope?.hostId !== this.hostId) return
    if (envelope.type === 'mcp-response') {
      const message = record(envelope.message) ?? record(envelope.response)
      this.receiveResponse(message)
      return
    }
    if (envelope.type !== 'mcp-notification') return
    const message = record(envelope.message) ?? record(envelope.notification)
    const method = string(message?.method)
    const params = record(message?.params)
    const threadId = string(params?.threadId) ?? string(record(params?.thread)?.id)
    if (threadId === undefined || threadId !== this.owner.threadId()) return
    if (method === 'turn/started') {
      this.owner.clearTurnStatusRetry()
      this.owner.advanceTurn()
      this.owner.setBusy(true)
      this.owner.scheduleTurnStatusRefresh(threadId)
    } else if (method === 'turn/completed') {
      this.owner.advanceTurn()
      this.owner.setBusy(false)
      this.owner.clearTurnStatusRetry()
    } else if (method === 'thread/status/changed') {
      const status = string(record(params?.status)?.type)
      if (status === 'idle' || status === 'notLoaded' || status === 'systemError') {
        this.owner.advanceTurn()
        this.owner.setBusy(false)
        this.owner.clearTurnStatusRetry()
      } else if (status === 'active') {
        this.owner.clearTurnStatusRetry()
        this.owner.advanceTurn()
        this.owner.setBusy(true)
        this.owner.scheduleTurnStatusRefresh(threadId)
      } else return
    } else if (method === 'thread/settings/updated') {
      const settings = record(params?.settings)
      if (settings && Object.hasOwn(settings, 'serviceTier')) {
        const tier = settings.serviceTier
        if (tier === null || tier === 'priority' || tier === 'fast') {
          this.owner.publishPatch({ serviceTier: tier === null ? null : 'priority' })
        }
      }
      this.owner.refreshConfiguration()
      return
    } else return
    this.owner.publishPatch()
    if (!this.owner.busy()) void this.owner.refreshSelection()
  }

  private receiveResponse(message: Record<string, unknown> | undefined): void {
    const requestId = string(message?.id)
    if (requestId === undefined) return
    if (this.owner.receiveOwnRequest(message)) return
    const native = this.requests.get(requestId)
    if (native === undefined) return
    this.requests.delete(requestId)
    if (message?.error !== undefined) return
    const result = record(message?.result)
    const threadId = string(record(result?.thread)?.id)
    const visibleThreadId = this.owner.threadId()
    if (
      threadId === undefined || threadId !== visibleThreadId
      || (native.method === 'thread/resume'
        && (native.threadId !== visibleThreadId || native.navigationGeneration !== this.owner.navigationGeneration()))
    ) return
    const control = this.owner.modelControl()
    this.owner.setBusy(false)
    const provider = string(result?.modelProvider) ?? native.provider
    const model = string(result?.model) ?? native.model ?? control?.model
    const reasoningEffort = control?.reasoningEffort ?? this.owner.snapshot().reasoningEffort
    this.owner.confirmEffective(threadId, {
      ...(provider === undefined ? {} : { providerId: provider }),
      ...(model === undefined ? {} : { model }),
    })
    this.owner.confirmModel(provider, model)
    this.owner.publishPatch({
      available: control !== undefined,
      threadId,
      modelProvider: provider ?? null,
      model: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      reasoningEfforts: control?.reasoningEfforts ?? null,
      error: null,
    })
  }
}
