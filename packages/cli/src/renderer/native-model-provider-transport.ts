import {
  currentNativeComposerThreadId as currentThreadId,
  locateNativeModelProviderMountSeat,
  locateNativeModelProviderSeat,
  locateNativeModelSelectionControl,
} from './adapter/native-model-provider-seat.js'
import {
  nativeModelProviderInteractionAllowed,
  nativeModelProviderObservedAttributes,
} from './adapter/native-model-provider-interaction.js'
import { NativeModelSource } from './adapter/native-model-list.js'
import type { ProviderSelectionSnapshot, ProviderSelectionTransport } from './model-provider-selector.js'
import {
  NativeProviderSelectionClient,
  type NativeProviderSelectionCommandChannel,
  type NativeProviderSelectionOwner,
  type NativeProviderSubmitConfirmation,
  type NativeSubmissionRejection,
  type NativeSubmissionScope,
  type PendingNativeProviderSelection,
} from './native-provider-selection-client.js'
import { type NativeMcpBridge, NativeMcpRequestClient } from './native-mcp-request-client.js'
import {
  type CatalogReasoningLookup,
  PendingModelReasoning,
  resolveTargetReasoning,
  type TargetReasoning,
} from './native-model-reasoning.js'
import { isModelReasoningEffort } from '../model-reasoning-capabilities.js'
import { NativeModelSelectionSynchronizer } from './native-model-selection-synchronizer.js'
import { patchNativeSelection, type SelectionPatch, type SelectionSnapshot } from './native-model-provider-state.js'

type NativeHookGlobal = typeof globalThis & {
  __cordisxNativeSubmitHook?: NativeProviderSelectionClient['submitHook']
  __cordisxNativeSubmissionAuthority?: { snapshot: () => { scope: NativeSubmissionScope; idle: boolean } }
  __cordisxNativeServiceTierOverride?: 'priority' | 'default'
}

interface PendingNativeRequest {
  readonly method: 'thread/start' | 'thread/resume'
  readonly navigationGeneration: number
  readonly threadId?: string
  readonly provider?: string
  readonly model?: string
}

interface EffectiveSelection {
  readonly providerId?: string
  readonly model?: string
}

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

function threadBusy(thread: Record<string, unknown>): boolean | undefined {
  const status = string(record(thread.status)?.type)
  if (status === 'idle' || status === 'notLoaded' || status === 'systemError') return false
  if (status === 'active') return true
  return undefined
}

/** Host-private selection control using the launcher's verified native capability. */
export class CodexDesktopNativeModelProviderTransport implements ProviderSelectionTransport {
  private readonly listeners = new Set<() => void>()
  private readonly nativeRequests = new Map<string, PendingNativeRequest>()
  private readonly effectiveByThread = new Map<string, EffectiveSelection>()
  private readonly nativeModelAssignments = new Map<string, { readonly providerId: string; readonly model: string }>()
  private nativeModelAssignmentScope: string | undefined
  private nativeModelCatalogIdentity: string | undefined
  private readonly nativeModelSource = new NativeModelSource()
  private readonly requestClient: NativeMcpRequestClient
  private readonly providerNames = new Map<string, string>()
  private observer?: MutationObserver
  private controlDiscoveryRetry?: ReturnType<typeof setTimeout>
  private turnStatusRetry?: ReturnType<typeof setTimeout>
  private disposed = false
  private selecting = false
  private turnBusy = false
  private refreshGeneration = 0
  private pendingComposerRefresh: { generation: number; control: string } | undefined
  private navigationGeneration = 0
  private selectionGeneration = 0
  private turnGeneration = 0
  private visibleThreadId: string | undefined
  private visibleTrigger: HTMLElement | undefined
  private suspendedAvailability: boolean | undefined
  private readonly nativeSelection = new NativeModelSelectionSynchronizer()
  private readonly selectionClient: NativeProviderSelectionClient
  private submissionError: NativeSubmissionRejection | undefined
  private readonly pendingReasoning = new PendingModelReasoning()
  private state: SelectionSnapshot = Object.freeze({ available: false, busy: false })
  private readonly submissionAuthority = {
    snapshot: () => ({
      scope: this.currentSubmissionScope(),
      idle: this.state.available && !this.turnBusy && !this.selectionClient.synchronizationActive(),
    }),
  }

