import {
  locateNativeComposerCreationInput,
  locateNativeComposerCreationRoute,
  type NativeComposerCreationSelection,
} from './adapter/native-composer-creation.js'
import type {
  NativeProviderSelection,
  NativeProviderSelectionOwner,
  NativeSubmissionScope,
} from './native-provider-selection-client.js'
import { isModelReasoningEffort, type ModelReasoningEffort } from '../model-reasoning-capabilities.js'

export interface NativeComposerCreationDisplay extends NativeComposerCreationSelection {
  readonly providerId: string
  readonly threadId?: string
  readonly serviceTier: 'priority' | null
}

interface Admission {
  readonly composerId: string
  readonly navigationGeneration: number
  readonly selection: NativeProviderSelection
  readonly effort: ModelReasoningEffort
  readonly serviceTier: 'priority' | null
  readonly expiresAt: number
  clientThreadId?: string
  threadId?: string
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)

/** Display-only handoff owned by one installed renderer document, never a routing authority. */
export class NativeComposerCreationHandoff {
  private readonly admissions = new Map<string, Admission>()
  private readonly retired = new Map<string, number>()
  private readonly observed = new WeakMap<HTMLElement, string>()
  private disposed = false

  constructor(private readonly owner: NativeProviderSelectionOwner, private readonly now: () => number = Date.now) {}

  admit(
    scope: NativeSubmissionScope,
    token: string,
    selection: NativeProviderSelection,
    effort: unknown,
    serviceTier: 'priority' | 'default' = 'default',
  ): void {
    if (
      this.disposed || scope.threadId !== undefined || !scope.composerId || !identifier(token)
      || scope.targetId !== this.owner.targetId || scope.rendererGeneration !== this.owner.rendererGeneration
      || token.length < 16 || token.length > 256 || !identifier(selection.providerId)
      || !identifier(selection.model) || !isModelReasoningEffort(effort)
    ) return
    this.prune()
    if (this.retired.has(token)) return
    const existing = this.admissions.get(token)
    if (existing) {
      if (
        existing.composerId !== scope.composerId || existing.navigationGeneration !== scope.navigationGeneration
        || existing.selection.providerId !== selection.providerId || existing.selection.model !== selection.model
        || existing.effort !== effort || existing.serviceTier !== (serviceTier === 'priority' ? 'priority' : null)
      ) this.retire(token)
      return
    }
    if (this.admissions.size + this.retired.size >= 16) return
    this.admissions.set(token, {
      composerId: scope.composerId,
      navigationGeneration: scope.navigationGeneration,
      selection: { ...selection },
      effort,
      serviceTier: serviceTier === 'priority' ? 'priority' : null,
      expiresAt: this.now() + 600_000,
    })
  }

  read(composer: HTMLElement | undefined, threadId: string | undefined): NativeComposerCreationDisplay | undefined {
    if (this.disposed || !composer?.isConnected) return undefined
    this.prune()
    const route = locateNativeComposerCreationRoute(composer)
    if (!route || route.threadId !== threadId) {
      const token = this.observed.get(composer)
      const previous = token === undefined ? undefined : this.admissions.get(token)
      // A committed native ID may appear before the transport's matching
      // projection. Hide that stale snapshot without destroying its handoff.
      if (
        route && route.threadId !== undefined && threadId === undefined
        && previous?.clientThreadId === route.clientThreadId
      ) {
        return undefined
      }
      this.retireObserved(composer)
      return undefined
    }
    let admission: Admission | undefined
    let token: string | undefined
    const input = locateNativeComposerCreationInput(composer)
    if (input !== undefined || threadId === undefined) {
      if (!input?.operationToken) {
        this.retireObserved(composer)
        return undefined
      }
      token = input.operationToken
      const selected = this.admissions.get(input.operationToken)
      if (
        !selected || selected.selection.model !== input.selection.model
        || selected.effort !== input.selection.reasoningEffort
        || (selected.clientThreadId !== undefined && selected.clientThreadId !== route.clientThreadId)
      ) {
        this.retireObserved(composer)
        return undefined
      }
      selected.clientThreadId = route.clientThreadId
      if (threadId !== undefined) {
        if (selected.threadId !== undefined && selected.threadId !== threadId) return undefined
        selected.threadId = threadId
      }
      admission = selected
    } else {
      const matching = [...this.admissions].filter(([, value]) => value.clientThreadId === route.clientThreadId)
      if (matching.length !== 1 || (matching[0]![1].threadId !== undefined && matching[0]![1].threadId !== threadId)) {
        this.retireObserved(composer)
        return undefined
      }
      ;[token, admission] = matching[0]!
      admission.threadId = threadId
    }
    this.observed.set(composer, token)
    return {
      clientThreadId: route.clientThreadId,
      providerId: admission.selection.providerId,
      model: admission.selection.model,
      reasoningEffort: admission.effort,
      serviceTier: admission.serviceTier,
      ...(threadId === undefined ? {} : { threadId }),
    }
  }

  /** A real binding takes over permanently; a later unavailable refresh cannot revive old labels. */
  acknowledge(composer: HTMLElement | undefined, threadId: string): void {
    if (this.disposed || !composer?.isConnected) return
    // Native publishes the real ID on the pending Composer before mounting its
    // settled replacement. Keep this exact handoff until that replacement binds.
    if (locateNativeComposerCreationInput(composer) !== undefined) return
    const route = locateNativeComposerCreationRoute(composer)
    if (route?.threadId !== threadId) return
    for (const [token, admission] of this.admissions) {
      if (admission.clientThreadId === route.clientThreadId) this.retire(token)
    }
  }

  dispose(): void {
    this.disposed = true
    this.admissions.clear()
    this.retired.clear()
  }

  private retireObserved(composer: HTMLElement): void {
    const token = this.observed.get(composer)
    if (token !== undefined) this.retire(token)
    this.observed.delete(composer)
  }

  private retire(token: string): void {
    const entry = this.admissions.get(token)
    if (entry) this.retired.set(token, entry.expiresAt)
    this.admissions.delete(token)
  }

  private prune(): void {
    for (const [token, admission] of this.admissions) {
      if (admission.expiresAt <= this.now()) this.admissions.delete(token)
    }
    for (const [token, expiresAt] of this.retired) {
      if (expiresAt <= this.now()) this.retired.delete(token)
    }
  }
}
