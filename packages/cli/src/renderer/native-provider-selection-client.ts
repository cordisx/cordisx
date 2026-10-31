import {
  type NativeSubmissionOrchestratorDescriptor,
  normalizeNativeSubmissionAction,
} from './adapter/native-submission-action-normalizer.js'
import type { NormalizedNativeSubmissionAction } from './native-provider-submission-policy.js'
import type { CatalogManagementChannel } from '../model-catalog-management.js'
import type { ModelReasoningEffort } from '../model-reasoning-capabilities.js'

export interface NativeSubmissionScope {
  readonly targetId: string
  readonly rendererGeneration: string
  readonly navigationGeneration: number
  readonly threadId?: string
}

export interface NativeProviderSelection {
  readonly providerId: string
  readonly model: string
}

export interface PendingNativeProviderSelection extends NativeProviderSelection {
  readonly generation: number
  readonly sendOnly?: boolean
}

export interface NativeProviderSelectionProjection {
  readonly available: boolean
  readonly revision: number
  readonly effective?: NativeProviderSelection
  readonly pending?: PendingNativeProviderSelection
  readonly nextSend?: NativeProviderSelection & { readonly reasoningEffort?: ModelReasoningEffort }
  readonly draftPreference?: Readonly<{
    readonly providerId: string
    readonly generation: number
  }>
}

export interface NativeProviderSubmitConfirmation {
  readonly confirmationId: string
  readonly expectedSelectionRevision: number
  readonly target: PendingNativeProviderSelection
  readonly threadId: string
}

export interface NativeProviderSelectionCommandChannel extends Partial<CatalogManagementChannel> {
  catalogRead?(): Promise<readonly import('./model-providers.js').NativeProviderProjection[]>
  catalogSubscribe?(listener: () => void): () => void
  catalogSnapshotRead?(): Promise<{
    epoch: string
    sequence: number
    providers: readonly import('./model-providers.js').NativeProviderProjection[]
  }>
  selectionRead(
    input: Readonly<{ scope: NativeSubmissionScope; effective?: NativeProviderSelection }>,
  ): Promise<NativeProviderSelectionProjection>
  selectionSelect(
    input: Readonly<{
      scope: NativeSubmissionScope
      providerId: string
      model: string
      source?: 'user' | 'preference'
      mode?: 'stage-send'
      expectedRevision?: number
    }>,
  ): Promise<
    Readonly<{
      status: 'accepted'
      revision: number
      effective: NativeProviderSelection
      pending?: PendingNativeProviderSelection
    }>
  >
  selectionDiscard(
    input: Readonly<{ scope: NativeSubmissionScope; expectedRevision: number }>,
  ): Promise<NativeProviderSelectionProjection>
  submissionPrepare(
    input: Readonly<{
      scope: NativeSubmissionScope
      action: NormalizedNativeSubmissionAction
    }>,
  ): Promise<
    | Readonly<{ status: 'pass-through' }>
    | Readonly<{ status: 'confirm'; confirmationId: string; expectedSelectionRevision: number }>
    | Readonly<{ status: 'allow-original'; operationToken: string; projection?: NativeProviderSelectionProjection }>
    | Readonly<{ status: 'reject'; reason: string }>
  >
  submissionConfirm(
    input: Readonly<{
      scope: NativeSubmissionScope
      confirmationId: string
      expectedSelectionRevision: number
    }>,
  ): Promise<
    | Readonly<{ status: 'allow-original'; operationToken: string; projection: NativeProviderSelectionProjection }>
    | Readonly<{ status: 'reject'; reason: string }>
  >
  submissionCancel(input: Readonly<{ scope: NativeSubmissionScope; id: string }>): Promise<unknown>
}

export interface NativeProviderSelectionOwner {
  readonly targetId: string
  readonly rendererGeneration: string
}

export interface MutableNativeSubmitAuthority {
  readonly scope: NativeSubmissionScope
  readonly idle: boolean
  readonly effective?: NativeProviderSelection
  readonly reasoningEffort?: ModelReasoningEffort
}

