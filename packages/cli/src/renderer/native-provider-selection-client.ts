import {
  type NativeSubmissionOrchestratorDescriptor,
  normalizeNativeSubmissionAction,
} from './adapter/native-submission-action-normalizer.js'
import type { NormalizedNativeSubmissionAction } from './native-provider-submission-policy.js'

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
}

export interface NativeProviderSelectionProjection {
  readonly available: boolean
  readonly revision: number
  readonly effective?: NativeProviderSelection
  readonly pending?: PendingNativeProviderSelection
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

export interface NativeProviderSelectionCommandChannel {
  catalogRead?(): Promise<readonly import('./model-providers.js').NativeProviderProjection[]>
  selectionRead(
    input: Readonly<{ scope: NativeSubmissionScope; effective?: NativeProviderSelection }>,
  ): Promise<NativeProviderSelectionProjection>
  selectionSelect(
    input: Readonly<{
      scope: NativeSubmissionScope
      providerId: string
      model: string
      source?: 'user' | 'preference'
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
  submissionPrepare(
    input: Readonly<{
      scope: NativeSubmissionScope
      action: NormalizedNativeSubmissionAction
    }>,
  ): Promise<
    | Readonly<{ status: 'pass-through' }>
    | Readonly<{ status: 'confirm'; confirmationId: string; expectedSelectionRevision: number }>
    | Readonly<{ status: 'allow-original'; operationToken: string }>
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
}

export type NativeSubmitHookResult = Readonly<{ allow: false }> | Readonly<{ allow: true; operationToken?: string }>
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
  private readonly unsynchronized = new Set<string>()

  constructor(
    private readonly channel: NativeProviderSelectionCommandChannel,
    private readonly authority: () => MutableNativeSubmitAuthority,
    private readonly rejected: (reason: NativeSubmissionRejection) => void,
    private readonly synchronizeEffective: (selection: NativeProviderSelection) => Promise<void>,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  snapshot = (): NativeProviderSelectionProjection => this.projection
  submissionActive = (): boolean => this.admission !== undefined
  synchronizationActive = (): boolean => {
    const threadId = this.authority().scope.threadId
    return threadId !== undefined && this.unsynchronized.has(threadId)
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
    const generation = ++this.projectionGeneration
    const synchronize = scope.threadId !== undefined && authority.idle && !this.submissionActive()
    if (synchronize) this.unsynchronized.add(scope.threadId!)
    try {
      const next = await this.channel.selectionRead({
        scope,
        ...(authority.effective === undefined ? {} : { effective: authority.effective }),
      })
      if (this.projectionCurrent(scope, generation, next.revision)) {
        if (synchronize && next.effective) {
          await this.synchronizeEffective(next.effective)
          if (!this.projectionCurrent(scope, generation, next.revision)) return
        }
        if (synchronize && next.available) this.unsynchronized.delete(scope.threadId!)
        this.replace(next)
      }
    } catch {
      if (this.projectionCurrent(scope, generation, this.projection.revision)) {
        this.replace({ available: false, revision: this.projection.revision })
      }
    }
  }

  async select(
    target: NativeProviderSelection,
    options: Readonly<{ source?: 'user' | 'preference'; expectedRevision?: number }> = {},
  ): Promise<'accepted' | 'unavailable'> {
    if (this.disposed || !this.projection.available) return 'unavailable'
    this.confirmSubmission(false)
    const scope = this.authority().scope
    const generation = ++this.projectionGeneration
    try {
      const result = await this.channel.selectionSelect({ scope, ...target, ...options })
      if (!this.projectionCurrent(scope, generation, result.revision)) return 'unavailable'
      this.replace({
        available: true,
        revision: result.revision,
        effective: result.effective,
        ...(result.pending === undefined ? {} : { pending: result.pending }),
      })
      if (scope.threadId !== undefined && result.pending === undefined) {
        this.unsynchronized.add(scope.threadId)
        try {
          await this.synchronizeEffective(result.effective)
          if (!this.projectionCurrent(scope, generation, result.revision)) return 'unavailable'
          this.unsynchronized.delete(scope.threadId)
        } catch {
          this.notice('submission-rejected')
          return 'unavailable'
        }
      }
      return 'accepted'
    } catch {
      return 'unavailable'
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
    this.lifetimeGeneration++
    this.projectionGeneration++
    this.confirmSubmission(false)
    this.admission = undefined
    this.replace({ available: false, revision: 0 })
  }

  readonly submitHook = async (descriptor: NativeSubmissionOrchestratorDescriptor): Promise<NativeSubmitHookResult> => {
    if (this.disposed) return { allow: false }
    const before = this.authority()
    const lifetime = this.lifetimeGeneration
    const projectionGeneration = this.projectionGeneration
    const pending = this.projection.pending
    if (before.scope.threadId && this.unsynchronized.has(before.scope.threadId)) {
      this.notice('submission-rejected')
      return { allow: false }
    }
    if (pending !== undefined && this.admission !== undefined) return { allow: false }
    const sequence = ++this.operationSequence
    const action = normalizeNativeSubmissionAction(
      { operationId: this.createId(), operationGeneration: sequence },
      descriptor,
    )
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
            && this.projection.pending === undefined
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
      } else token = prepared.operationToken
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
        await this.synchronizeEffective(effective)
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
      return { allow: true, operationToken: token }
    } catch {
      this.notice('submission-rejected')
      return { allow: false }
    } finally {
      // The successful path has no await after its last mutable-state check.
      if (cancelId !== undefined) await this.cancelQuietly(before.scope, cancelId)
      if (this.admission === sequence) this.admission = undefined
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.invalidateScope()
    this.disposed = true
    this.listeners.clear()
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
