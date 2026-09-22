import {
  locateNativeModelProviderMountSeat,
  locateNativeModelProviderSeat,
  locateNativeModelSelectionControl,
} from './adapter/native-model-provider-seat.js'
import {
  nativeModelProviderInteractionAllowed,
  nativeModelProviderObservedAttributes,
} from './adapter/native-model-provider-interaction.js'
import type { ProviderSelectionSnapshot, ProviderSelectionTransport } from './model-provider-selector.js'
import {
  NativeProviderSelectionClient,
  type NativeProviderSelectionCommandChannel,
  type NativeProviderSelectionOwner,
  type NativeProviderSubmitConfirmation,
  type NativeSubmissionRejection,
  type NativeSubmissionScope,
} from './native-provider-selection-client.js'

type NativeHookGlobal = typeof globalThis & {
  __cordisxNativeSubmitHook?: NativeProviderSelectionClient['submitHook']
  __cordisxNativeSubmissionAuthority?: { snapshot: () => { scope: NativeSubmissionScope; idle: boolean } }
  __cordisxNativeServiceTierOverride?: 'priority' | 'default'
}

interface ElectronBridge {
  readonly sendMessageFromView?: (value: unknown) => Promise<unknown> | unknown
}

interface PendingNativeRequest {
  readonly method: 'thread/start' | 'thread/resume'
  readonly threadId?: string
  readonly provider?: string
  readonly model?: string
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface EffectiveSelection {
  readonly providerId?: string
  readonly model?: string
}

interface SelectionSnapshot extends ProviderSelectionSnapshot {
  readonly error?: string
}

interface SelectionPatch {
  readonly available?: boolean
  readonly threadId?: string | null
  readonly modelProvider?: string | null
  readonly model?: string | null
  readonly reasoningEffort?: string | null
  readonly reasoningEfforts?: readonly string[] | null
  readonly serviceTier?: 'priority' | null
  readonly error?: string | null
  readonly submissionError?: NativeSubmissionRejection | null
  readonly draftPreference?: ProviderSelectionSnapshot['draftPreference'] | null
}

const clone = <Value>(value: Value): Value => structuredClone(value)
const record = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)
const string = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 && value.length <= 1_000_000 ? value : undefined
)
const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'Native model provider selection failed'
const CONTROL_DISCOVERY_RETRY_MS = 50
const CONTROL_DISCOVERY_ATTEMPTS = 20
const TURN_STATUS_RETRY_MS = 500

function currentThreadId(document: Document): string | undefined {
  const values = new Set(
    [...document.querySelectorAll('[data-above-composer-conversation-id]')]
      .filter(element => element.closest('[data-codex-composer-root][data-composer-placement]') !== null)
      .map(element => element.getAttribute('data-above-composer-conversation-id'))
      .filter((value): value is string => value !== null && value !== ''),
  )
  return values.size === 1 ? [...values][0] : undefined
}

function threadBusy(thread: Record<string, unknown>): boolean | undefined {
  const status = string(record(thread.status)?.type)
  if (status === 'idle' || status === 'notLoaded' || status === 'systemError') return false
  if (status === 'active') return true
  return undefined
}

/** Host-private selection control using the launcher's verified native capability. */
export class CodexDesktopNativeModelProviderTransport implements ProviderSelectionTransport {
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly nativeRequests = new Map<string, PendingNativeRequest>()
  private readonly effectiveByThread = new Map<string, EffectiveSelection>()
  private readonly providerNames = new Map<string, string>()
  private observer?: MutationObserver
  private controlDiscoveryRetry?: ReturnType<typeof setTimeout>
  private turnStatusRetry?: ReturnType<typeof setTimeout>
  private disposed = false
  private selecting = false
  private turnBusy = false
  private refreshGeneration = 0
  private navigationGeneration = 0
  private selectionGeneration = 0
  private turnGeneration = 0
  private visibleThreadId: string | undefined
  private visibleTrigger: HTMLElement | undefined
  private suspendedAvailability: boolean | undefined
  private nativeModelUpdate: { readonly key: string; readonly completion: Promise<void> } | undefined
  private readonly selectionClient: NativeProviderSelectionClient
  private submissionError: NativeSubmissionRejection | undefined
  private state: SelectionSnapshot = Object.freeze({ available: false, busy: false })
  private readonly submissionAuthority = {
    snapshot: () => ({
      scope: this.currentSubmissionScope(),
      idle: this.state.available && !this.turnBusy && !this.selectionClient.synchronizationActive(),
    }),
  }