export type NativeSubmitHookResult =
  | Readonly<{ allow: false }>
  | Readonly<{ allow: true; operationToken?: string; reasoningEffort?: ModelReasoningEffort }>
export type NativeSubmissionRejection = 'unsupported-submission-intent' | 'submission-rejected'

interface ConfirmationWaiter {
  readonly confirmation: NativeProviderSubmitConfirmation
  readonly resolve: (confirmed: boolean) => void
}

const validToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 16 && value.length <= 256 && !/[\0\r\n]/u.test(value)

const sameScope = (left: NativeSubmissionScope, right: NativeSubmissionScope): boolean =>
  left.targetId === right.targetId && left.rendererGeneration === right.rendererGeneration
  && left.navigationGeneration === right.navigationGeneration && left.threadId === right.threadId

const samePending = (
  left: PendingNativeProviderSelection | undefined,
  right: PendingNativeProviderSelection | undefined,
): boolean =>
  left?.providerId === right?.providerId && left?.model === right?.model
  && left?.generation === right?.generation

/** Mutable renderer projection only; all sensitive provider material remains in Node. */
export class NativeProviderSelectionClient {
  private readonly listeners = new Set<() => void>()
  private projection: NativeProviderSelectionProjection = Object.freeze({ available: false, revision: 0 })
  private waiter: ConfirmationWaiter | undefined
  private projectionGeneration = 0
  private lifetimeGeneration = 0
  private operationSequence = 0
  private admission: number | undefined
  private disposed = false
  private nextSend: NativeProviderSelectionProjection['nextSend']
  private nextSendActive = false
  private draftEditGeneration = 0
  private submittedEffort: ModelReasoningEffort | undefined
  private readonly unsynchronized = new Set<string>()
  // A failed acknowledgement keeps Send fenced, but is no longer an in-flight selector operation.
  private readonly selectionOperations = new Set<{ readonly scope: NativeSubmissionScope }>()

  constructor(
    private readonly channel: NativeProviderSelectionCommandChannel,
    private readonly authority: () => MutableNativeSubmitAuthority,
    private readonly rejected: (reason: NativeSubmissionRejection) => void,
    private readonly synchronizeEffective: (
      selection: NativeProviderSelection,
      reasoningEffort?: ModelReasoningEffort,
    ) => Promise<void>,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly pendingReasoning: (pending: PendingNativeProviderSelection) => ModelReasoningEffort | undefined =
      () => undefined,
    private readonly validateNextSend: (
      selection: NonNullable<NativeProviderSelectionProjection['nextSend']>,
    ) => Promise<boolean> = async () => true,
  ) {}