  private constructor(
    bridge: Required<NativeMcpBridge>,
    private readonly hostId: string,
    private readonly document: Document,
    private readonly nativeManagedModelRoutingAvailable: boolean,
    private readonly rendererOwner: NativeProviderSelectionOwner,
    commandChannel: NativeProviderSelectionCommandChannel,
    private readonly catalogReasoning: CatalogReasoningLookup,
  ) {
    this.requestClient = new NativeMcpRequestClient(bridge, hostId)
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
      async (selection, submittedEffort) => {
        const navigation = this.navigationGeneration
        const threadId = this.visibleThreadId
        if (!threadId) throw new Error('Native existing thread unavailable')
        this.refreshGeneration++
        this.clearControlDiscoveryRetry()
        const trigger = this.visibleTrigger
        const control = trigger?.isConnected ? locateNativeModelSelectionControl(trigger) : undefined
        if (!control) throw new Error('Native model control unavailable')
        const reasoning = this.targetReasoning(selection, control, submittedEffort)
        await this.nativeSelection.synchronize({
          scopeKey: JSON.stringify([navigation, threadId]),
          model: selection.model,
          effort: reasoning.effort,
          verifyEffort: submittedEffort !== undefined,
          readControl: () => {
            const liveTrigger = this.visibleTrigger
            return liveTrigger?.isConnected ? locateNativeModelSelectionControl(liveTrigger) : undefined
          },
          assertCurrent: () => this.assertCurrent(navigation, threadId),
        })
        this.confirmNativeModelAssignment(selection.providerId, selection.model)
        const selectedControl = this.modelControl()
        this.publishPatch({
          modelProvider: selection.providerId,
          model: selection.model,
          reasoningEffort: reasoning.catalogBacked
            ? reasoning.effort ?? null
            : selectedControl?.reasoningEffort ?? reasoning.effort ?? null,
          reasoningEfforts: reasoning.catalogBacked
            ? reasoning.efforts
            : selectedControl?.reasoningEfforts ?? reasoning.efforts,
        })
      },
      undefined,
      pending => {
        const control = this.modelControl()
        const effort = control === undefined ? undefined : this.pendingTargetReasoning(pending, control).effort
        return isModelReasoningEffort(effort) ? effort : undefined
      },
    )
    this.selectionClient.subscribe(() => {
      const projection = this.selectionClient.snapshot()
      const effective = projection.effective
      const draftPreference = this.visibleThreadId === undefined && projection.draftPreference !== undefined
        ? { ...projection.draftPreference, revision: projection.revision }
        : null
      if (effective !== undefined && this.selectionClient.confirmation() === undefined) {
        if (effective.providerId !== this.state.modelProvider || effective.model !== this.state.model) {
          this.retireNativeResumes(this.visibleThreadId)
        }
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
    catalogReasoning: CatalogReasoningLookup = () => undefined,
  ): Promise<CodexDesktopNativeModelProviderTransport | undefined> {
    if (
      !nativeManagedModelRoutingAvailable || !rendererOwner?.targetId || !rendererOwner.rendererGeneration
      || !commandChannel
    ) return undefined
    const page = globalThis as typeof globalThis & {
      readonly electronBridge?: NativeMcpBridge
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
        bridge as Required<NativeMcpBridge>,
        'local',
        page.document,
        nativeManagedModelRoutingAvailable,
        rendererOwner,
        commandChannel,
        catalogReasoning,
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
      if (result === 'accepted') this.retireNativeResumes(threadId)
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
      this.retireNativeResumes(threadId)
      this.publishPatch({ error: null, submissionError: null })
      if (target.model === this.state.model) return 'accepted'
    }
    if (this.state.busy) return 'busy'
    const control = this.modelControl()
    if (control === undefined) return 'unavailable'
    const previousModel = this.state.model ?? control.model
    const previousEffort = this.state.reasoningEffort ?? control.reasoningEffort
    const reasoning = this.targetReasoning(target, control)
    const targetSupportsFastMode = control.models.some(item => item.id === target.model && item.supportsFastMode)
    this.selecting = true
    this.publishPatch({ error: null, submissionError: null })
    try {
      await control.selectModel(target.model, reasoning.effort)
      this.assertCurrent(navigation, threadId)
      if (await this.selectionClient.select(target, options) !== 'accepted') {
        if (options?.source === 'preference') await this.selectionClient.refresh()
        throw new Error('Native selection commit failed')
      }
      this.assertCurrent(navigation, threadId)
      this.retireNativeResumes(threadId)
      this.publishPatch({
        model: target.model,
        reasoningEffort: reasoning.catalogBacked
          ? reasoning.effort ?? null
          : this.modelControl()?.reasoningEffort ?? reasoning.effort ?? null,
        reasoningEfforts: reasoning.catalogBacked
          ? reasoning.efforts
          : this.modelControl()?.reasoningEfforts ?? reasoning.efforts,
        ...(!targetSupportsFastMode && this.state.serviceTier === 'priority' ? { serviceTier: null } : {}),
        error: null,
      })
      await this.selectionClient.refresh()
      return 'accepted'
    } catch {
      if (this.isCurrent(navigation, threadId)) {
        try {
          await this.modelControl()?.selectModel(previousModel, previousEffort)
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
    if (this.state.busy || this.selectionClient.submissionActive()) return 'busy'
    const pending = this.selectionClient.snapshot().pending
    const pendingControl = this.modelControl()
    if (pending !== undefined) {
      if (
        pendingControl === undefined || !isModelReasoningEffort(reasoningEffort)
        || !this.pendingTargetReasoning(pending, pendingControl).efforts.includes(reasoningEffort)
      ) return 'unavailable'
      this.pendingReasoning.select(this.navigationGeneration, pending, reasoningEffort)
      this.publishPatch({ error: null })
      return 'accepted'
    }
    const navigationGeneration = this.navigationGeneration
    const selectionGeneration = ++this.selectionGeneration
    const threadId = this.state.threadId
    const control = this.modelControl()
    const model = this.state.model ?? control?.model
    const previousReasoningEffort = this.state.reasoningEffort ?? control?.reasoningEffort
    const reasoning = control === undefined || model === undefined || this.state.modelProvider === undefined
      ? undefined
      : this.targetReasoning({ providerId: this.state.modelProvider, model }, control)
    const reasoningEfforts = reasoning?.catalogBacked ? reasoning.efforts : control?.reasoningEfforts
    if (
      control === undefined || model === undefined || previousReasoningEffort === undefined
      || !reasoningEfforts?.includes(reasoningEffort)
    ) return 'unavailable'
    this.selecting = true
    this.publishPatch({ error: null })
    try {
      await control.selectModel(model, reasoningEffort)
      this.assertCurrent(navigationGeneration, threadId)
      this.publishPatch({ model, reasoningEffort, reasoningEfforts, error: null })
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
        await this.requestClient.request('thread/settings/update', {
          threadId,
          serviceTier: enabled ? 'priority' : null,
        })
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
    this.invalidateNativeModelAssignments()
    this.state = Object.freeze({ ...this.state, nativeModelAssignments: [] })
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
    this.requestClient.dispose()
    this.nativeRequests.clear()
    this.effectiveByThread.clear()
    this.listeners.clear()
  }

  private readonly observeComposer = (): void => {
    if (this.disposed) return
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
      this.invalidateNativeModelAssignments()
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
    if (!this.state.available && trigger !== undefined) {
      const control = this.modelControl()
      if (
        control !== undefined
        && (this.pendingComposerRefresh?.generation !== this.refreshGeneration
          || this.pendingComposerRefresh.control !== JSON.stringify(control))
      ) {
        void this.refreshComposer()
        return
      }
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
    // Native startup mutates the DOM while these bridge reads are pending.
    // Keep their generation valid until they settle; a different thread/trigger
    // still starts a new generation through observeComposer's earlier branches.
    this.pendingComposerRefresh = { generation, control: JSON.stringify(control) }
    try {
      const response = threadId === undefined
        ? undefined
        : record(await this.requestClient.request('thread/read', { threadId, includeTurns: false }))
      if (!this.isRefreshCurrent(generation, threadId)) return
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
      const catalogIdentity = string(config.model_catalog_json)
      const nativeModelsScope = catalogIdentity === undefined ? 'active-provider' : 'global'
      if (catalogIdentity !== undefined) this.nativeModelSource.clear()
      else {
        await this.nativeModelSource.refresh(
          string(config.model_provider) ?? 'openai',
          params => this.requestClient.request('model/list', params),
        )
      }
      if (!this.isRefreshCurrent(generation, threadId)) return
      this.nativeModelCatalogIdentity = catalogIdentity
      this.updateNativeModelAssignmentScope(threadId, catalogIdentity, control.models.map(option => option.id))
      this.confirmNativeModelAssignment(provider, model, nativeModelsScope, control.models)
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
        nativeModelsScope,
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
    } finally {
      if (this.pendingComposerRefresh?.generation === generation) this.pendingComposerRefresh = undefined
    }
  }

  private modelControl() {
    const seat = locateNativeModelProviderSeat(this.document)
    return seat === undefined ? undefined : locateNativeModelSelectionControl(seat.trigger)
  }

  private targetReasoning(
    target: { readonly providerId: string; readonly model: string },
    control: NonNullable<ReturnType<CodexDesktopNativeModelProviderTransport['modelControl']>>,
    effort: string | undefined = this.state.reasoningEffort ?? control.reasoningEffort,
  ): TargetReasoning {
    return resolveTargetReasoning(
      target,
      effort,
      control.models,
      this.catalogReasoning,
    )
  }

  private pendingTargetReasoning(
    pending: PendingNativeProviderSelection,
    control: NonNullable<ReturnType<CodexDesktopNativeModelProviderTransport['modelControl']>>,
  ): TargetReasoning {
    const effort = this.pendingReasoning.resolve(
      this.navigationGeneration,
      pending,
      this.state.reasoningEffort ?? control.reasoningEffort,
    )
    return this.targetReasoning(pending, control, effort)
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
      const response = record(await this.requestClient.request('thread/read', { threadId, includeTurns: false }))
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
    const reasoning = this.state.modelProvider === undefined
      ? undefined
      : this.targetReasoning({ providerId: this.state.modelProvider, model }, control, control.reasoningEffort)
    const reasoningEfforts = reasoning?.catalogBacked ? reasoning.efforts : control.reasoningEfforts
    const projectedModels = this.nativeModelSource.project(
      this.state.nativeModelsScope,
      this.state.modelProvider,
      control.models,
    )
    this.updateNativeModelAssignmentScope(
      threadId,
      this.nativeModelCatalogIdentity,
      control.models.map(option => option.id),
    )
    if (
      this.state.model === model
      && this.state.modelLabel === control.modelLabel
      && JSON.stringify(this.state.nativeModels) === JSON.stringify(projectedModels.nativeModels)
      && this.state.nativeModelsProviderId === projectedModels.nativeModelsProviderId
      && this.state.reasoningEffort === control.reasoningEffort
      && this.sameValues(this.state.reasoningEfforts, reasoningEfforts)
    ) return
    this.confirmNativeModelAssignment(
      this.state.modelProvider,
      model,
      this.state.nativeModelsScope,
      control.models,
    )
    this.publishPatch({
      model,
      reasoningEffort: control.reasoningEffort,
      reasoningEfforts,
    })
  }

  private sameValues(left: readonly string[] | undefined, right: readonly string[]): boolean {
    return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
  }

  // A later resume or accepted selection supersedes pending native readback for that thread.
  private retireNativeResumes(threadId: string | undefined): void {
    if (threadId === undefined) return
    for (const [id, request] of this.nativeRequests) {
      if (request.method === 'thread/resume' && request.threadId === threadId) this.nativeRequests.delete(id)
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
      if (method === 'thread/resume') this.retireNativeResumes(threadId)
      const provider = string(params.modelProvider)
      const model = string(params.model)
      this.nativeRequests.set(requestId, {
        method,
        navigationGeneration: this.navigationGeneration,
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
    if (this.requestClient.receive(message)) return
    const native = this.nativeRequests.get(requestId)
    if (native === undefined) return
    this.nativeRequests.delete(requestId)
    if (message?.error !== undefined) return
    const result = record(message?.result)
    const threadId = string(record(result?.thread)?.id)
    const visibleThreadId = currentThreadId(this.document)
    if (
      threadId === undefined || threadId !== visibleThreadId
      || (native.method === 'thread/resume'
        && (native.threadId !== visibleThreadId || native.navigationGeneration !== this.navigationGeneration))
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
    this.confirmNativeModelAssignment(provider, model)
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
    const result = record(await this.requestClient.request('config/read', { includeLayers: false, cwd: null }))
    return record(result?.config) ?? {}
  }

  private isCurrent(generation: number, threadId: string | undefined): boolean {
    return !this.disposed && generation === this.navigationGeneration && currentThreadId(this.document) === threadId
  }

  private updateNativeModelAssignmentScope(
    threadId: string | undefined,
    catalogIdentity: string | undefined,
    modelIds: readonly string[],
  ): void {
    const scope = JSON.stringify([threadId ?? null, catalogIdentity ?? null, modelIds])
    if (scope === this.nativeModelAssignmentScope) return
    this.nativeModelAssignments.clear()
    this.nativeModelAssignmentScope = scope
  }

  private invalidateNativeModelAssignments(): void {
    this.nativeModelAssignments.clear()
    this.nativeModelAssignmentScope = undefined
    this.nativeModelCatalogIdentity = undefined
  }

  private confirmNativeModelAssignment(
    providerId: string | undefined,
    model: string | undefined,
    scope = this.state.nativeModelsScope,
    models = this.modelControl()?.models ?? [],
  ): void {
    if (
      scope !== 'global' || providerId === undefined || model === undefined
      || !models.some(option => option.id === model)
    ) return
    this.nativeModelAssignments.set(JSON.stringify([providerId, model]), { providerId, model })
  }

  private isRefreshCurrent(generation: number, threadId: string | undefined): boolean {
    return !this.disposed && generation === this.refreshGeneration && currentThreadId(this.document) === threadId
  }

  private assertCurrent(generation: number, threadId: string | undefined): void {
    if (!this.isCurrent(generation, threadId)) throw new Error('Native composer changed during selection')
  }

  private replaceState(next: SelectionSnapshot): void {
    if (this.disposed) return
    const base = { ...next }
    Reflect.deleteProperty(base, 'nativeModelsProviderId')
    const seat = locateNativeModelProviderMountSeat(this.document)
    const control = seat === undefined ? undefined : locateNativeModelSelectionControl(seat.trigger)
    const projection = this.selectionClient.snapshot()
    this.pendingReasoning.resolve(this.navigationGeneration, projection.pending)
    const pendingReasoning = projection.pending === undefined || control === undefined
      ? undefined
      : this.pendingTargetReasoning(projection.pending, control)
    const effectiveReasoning = next.modelProvider === undefined || next.model === undefined || control === undefined
      ? undefined
      : this.targetReasoning({ providerId: next.modelProvider, model: next.model }, control, next.reasoningEffort)
    const confirmation: NativeProviderSubmitConfirmation | undefined = this.selectionClient.confirmation()
    const nativeModelSource = this.nativeModelSource.project(
      next.nativeModelsScope,
      next.modelProvider,
      control && control.model === next.model ? control.models : [],
    )
    if (this.suspendedAvailability !== undefined) this.suspendedAvailability = next.available
    this.state = Object.freeze({
      ...base,
      ...(effectiveReasoning?.catalogBacked ? { reasoningEfforts: effectiveReasoning.efforts } : {}),
      available: this.suspendedAvailability === undefined && next.available,
      modelLabel: control?.model === next.model ? control?.modelLabel : undefined,
      ...nativeModelSource,
      ...(next.nativeModelsScope === 'global'
        ? { nativeModelAssignments: [...this.nativeModelAssignments.values()] }
        : {}),
      providerLabel: next.modelProvider === undefined ? undefined : this.providerNames.get(next.modelProvider),
      busy: next.busy || this.selectionClient.synchronizationActive(),
      ...(projection.pending === undefined ? {} : {
        pendingProviderId: projection.pending.providerId,
        pendingModel: projection.pending.model,
        ...(pendingReasoning?.effort === undefined ? {} : { pendingReasoningEffort: pendingReasoning.effort }),
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
    this.replaceState(
      patchNativeSelection(this.state, next, this.selecting || this.turnBusy, this.suspendedAvailability),
    )
  }
}