  private constructor(
    private readonly bridge: Required<ElectronBridge>,
    private readonly hostId: string,
    private readonly document: Document,
    private readonly nativeManagedModelRoutingAvailable: boolean,
    private readonly rendererOwner: NativeProviderSelectionOwner,
    commandChannel: NativeProviderSelectionCommandChannel,
  ) {
    this.visibleThreadId = currentThreadId(document)
    this.selectionClient = new NativeProviderSelectionClient(
      commandChannel,
      () => ({
        scope: this.currentSubmissionScope(),
        idle: this.state.available && !this.turnBusy,
        ...(this.state.modelProvider === undefined || this.state.model === undefined
          ? {}
          : {
            effective: {
              providerId: this.state.modelProvider,
              model: this.visibleTrigger?.isConnected
                ? locateNativeModelSelectionControl(this.visibleTrigger)?.model ?? this.state.model
                : this.state.model,
            },
          }),
      }),
      reason => this.publishPatch({ submissionError: reason }),
      async selection => {
        const navigation = this.navigationGeneration
        const threadId = this.visibleThreadId
        if (!threadId) throw new Error('Native existing thread unavailable')
        this.refreshGeneration++
        this.clearControlDiscoveryRetry()
        const trigger = this.visibleTrigger
        const control = trigger?.isConnected ? locateNativeModelSelectionControl(trigger) : undefined
        if (!control) throw new Error('Native model control unavailable')
        const effort = this.state.reasoningEffort ?? control.reasoningEffort
        const key = JSON.stringify([navigation, threadId, selection.model, effort])
        if (this.nativeModelUpdate?.key === key) await this.nativeModelUpdate.completion
        else if (control.model !== selection.model) {
          const update = { key, completion: control.selectModel(selection.model, effort) }
          this.nativeModelUpdate = update
          try {
            await update.completion
          } finally {
            if (this.nativeModelUpdate === update) this.nativeModelUpdate = undefined
          }
        }
        // Completion precedes React's committed control projection; never trust optimistic display alone.
        for (let attempt = 0;; attempt++) {
          this.assertCurrent(navigation, threadId)
          const liveTrigger = this.visibleTrigger
          const live = liveTrigger?.isConnected ? locateNativeModelSelectionControl(liveTrigger) : undefined
          if (live?.model === selection.model) break
          if (attempt >= 80) throw new Error('Native model selection was not acknowledged')
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        this.publishPatch({ modelProvider: selection.providerId, model: selection.model, reasoningEffort: effort })
      },
    )
    this.selectionClient.subscribe(() => {
      const projection = this.selectionClient.snapshot()
      const effective = projection.effective
      const draftPreference = this.visibleThreadId === undefined && projection.draftPreference !== undefined
        ? { ...projection.draftPreference, revision: projection.revision }
        : null
      if (effective !== undefined && this.selectionClient.confirmation() === undefined) {
        if (this.selectionClient.submissionActive()) this.refreshGeneration++
        if (this.visibleThreadId !== undefined) this.effectiveByThread.set(this.visibleThreadId, effective)
        this.publishPatch({ modelProvider: effective.providerId, model: effective.model, draftPreference })
      } else this.publishPatch({ draftPreference })
    })
    ;(globalThis as NativeHookGlobal).__cordisxNativeSubmitHook = this.selectionClient.submitHook
    ;(globalThis as NativeHookGlobal).__cordisxNativeSubmissionAuthority = this.submissionAuthority
    window.addEventListener('message', this.receive, true)
    window.addEventListener('codex-message-from-view', this.observeNativeRequest as EventListener, true)
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer(records => {
        const Element = document.defaultView?.Element
        if (
          records.some(record =>
            Element === undefined || !(record.target instanceof Element)
            || record.target.closest('[data-cordisx-model-provider-selector],.cxmp-menu,.cxmp-confirm') === null
          )
        ) {
          this.observeComposer()
        }
      })
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-above-composer-conversation-id',
          'data-selected-reasoning-effort',
          ...nativeModelProviderObservedAttributes,
        ],
      })
    }
  }

  static async connect(
    nativeManagedModelRoutingAvailable = false,
    rendererOwner?: NativeProviderSelectionOwner,
    commandChannel?: NativeProviderSelectionCommandChannel,
  ): Promise<CodexDesktopNativeModelProviderTransport | undefined> {
    if (
      !nativeManagedModelRoutingAvailable || !rendererOwner?.targetId || !rendererOwner.rendererGeneration
      || !commandChannel
    ) return undefined
    const page = globalThis as typeof globalThis & {
      readonly electronBridge?: ElectronBridge
      readonly codexWindowType?: unknown
      readonly document?: Document
      readonly location?: Location
    }
    const bridge = page.electronBridge
    if (
      page.codexWindowType !== 'electron' || page.location?.href !== 'app://-/index.html'
      || page.document === undefined || typeof bridge?.sendMessageFromView !== 'function'
    ) return undefined
    try {
      const transport = new CodexDesktopNativeModelProviderTransport(
        bridge as Required<ElectronBridge>,
        'local',
        page.document,
        nativeManagedModelRoutingAvailable,
        rendererOwner,
        commandChannel,
      )
      await transport.refreshComposer()
      return transport
    } catch {
      return undefined
    }
  }

  getSnapshot = (): ProviderSelectionSnapshot => this.state
  hasActiveSubmission = (): boolean => this.selectionClient.submissionActive()
  confirmSubmission = (confirmed: boolean): void => this.selectionClient.confirmSubmission(confirmed)

  private currentSubmissionScope(): NativeSubmissionScope {
    const threadId = currentThreadId(this.document)
    return {
      ...this.rendererOwner,
      navigationGeneration: this.navigationGeneration,
      ...(threadId === undefined ? {} : { threadId }),
    }
  }

  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async select(target: {
    readonly providerId: string
    readonly model: string
  }, options: Readonly<{ source: 'preference'; expectedRevision: number }> | undefined = undefined): Promise<
    'accepted' | 'busy' | 'unavailable'
  > {
    if (this.disposed || !this.state.available || this.modelControl() === undefined) return 'unavailable'
    const navigation = this.navigationGeneration
    const threadId = this.state.threadId
    if (target.providerId !== this.state.modelProvider) {
      if (this.state.busy) return 'busy'
      const result = await this.selectionClient.select(target, options)
      if (!this.isCurrent(navigation, threadId)) return 'unavailable'
      if (result !== 'accepted' && options?.source === 'preference') await this.selectionClient.refresh()
      this.publishPatch({ error: null, submissionError: null })
      return result
    }
    // Returning to the effective provider cancels a pending cross-provider choice.
    const hadPending = this.selectionClient.snapshot().pending !== undefined
    if (hadPending) {
      const result = await this.selectionClient.select({
        providerId: target.providerId,
        model: this.state.model ?? target.model,
      }, options)
      if (result !== 'accepted' || !this.isCurrent(navigation, threadId)) return 'unavailable'
      this.publishPatch({ error: null, submissionError: null })
      if (target.model === this.state.model) return 'accepted'
    }
    if (this.state.busy) return 'busy'
    const control = this.modelControl()
    if (control === undefined) return 'unavailable'
    const previousModel = this.state.model ?? control.model
    const effort = this.state.reasoningEffort ?? control.reasoningEffort
    const targetSupportsFastMode = control.models.some(item => item.id === target.model && item.supportsFastMode)
    this.selecting = true
    this.publishPatch({ error: null, submissionError: null })
    try {
      await control.selectModel(target.model, effort)
      this.assertCurrent(navigation, threadId)
      if (await this.selectionClient.select(target, options) !== 'accepted') {
        if (options?.source === 'preference') await this.selectionClient.refresh()
        throw new Error('Native selection commit failed')
      }
      this.assertCurrent(navigation, threadId)
      this.publishPatch({
        model: target.model,
        reasoningEffort: effort,
        ...(!targetSupportsFastMode && this.state.serviceTier === 'priority' ? { serviceTier: null } : {}),
        error: null,
      })
      await this.selectionClient.refresh()
      return 'accepted'
    } catch {
      if (this.isCurrent(navigation, threadId)) {
        try {
          await this.modelControl()?.selectModel(previousModel, effort)
        } catch {
          this.publishPatch({ available: false })
        }
        this.publishPatch({ error: 'Native model selection failed' })
      }
      return 'unavailable'
    } finally {
      this.selecting = false
      if (this.isCurrent(navigation, threadId)) this.publishPatch()
    }
  }

  async selectReasoningEffort(reasoningEffort: string): Promise<'accepted' | 'busy' | 'unavailable'> {
    if (this.disposed || !this.nativeManagedModelRoutingAvailable || !this.state.available) return 'unavailable'
    if (this.state.busy) return 'busy'
    const navigationGeneration = this.navigationGeneration
    const selectionGeneration = ++this.selectionGeneration
    const threadId = this.state.threadId
    const control = this.modelControl()
    const model = this.state.model ?? control?.model
    const previousReasoningEffort = this.state.reasoningEffort ?? control?.reasoningEffort
    if (
      control === undefined || model === undefined || previousReasoningEffort === undefined
      || !control.reasoningEfforts.includes(reasoningEffort)
    ) return 'unavailable'
    this.selecting = true
    this.publishPatch({ error: null })
    try {
      await control.selectModel(model, reasoningEffort)
      this.assertCurrent(navigationGeneration, threadId)
      this.publishPatch({ model, reasoningEffort, reasoningEfforts: control.reasoningEfforts, error: null })
      return 'accepted'
    } catch (error) {
      const targetFailure = errorMessage(error)
      if (this.isCurrent(navigationGeneration, threadId)) {
        try {
          const rollbackControl = this.modelControl()
          if (rollbackControl === undefined) throw new Error('Native model control disappeared during rollback')
          await rollbackControl.selectModel(model, previousReasoningEffort)
          this.assertCurrent(navigationGeneration, threadId)
        } catch (rollbackError) {
          this.replaceState({
            available: false,
            busy: false,
            error: `${targetFailure}; native callback rollback failed: ${errorMessage(rollbackError)}`,
          })
          return 'unavailable'
        }
        this.publishPatch({ model, reasoningEffort: previousReasoningEffort, error: targetFailure })
      }
      return 'unavailable'
    } finally {
      if (selectionGeneration === this.selectionGeneration) {
        this.selecting = false
        if (this.isCurrent(navigationGeneration, threadId)) this.publishPatch()
      }
    }
  }

  async selectFastMode(enabled: boolean): Promise<'accepted' | 'busy' | 'unavailable'> {
    if (this.disposed || !this.nativeManagedModelRoutingAvailable || !this.state.available) return 'unavailable'
    if (this.modelControl() === undefined) return 'unavailable'
    if (this.state.busy) return 'busy'
    const navigationGeneration = this.navigationGeneration
    const selectionGeneration = ++this.selectionGeneration
    const threadId = this.state.threadId
    const control = this.modelControl()
    const model = this.state.model ?? control?.model
    const supportsFastMode = control?.models.some(item => item.id === model && item.supportsFastMode) === true
    if (control === undefined || model === undefined || (enabled && !supportsFastMode)) return 'unavailable'
    this.selecting = true
    this.publishPatch({ error: null })
    try {
      if (threadId !== undefined) {
        await this.request('thread/settings/update', { threadId, serviceTier: enabled ? 'priority' : null })
      }
      this.assertCurrent(navigationGeneration, threadId)
      this.publishPatch({ serviceTier: enabled ? 'priority' : null, error: null })
      return 'accepted'
    } catch (error) {
      if (this.isCurrent(navigationGeneration, threadId)) this.publishPatch({ error: errorMessage(error) })
      return 'unavailable'
    } finally {
      if (selectionGeneration === this.selectionGeneration) {
        this.selecting = false
        if (this.isCurrent(navigationGeneration, threadId)) this.publishPatch()
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const page = globalThis as NativeHookGlobal
    if (page.__cordisxNativeSubmitHook === this.selectionClient.submitHook) delete page.__cordisxNativeSubmitHook
    if (page.__cordisxNativeSubmissionAuthority === this.submissionAuthority) {
      delete page.__cordisxNativeSubmissionAuthority
    }
    delete page.__cordisxNativeServiceTierOverride
    this.selectionClient.dispose()
    this.refreshGeneration += 1
    this.clearControlDiscoveryRetry()
    this.clearTurnStatusRetry()
    this.observer?.disconnect()
    window.removeEventListener('message', this.receive, true)
    window.removeEventListener('codex-message-from-view', this.observeNativeRequest as EventListener, true)
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Native model provider transport disposed'))
    }
    this.pending.clear()
    this.nativeRequests.clear()
    this.effectiveByThread.clear()
    this.listeners.clear()
  }

  private readonly observeComposer = (): void => {
    const threadId = currentThreadId(this.document)
    const mount = locateNativeModelProviderMountSeat(this.document)
    // Keep the last confirmed labels during modal isolation, but never authorize interaction from this cache.
    if (threadId === this.visibleThreadId && mount && !nativeModelProviderInteractionAllowed(mount.trigger)) {
      if (!this.hasActiveSubmission() && this.suspendedAvailability === undefined) {
        this.suspendedAvailability = this.state.available
        this.publishPatch()
      }
      return
    }
    if (this.suspendedAvailability !== undefined) {
      const available = this.suspendedAvailability
      this.suspendedAvailability = undefined
      if (threadId === this.visibleThreadId && mount?.trigger === this.visibleTrigger) {
        this.publishPatch({ available })
      }
    }
    // Native submit makes its composer inert while awaiting our confirmation.
    if (threadId === this.visibleThreadId && this.hasActiveSubmission()) return
    const trigger = locateNativeModelProviderSeat(this.document)?.trigger
    if (threadId !== this.visibleThreadId) {
      this.selectionClient.invalidateScope()
      this.submissionError = undefined
      this.clearTurnStatusRetry()
      this.turnGeneration += 1
      this.visibleThreadId = threadId
      this.visibleTrigger = trigger
      this.navigationGeneration += 1
      this.selectionGeneration += 1
      this.selecting = false
      void this.refreshComposer()
      return
    }
    if (trigger !== this.visibleTrigger) {
      this.visibleTrigger = trigger
      void this.refreshComposer()
      return
    }
    if (!this.state.available && trigger !== undefined && this.modelControl() !== undefined) {
      void this.refreshComposer()
      return
    }
    this.syncControl()
  }

  private async refreshComposer(controlDiscoveryAttempt = 0): Promise<void> {
    this.clearControlDiscoveryRetry()
    const generation = ++this.refreshGeneration
    const threadId = currentThreadId(this.document)
    const seat = locateNativeModelProviderMountSeat(this.document)
    const trigger = seat?.trigger
    const control = trigger === undefined ? undefined : locateNativeModelSelectionControl(trigger)
    if (trigger && !nativeModelProviderInteractionAllowed(trigger)) this.suspendedAvailability = this.state.available
    this.visibleThreadId = threadId
    this.visibleTrigger = trigger
    this.turnBusy = threadId !== undefined
    this.replaceState({ available: false, busy: threadId !== undefined })
    if (control === undefined) {
      if (trigger !== undefined && controlDiscoveryAttempt < CONTROL_DISCOVERY_ATTEMPTS) {
        this.controlDiscoveryRetry = setTimeout(() => {
          delete this.controlDiscoveryRetry
          if (
            this.isRefreshCurrent(generation, threadId)
            && locateNativeModelProviderSeat(this.document)?.trigger === trigger
          ) void this.refreshComposer(controlDiscoveryAttempt + 1)
        }, CONTROL_DISCOVERY_RETRY_MS)
      }
      return
    }
    try {
      const response = threadId === undefined
        ? undefined
        : record(await this.request('thread/read', { threadId, includeTurns: false }))
      const config = await this.readConfig()
      if (!this.isRefreshCurrent(generation, threadId)) return
      this.providerNames.clear()
      for (const [id, value] of Object.entries(record(config.model_providers) ?? {})) {
        const name = string(record(value)?.name)
        if (name && name !== id) this.providerNames.set(id, name)
      }
      const thread = record(response?.thread)
      const busy = threadId === undefined ? false : thread === undefined ? undefined : threadBusy(thread)
      if (busy === undefined) return
      this.turnBusy = busy
      if (busy && threadId !== undefined) this.scheduleTurnStatusRefresh(threadId)
      else this.clearTurnStatusRetry()
      const effective = threadId === undefined ? undefined : this.effectiveByThread.get(threadId)
      const provider = effective?.providerId ?? string(thread?.modelProvider) ?? string(config.model_provider)
        ?? 'openai'
      const model = effective?.model ?? (control.model || string(config.model))
      const serviceTier = string(thread?.serviceTier) ?? string(config.service_tier)
      this.replaceState({
        available: true,
        busy,
        ...(threadId === undefined ? {} : { threadId }),
        ...(provider === undefined ? {} : { modelProvider: provider }),
        ...(model === undefined ? {} : { model }),
        ...(control.reasoningEffort === '' && string(config.model_reasoning_effort) === undefined
          ? {}
          : { reasoningEffort: control.reasoningEffort || string(config.model_reasoning_effort)! }),
        reasoningEfforts: control.reasoningEfforts,
        serviceTier: serviceTier === 'priority' || serviceTier === 'fast' ? 'priority' : null,
      })
      await this.selectionClient.refresh()
      const projection = this.selectionClient.snapshot()
      this.publishPatch({
        draftPreference: threadId === undefined && projection.draftPreference !== undefined
          ? { ...projection.draftPreference, revision: projection.revision }
          : null,
      })
    } catch {
      if (this.isRefreshCurrent(generation, threadId)) this.replaceState({ available: false, busy: false })
    }
  }

  private modelControl() {
    const seat = locateNativeModelProviderSeat(this.document)
    return seat === undefined ? undefined : locateNativeModelSelectionControl(seat.trigger)
  }

  private clearControlDiscoveryRetry(): void {
    if (this.controlDiscoveryRetry === undefined) return
    clearTimeout(this.controlDiscoveryRetry)
    delete this.controlDiscoveryRetry
  }

  private clearTurnStatusRetry(): void {
    if (this.turnStatusRetry === undefined) return
    clearTimeout(this.turnStatusRetry)
    delete this.turnStatusRetry
  }

  private scheduleTurnStatusRefresh(threadId: string): void {
    if (this.disposed || !this.turnBusy || this.turnStatusRetry !== undefined) return
    const navigationGeneration = this.navigationGeneration
    const turnGeneration = this.turnGeneration
    this.turnStatusRetry = setTimeout(() => {
      delete this.turnStatusRetry
      void this.refreshTurnStatus(navigationGeneration, turnGeneration, threadId)
    }, TURN_STATUS_RETRY_MS)
  }

  private async refreshTurnStatus(
    navigationGeneration: number,
    turnGeneration: number,
    threadId: string,
  ): Promise<void> {
    if (
      !this.turnBusy || turnGeneration !== this.turnGeneration
      || !this.isCurrent(navigationGeneration, threadId)
    ) return
    try {
      const response = record(await this.request('thread/read', { threadId, includeTurns: false }))
      if (
        !this.turnBusy || turnGeneration !== this.turnGeneration
        || !this.isCurrent(navigationGeneration, threadId)
      ) return
      const busy = threadBusy(record(response?.thread) ?? {})
      if (busy !== undefined) {
        this.turnBusy = busy
        this.publishPatch()
        if (!busy) await this.selectionClient.refresh()
      }
    } catch {
      // A failed read cannot prove the turn completed; keep the selector disabled and retry.
    } finally {
      if (
        this.turnBusy && turnGeneration === this.turnGeneration
        && this.isCurrent(navigationGeneration, threadId)
      ) this.scheduleTurnStatusRefresh(threadId)
    }
  }

  private syncControl(): void {
    const control = this.modelControl()
    if (control === undefined || !this.state.available) return
    const threadId = currentThreadId(this.document)
    const effective = threadId === undefined ? undefined : this.effectiveByThread.get(threadId)
    if (
      effective?.model !== undefined && effective.model !== control.model
      && !this.turnBusy && !this.selecting && !this.selectionClient.submissionActive()
      && !this.selectionClient.synchronizationActive()
    ) {
      void this.selectionClient.refresh()
      this.publishPatch()
      return
    }
    const model = effective?.model ?? control.model
    if (
      this.state.model === model
      && this.state.modelLabel === control.modelLabel
      && JSON.stringify(this.state.nativeModels) === JSON.stringify(control.models)
      && this.state.reasoningEffort === control.reasoningEffort
      && this.sameValues(this.state.reasoningEfforts, control.reasoningEfforts)
    ) return
    this.publishPatch({
      model,
      reasoningEffort: control.reasoningEffort,
      reasoningEfforts: control.reasoningEfforts,
    })
  }

  private sameValues(left: readonly string[] | undefined, right: readonly string[]): boolean {
    return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
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
      const provider = string(params.modelProvider)
      const model = string(params.model)
      this.nativeRequests.set(requestId, {
        method,
        ...(threadId === undefined ? {} : { threadId }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
      })
      return
    }
    if (method === 'turn/start') {
      const threadId = string(params.threadId)
      if (threadId === undefined || threadId !== currentThreadId(this.document)) return
      this.clearTurnStatusRetry()
      this.turnGeneration += 1
      this.turnBusy = true
      this.publishPatch({ threadId, model: string(params.model) ?? this.state.model ?? null })
      this.scheduleTurnStatusRefresh(threadId)
    }
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    if (this.disposed || (event.source !== null && event.source !== window)) return
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
    if (threadId === undefined || threadId !== currentThreadId(this.document)) return
    if (method === 'turn/started') {
      this.clearTurnStatusRetry()
      this.turnGeneration += 1
      this.turnBusy = true
      this.scheduleTurnStatusRefresh(threadId)
    } else if (method === 'turn/completed') {
      this.turnGeneration += 1
      this.turnBusy = false
      this.clearTurnStatusRetry()
    } else if (method === 'thread/status/changed') {
      const status = string(record(params?.status)?.type)
      if (status === 'idle' || status === 'notLoaded' || status === 'systemError') {
        this.turnGeneration += 1
        this.turnBusy = false
        this.clearTurnStatusRetry()
      } else if (status === 'active') {
        this.clearTurnStatusRetry()
        this.turnGeneration += 1
        this.turnBusy = true
        this.scheduleTurnStatusRefresh(threadId)
      } else return
    } else if (method === 'thread/settings/updated') {
      this.publishPatch({
        serviceTier: string(record(params?.settings)?.serviceTier) === 'priority' ? 'priority' : null,
      })
      return
    } else return
    this.publishPatch()
    if (!this.turnBusy) void this.selectionClient.refresh()
  }

  private receiveResponse(message: Record<string, unknown> | undefined): void {
    const requestId = string(message?.id)
    if (requestId === undefined) return
    const pending = this.pending.get(requestId)
    if (pending !== undefined) {
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      if (message?.error === undefined) pending.resolve(message?.result)
      else pending.reject(new Error(string(record(message.error)?.message) ?? 'Codex Desktop request failed'))
      return
    }
    const native = this.nativeRequests.get(requestId)
    if (native === undefined) return
    this.nativeRequests.delete(requestId)
    if (message?.error !== undefined) return
    const result = record(message?.result)
    const threadId = string(record(result?.thread)?.id)
    const visibleThreadId = currentThreadId(this.document)
    if (
      threadId === undefined || threadId !== visibleThreadId
      || (native.method === 'thread/resume' && native.threadId !== visibleThreadId)
    ) return
    const control = this.modelControl()
    this.turnBusy = false
    const provider = string(result?.modelProvider) ?? native.provider
    const model = string(result?.model) ?? native.model ?? control?.model
    const reasoningEffort = control?.reasoningEffort ?? this.state.reasoningEffort
    this.effectiveByThread.set(threadId, {
      ...(provider === undefined ? {} : { providerId: provider }),
      ...(model === undefined ? {} : { model }),
    })
    this.publishPatch({
      available: control !== undefined,
      threadId,
      modelProvider: provider ?? null,
      model: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      reasoningEfforts: control?.reasoningEfforts ?? null,
      error: null,
    })
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    const result = record(await this.request('config/read', { includeLayers: false, cwd: null }))
    return record(result?.config) ?? {}
  }

  private isCurrent(generation: number, threadId: string | undefined): boolean {
    return !this.disposed && generation === this.navigationGeneration && currentThreadId(this.document) === threadId
  }

  private isRefreshCurrent(generation: number, threadId: string | undefined): boolean {
    return !this.disposed && generation === this.refreshGeneration && currentThreadId(this.document) === threadId
  }

  private assertCurrent(generation: number, threadId: string | undefined): void {
    if (!this.isCurrent(generation, threadId)) throw new Error('Native composer changed during selection')
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error('Native model provider transport unavailable')
    const requestId = `cordisx-native-model-provider:${crypto.randomUUID()}`
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Codex Desktop ${method} timed out`))
      }, 30_000)
      this.pending.set(requestId, { resolve, reject, timer })
    })
    try {
      await this.bridge.sendMessageFromView({
        type: 'mcp-request',
        hostId: this.hostId,
        request: { id: requestId, method, params: clone(params) },
      })
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending !== undefined) {
        this.pending.delete(requestId)
        clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error(`Codex Desktop ${method} rejected`))
      }
    }
    return await response
  }

  private replaceState(next: SelectionSnapshot): void {
    if (this.disposed) return
    const seat = locateNativeModelProviderMountSeat(this.document)
    const control = seat === undefined ? undefined : locateNativeModelSelectionControl(seat.trigger)
    const projection = this.selectionClient.snapshot()
    const confirmation: NativeProviderSubmitConfirmation | undefined = this.selectionClient.confirmation()
    if (this.suspendedAvailability !== undefined) this.suspendedAvailability = next.available
    this.state = Object.freeze({
      ...next,
      available: this.suspendedAvailability === undefined && next.available,
      modelLabel: control?.model === next.model ? control?.modelLabel : undefined,
      nativeModels: control && control.model === next.model ? control.models : [],
      providerLabel: next.modelProvider === undefined ? undefined : this.providerNames.get(next.modelProvider),
      busy: next.busy || this.selectionClient.synchronizationActive(),
      ...(projection.pending === undefined ? {} : {
        pendingProviderId: projection.pending.providerId,
        pendingModel: projection.pending.model,
      }),
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(this.submissionError === undefined ? {} : { submissionError: this.submissionError }),
    })
    ;(globalThis as NativeHookGlobal).__cordisxNativeServiceTierOverride = this.state.serviceTier === 'priority'
      ? 'priority'
      : 'default'
    for (const listener of this.listeners) listener()
  }

  private publishPatch(next: SelectionPatch = {}): void {
    if (this.disposed) return
    if (Object.hasOwn(next, 'submissionError')) this.submissionError = next.submissionError ?? undefined
    const threadId = Object.hasOwn(next, 'threadId') ? next.threadId ?? undefined : this.state.threadId
    const modelProvider = Object.hasOwn(next, 'modelProvider')
      ? next.modelProvider ?? undefined
      : this.state.modelProvider
    const model = Object.hasOwn(next, 'model') ? next.model ?? undefined : this.state.model
    const reasoningEffort = Object.hasOwn(next, 'reasoningEffort')
      ? next.reasoningEffort ?? undefined
      : this.state.reasoningEffort
    const reasoningEfforts = Object.hasOwn(next, 'reasoningEfforts')
      ? next.reasoningEfforts ?? undefined
      : this.state.reasoningEfforts
    const serviceTier = Object.hasOwn(next, 'serviceTier') ? next.serviceTier ?? null : this.state.serviceTier
    const draftPreference = Object.hasOwn(next, 'draftPreference')
      ? next.draftPreference ?? undefined
      : this.state.draftPreference
    const error = Object.hasOwn(next, 'error') ? next.error ?? undefined : this.state.error
    this.replaceState({
      available: next.available ?? this.suspendedAvailability ?? this.state.available,
      busy: this.selecting || this.turnBusy,
      ...(threadId === undefined ? {} : { threadId }),
      ...(modelProvider === undefined ? {} : { modelProvider }),
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(draftPreference === undefined ? {} : { draftPreference }),
      ...(error === undefined ? {} : { error }),
    })
  }
}