  snapshot = (): NativeProviderSelectionProjection => ({
    ...this.projection,
    ...(this.nextSend ? { nextSend: this.nextSend } : {}),
  })
  reserveDraftEdit = (): number => ++this.draftEditGeneration
  stageNextSend(
    target: NonNullable<NativeProviderSelectionProjection['nextSend']>,
    generation = this.reserveDraftEdit(),
  ): boolean {
    if (
      this.disposed || generation !== this.draftEditGeneration || this.submissionActive() || !this.projection.available
    ) return false
    this.nextSend = Object.freeze({ ...target })
    this.emit()
    return true
  }
  submissionActive = (): boolean => this.admission !== undefined || this.nextSendActive
  synchronizationActive = (): boolean => {
    const threadId = this.authority().scope.threadId
    return threadId !== undefined && this.unsynchronized.has(threadId)
  }
  selectionActive = (): boolean => {
    const scope = this.authority().scope
    return [...this.selectionOperations].some(operation => sameScope(operation.scope, scope))
  }
  confirmation = (): NativeProviderSubmitConfirmation | undefined => this.waiter?.confirmation
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    const authority = this.authority()
    const scope = authority.scope
    const operation = { scope }
    const generation = ++this.projectionGeneration
    const synchronize = scope.threadId !== undefined && authority.idle && !this.submissionActive()
      && this.projection.pending === undefined
    if (synchronize) {
      this.unsynchronized.add(scope.threadId!)
      this.selectionOperations.add(operation)
      this.emit()
    }
    try {
      const next = await this.channel.selectionRead({
        scope,
        ...(authority.effective === undefined ? {} : { effective: authority.effective }),
      })
      if (this.projectionCurrent(scope, generation, next.revision)) {
        this.replace(next)
        if (!this.projectionCurrent(scope, generation, next.revision)) return
        if (synchronize && next.effective && next.pending === undefined) {
          try {
            await this.synchronizeEffective(next.effective)
          } catch {
            // Keep the authoritative choice available for retry, but continue fencing Send.
            if (this.projectionCurrent(scope, generation, next.revision)) this.notice('submission-rejected')
            return
          }
          if (!this.projectionCurrent(scope, generation, next.revision)) return
        }
        if (synchronize && next.available) this.unsynchronized.delete(scope.threadId!)
      }
    } catch {
      if (this.projectionCurrent(scope, generation, this.projection.revision)) {
        this.replace({ available: false, revision: this.projection.revision })
      }
    } finally {
      this.selectionOperations.delete(operation)
      this.emit()
    }
  }

  async select(
    target: NativeProviderSelection,
    options: Readonly<{ source?: 'user' | 'preference'; expectedRevision?: number }> = {},
  ): Promise<'accepted' | 'unavailable'> {
    if (this.disposed || this.nextSendActive || this.selectionActive() || !this.projection.available) {
      return 'unavailable'
    }
    this.confirmSubmission(false)
    const scope = this.authority().scope
    const operation = { scope }
    const generation = ++this.projectionGeneration
    this.selectionOperations.add(operation)
    this.emit()
    try {
      const result = await this.channel.selectionSelect({ scope, ...target, ...options })
      if (!this.projectionCurrent(scope, generation, result.revision)) return 'unavailable'
      this.replace({
        available: true,
        revision: result.revision,
        effective: result.effective,
        ...(result.pending === undefined ? {} : { pending: result.pending }),
      })
      if (!this.projectionCurrent(scope, generation, result.revision)) return 'unavailable'
      if (scope.threadId !== undefined && result.pending === undefined) {
        this.unsynchronized.add(scope.threadId)
        try {
          await this.synchronizeEffective(result.effective)
          if (!this.projectionCurrent(scope, generation, result.revision)) return 'unavailable'
          this.unsynchronized.delete(scope.threadId)
        } catch {
          // The Host accepted this choice. Retry Composer synchronization on Send.
          return this.projectionCurrent(scope, generation, result.revision) ? 'accepted' : 'unavailable'
        }
      }
      return 'accepted'
    } catch {
      return 'unavailable'
    } finally {
      this.selectionOperations.delete(operation)
      this.emit()
    }
  }

  confirmSubmission(confirmed: boolean): void {
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = undefined
    this.emit()
    waiter.resolve(confirmed)
  }

  invalidateScope(): void {
    this.nextSend = undefined
    this.draftEditGeneration++
    this.lifetimeGeneration++
    this.projectionGeneration++
    this.confirmSubmission(false)
    this.admission = undefined
    this.replace({ available: false, revision: 0 })
  }

  readonly submitHook = async (descriptor: NativeSubmissionOrchestratorDescriptor): Promise<NativeSubmitHookResult> => {
    if (this.nextSendActive) return { allow: false }
    const draft = this.nextSend
    if (!draft) return this.submitCurrent(descriptor)
    const before = this.authority()
    const intent = normalizeNativeSubmissionAction({ operationId: this.createId(), operationGeneration: 0 }, descriptor)
    if (intent.intent !== 'ordinary-send') return this.submitCurrent(descriptor)
    if (!before.idle) return this.submitCurrent(descriptor)
    if (this.submissionActive()) return { allow: false }
    const lifetime = this.lifetimeGeneration
    const revision = this.projection.revision
    const current = () =>
      this.scopeCurrent(before.scope, lifetime) && this.authority().idle
      && this.nextSend === draft
    this.draftEditGeneration++
    this.nextSendActive = true
    this.emit()
    let stagedRevision: number | undefined
    let released = false
    let stagedPending = true
    let nativeModelChanged = false
    try {
      if (!await this.validateNextSend(draft) || !current() || this.projection.revision !== revision) {
        return { allow: false }
      }
      stagedRevision = revision + 1
      const selected = await this.channel.selectionSelect({
        scope: before.scope,
        providerId: draft.providerId,
        model: draft.model,
        mode: 'stage-send',
        expectedRevision: revision,
      })
      stagedRevision = selected.revision
      stagedPending = selected.pending !== undefined
      if (!current()) return { allow: false }
      this.projectionGeneration++
      this.replace({
        available: true,
        revision: selected.revision,
        effective: selected.effective,
        ...(selected.pending ? { pending: selected.pending } : {}),
      })
      this.submittedEffort = draft.reasoningEffort
      if (selected.pending?.providerId === selected.effective.providerId) {
        nativeModelChanged = true
        if (before.scope.threadId) this.unsynchronized.add(before.scope.threadId)
        await this.synchronizeEffective(draft, draft.reasoningEffort)
        if (!current()) return { allow: false }
        if (before.scope.threadId) this.unsynchronized.delete(before.scope.threadId)
      }
      const result = await this.submitCurrent(descriptor)
      if (!this.scopeCurrent(before.scope, lifetime)) return { allow: false }
      if (
        result.allow
        || this.projection.revision > (stagedRevision ?? revision) && this.projection.pending === undefined
          && this.projection.effective?.providerId === draft.providerId
          && this.projection.effective.model === draft.model
      ) this.nextSend = undefined
      released = result.allow
      return result
    } catch {
      this.notice('submission-rejected')
      return { allow: false }
    } finally {
      if (
        !released && stagedPending && stagedRevision !== undefined
        && (!this.scopeCurrent(before.scope, lifetime) || this.projection.pending !== undefined
          || this.projection.revision < stagedRevision)
      ) {
        try {
          const cleared = await this.channel.selectionDiscard({ scope: before.scope, expectedRevision: stagedRevision })
          if (this.scopeCurrent(before.scope, lifetime)) {
            this.projectionGeneration++
            this.replace(cleared)
          }
        } catch {
          this.notice('submission-rejected')
        }
        if (this.scopeCurrent(before.scope, lifetime)) await this.refresh()
      }
      if (!released && nativeModelChanged && before.effective && this.scopeCurrent(before.scope, lifetime)) {
        try {
          await this.synchronizeEffective(before.effective, before.reasoningEffort)
          if (this.scopeCurrent(before.scope, lifetime) && before.scope.threadId) {
            this.unsynchronized.delete(before.scope.threadId)
          }
        } catch {
          this.notice('submission-rejected')
        }
      }
      this.submittedEffort = undefined
      this.nextSendActive = false
      this.emit()
    }
  }

  private readonly submitCurrent = async (
    descriptor: NativeSubmissionOrchestratorDescriptor,
  ): Promise<NativeSubmitHookResult> => {
    if (this.disposed) return { allow: false }
    let before = this.authority()
    const lifetime = this.lifetimeGeneration
    const projectionGeneration = this.projectionGeneration
    const actionIntent =
      normalizeNativeSubmissionAction({ operationId: this.createId(), operationGeneration: 0 }, descriptor).intent
    const pending = this.projection.pending?.sendOnly && actionIntent !== 'ordinary-send'
      ? undefined
      : this.projection.pending
    if (this.selectionActive()) {
      this.notice('submission-rejected')
      return { allow: false }
    }
    if (before.scope.threadId && this.unsynchronized.has(before.scope.threadId) && pending === undefined) {
      if (
        actionIntent !== 'ordinary-send' || !before.idle || this.submissionActive()
        || !await this.retrySynchronization(before.scope)
        || !this.scopeCurrent(before.scope, lifetime) || projectionGeneration !== this.projectionGeneration
        || this.selectionActive()
      ) {
        this.notice('submission-rejected')
        return { allow: false }
      }
      before = this.authority()
    }
    if (pending !== undefined && this.admission !== undefined) return { allow: false }
    const sequence = ++this.operationSequence
    const normalized = normalizeNativeSubmissionAction(
      { operationId: this.createId(), operationGeneration: sequence },
      descriptor,
    )
    const reasoningEffort = pending !== undefined && normalized.intent === 'ordinary-send'
      ? this.submittedEffort ?? this.pendingReasoning(pending)
      : undefined
    const action = reasoningEffort === undefined ? normalized : { ...normalized, reasoningEffort }
    if (pending !== undefined && action.intent !== 'ordinary-send') {
      this.notice('unsupported-submission-intent')
      return { allow: false }
    }
    if (
      action.intent === 'ordinary-send' && before.scope.threadId !== undefined && pending === undefined
      && this.projection.effective !== undefined && before.effective !== undefined
      && this.projection.effective.model !== before.effective.model
    ) {
      this.notice('submission-rejected')
      void this.refresh()
      return { allow: false }
    }
    const revision = this.projection.revision
    if (pending !== undefined) this.admission = sequence
    let cancelId: string | undefined
    try {
      const prepared = await this.channel.submissionPrepare({ scope: before.scope, action })
      if (prepared.status === 'pass-through') {
        // No idle restriction for unchanged-provider steer, queue or other native actions.
        const synchronizationChanged = action.intent === 'ordinary-send' && before.scope.threadId !== undefined
          && (this.unsynchronized.has(before.scope.threadId) || projectionGeneration !== this.projectionGeneration)
        if (synchronizationChanged) this.notice('submission-rejected')
        return !synchronizationChanged && this.scopeCurrent(before.scope, lifetime)
            && (this.projection.pending === undefined
              || this.projection.pending.sendOnly && action.intent !== 'ordinary-send')
          ? { allow: true }
          : { allow: false }
      }
      if (prepared.status === 'reject') {
        this.notice(prepared.reason)
        return { allow: false }
      }
      cancelId = prepared.status === 'confirm' ? prepared.confirmationId : prepared.operationToken
      if (!this.managedCurrent(before.scope, lifetime, sequence, revision, pending, action)) return { allow: false }
      let token: string
      let committed: NativeProviderSelectionProjection | undefined
      if (prepared.status === 'confirm') {
        if (before.scope.threadId === undefined || pending === undefined || this.waiter !== undefined) {
          return { allow: false }
        }
        const confirmed = await new Promise<boolean>(resolve => {
          this.waiter = {
            confirmation: {
              confirmationId: prepared.confirmationId,
              expectedSelectionRevision: prepared.expectedSelectionRevision,
              target: pending,
              threadId: before.scope.threadId!,
            },
            resolve,
          }
          this.emit()
        })
        if (!confirmed || !this.managedCurrent(before.scope, lifetime, sequence, revision, pending, action)) {
          return { allow: false }
        }
        const result = await this.channel.submissionConfirm({
          scope: before.scope,
          confirmationId: prepared.confirmationId,
          expectedSelectionRevision: prepared.expectedSelectionRevision,
        })
        if (result.status === 'reject') {
          this.notice(result.reason)
          return { allow: false }
        }
        token = result.operationToken
        cancelId = token
        this.unsynchronized.add(before.scope.threadId)
        committed = result.projection
      } else {
        token = prepared.operationToken
        committed = prepared.projection
        if (committed && before.scope.threadId) this.unsynchronized.add(before.scope.threadId)
      }
      if (!validToken(token)) {
        this.notice('submission-rejected')
        return { allow: false }
      }
      if (!this.managedCurrent(before.scope, lifetime, sequence, revision, pending, action)) return { allow: false }
      if (committed !== undefined) {
        const effective = committed.effective
        if (
          !committed.available || !Number.isSafeInteger(committed.revision) || committed.revision <= revision
          || committed.pending !== undefined || effective === undefined || effective.providerId !== pending?.providerId
          || effective.model !== pending?.model
        ) {
          this.notice('submission-rejected')
          return { allow: false }
        }
        this.projectionGeneration++
        this.replace({ available: true, revision: committed.revision, effective: { ...effective } })
        if (action.reasoningEffort === undefined) await this.synchronizeEffective(effective)
        else await this.synchronizeEffective(effective, action.reasoningEffort)
        const live = this.authority()
        if (
          !this.scopeCurrent(before.scope, lifetime) || this.admission !== sequence || !live.idle
          || this.projection.revision !== committed.revision || this.projection.pending !== undefined
          || this.projection.effective?.providerId !== effective.providerId
          || this.projection.effective.model !== effective.model
        ) return { allow: false }
        this.unsynchronized.delete(before.scope.threadId!)
      } else if (prepared.status === 'confirm') {
        this.notice('submission-rejected')
        return { allow: false }
      }
      cancelId = undefined
      return {
        allow: true,
        operationToken: token,
        ...(action.reasoningEffort === undefined ? {} : { reasoningEffort: action.reasoningEffort }),
      }
    } catch {
      this.notice('submission-rejected')
      return { allow: false }
    } finally {
      // The successful path has no await after its last mutable-state check.
      if (cancelId !== undefined) await this.cancelQuietly(before.scope, cancelId)
      if (this.admission === sequence) {
        this.admission = undefined
        this.emit()
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.invalidateScope()
    this.disposed = true
    this.listeners.clear()
  }

  private async retrySynchronization(scope: NativeSubmissionScope): Promise<boolean> {
    const effective = this.projection.effective
    if (!this.projection.available || effective === undefined || scope.threadId === undefined) return false
    const generation = this.projectionGeneration
    const revision = this.projection.revision
    const operation = { scope }
    this.selectionOperations.add(operation)
    this.emit()
    try {
      if (!this.projectionCurrent(scope, generation, revision) || !this.authority().idle) return false
      await this.synchronizeEffective(effective)
      if (
        !this.projectionCurrent(scope, generation, revision) || !this.authority().idle
        || this.projection.pending !== undefined
      ) return false
      this.unsynchronized.delete(scope.threadId)
      return true
    } catch {
      return false
    } finally {
      this.selectionOperations.delete(operation)
      this.emit()
    }
  }

  private projectionCurrent(scope: NativeSubmissionScope, generation: number, revision: number): boolean {
    return !this.disposed && generation === this.projectionGeneration && sameScope(scope, this.authority().scope)
      && Number.isSafeInteger(revision) && revision >= this.projection.revision
  }

  private scopeCurrent(scope: NativeSubmissionScope, lifetime: number): boolean {
    return !this.disposed && lifetime === this.lifetimeGeneration && sameScope(scope, this.authority().scope)
  }

  private managedCurrent(
    scope: NativeSubmissionScope,
    lifetime: number,
    sequence: number,
    revision: number,
    pending: PendingNativeProviderSelection | undefined,
    action: NormalizedNativeSubmissionAction,
  ): boolean {
    const live = this.authority()
    return pending !== undefined && this.scopeCurrent(scope, lifetime) && this.admission === sequence
      && live.idle && live.scope.threadId === action.threadId && action.intent === 'ordinary-send'
      && this.projection.available && this.projection.revision === revision
      && samePending(this.projection.pending, pending)
  }

  private async cancelQuietly(scope: NativeSubmissionScope, id: string): Promise<void> {
    if (!validToken(id)) return
    try {
      await this.channel.submissionCancel({ scope, id })
    } catch {
      // The Node authority still owns expiry and final cleanup.
    }
  }

  private notice(reason: string): void {
    if (!this.disposed) this.rejected(reason === 'unsupported-submission-intent' ? reason : 'submission-rejected')
  }

  private replace(next: NativeProviderSelectionProjection): void {
    this.projection = Object.freeze(next)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
