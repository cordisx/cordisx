export interface NativeProviderSelection {
  readonly providerId: string
  readonly model: string
}

export type NativeProviderSelectionDecision =
  | Readonly<{ kind: 'same-provider-model'; target: NativeProviderSelection; clearsPending: true }>
  | Readonly<{ kind: 'pending-provider-change'; pending: NativeProviderSelection }>

export type NativeSubmissionIntent =
  | 'ordinary-send'
  | 'steer'
  | 'queue'
  | 'edit-retry'
  | 'unknown-submission'
  | 'non-submission'

/**
 * Semantic action emitted before effects by the version-pinned native adapter.
 * This policy does not infer intent from command ids, visual labels, or RPCs.
 */
export interface NormalizedNativeSubmissionAction {
  readonly operationId: string
  readonly operationGeneration: number
  readonly intent: NativeSubmissionIntent
  readonly threadId?: string
}

export interface PendingNativeProviderChange extends NativeProviderSelection {
  readonly threadId?: string
  readonly selectionGeneration: number
}

export interface PreparedNativeProviderChange {
  readonly pending: PendingNativeProviderChange
  readonly action: NormalizedNativeSubmissionAction
}

export type NativeProviderSubmissionDecision =
  | Readonly<{ kind: 'pass-through' }>
  | Readonly<{ kind: 'prepare-provider-change'; prepared: PreparedNativeProviderChange }>
  | Readonly<{ kind: 'reject'; reason: 'unsupported-submission-intent' }>

export type PreparedProviderChangeRevalidation =
  | Readonly<{ kind: 'dispatch' }>
  | Readonly<{
    kind: 'reject'
    reason: 'intent-changed' | 'thread-changed' | 'selection-changed' | 'operation-changed'
  }>

export function decideNativeProviderSelection(
  effectiveProviderId: string,
  target: NativeProviderSelection,
): NativeProviderSelectionDecision {
  return target.providerId === effectiveProviderId
    ? { kind: 'same-provider-model', target, clearsPending: true }
    : { kind: 'pending-provider-change', pending: target }
}

export function decideNativeProviderSubmission(
  pending: PendingNativeProviderChange | undefined,
  action: NormalizedNativeSubmissionAction,
): NativeProviderSubmissionDecision {
  if (pending === undefined || action.intent === 'non-submission') return { kind: 'pass-through' }
  if (action.intent === 'ordinary-send') return { kind: 'prepare-provider-change', prepared: { pending, action } }
  return { kind: 'reject', reason: 'unsupported-submission-intent' }
}

export function revalidatePreparedNativeProviderChange(
  prepared: PreparedNativeProviderChange,
  current: Readonly<{
    action: NormalizedNativeSubmissionAction
    pending?: PendingNativeProviderChange
  }>,
): PreparedProviderChangeRevalidation {
  if (current.action.intent !== 'ordinary-send') return { kind: 'reject', reason: 'intent-changed' }
  if (current.action.threadId !== prepared.action.threadId) return { kind: 'reject', reason: 'thread-changed' }
  if (
    current.action.operationId !== prepared.action.operationId
    || current.action.operationGeneration !== prepared.action.operationGeneration
  ) return { kind: 'reject', reason: 'operation-changed' }
  if (
    current.pending?.providerId !== prepared.pending.providerId
    || current.pending.model !== prepared.pending.model
    || current.pending.threadId !== prepared.pending.threadId
    || current.pending.selectionGeneration !== prepared.pending.selectionGeneration
  ) return { kind: 'reject', reason: 'selection-changed' }
  return { kind: 'dispatch' }
}
