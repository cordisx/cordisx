import type { ProviderSelectionSnapshot } from './model-provider-selector.js'
import type { NativeSubmissionRejection } from './native-provider-selection-client.js'

export interface SelectionSnapshot extends ProviderSelectionSnapshot {
  readonly error?: string
}

export interface SelectionPatch {
  readonly available?: boolean
  readonly threadId?: string | null
  readonly modelProvider?: string | null
  readonly model?: string | null
  readonly reasoningEffort?: string | null
  readonly reasoningEfforts?: readonly string[] | null
  readonly serviceTier?: 'priority' | null
  readonly nativeModelsScope?: ProviderSelectionSnapshot['nativeModelsScope']
  readonly error?: string | null
  readonly submissionError?: NativeSubmissionRejection | null
  readonly draftPreference?: ProviderSelectionSnapshot['draftPreference'] | null
}

/** Model ownership evidence lives only within its exact thread/catalog scope. */
export class NativeModelAssignments {
  private readonly entries = new Map<string, { readonly providerId: string; readonly model: string }>()
  private scope: string | undefined

  updateScope(threadId: string | undefined, catalogIdentity: string | undefined, modelIds: readonly string[]): void {
    const scope = JSON.stringify([threadId ?? null, catalogIdentity ?? null, modelIds])
    if (scope === this.scope) return
    this.entries.clear()
    this.scope = scope
  }

  clear(): void {
    this.entries.clear()
    this.scope = undefined
  }

  confirm(
    scope: ProviderSelectionSnapshot['nativeModelsScope'],
    providerId: string | undefined,
    model: string | undefined,
    modelIds: readonly string[],
  ): void {
    if (scope !== 'global' || providerId === undefined || model === undefined || !modelIds.includes(model)) return
    this.entries.set(JSON.stringify([providerId, model]), { providerId, model })
  }

  snapshot(): NonNullable<ProviderSelectionSnapshot['nativeModelAssignments']> {
    return [...this.entries.values()]
  }
}

/** Merge durable control fields; pending choices and labels are projected by their owners. */
export function patchNativeSelection(
  state: SelectionSnapshot,
  next: SelectionPatch,
  busy: boolean,
  suspendedAvailability: boolean | undefined,
): SelectionSnapshot {
  const threadId = Object.hasOwn(next, 'threadId') ? next.threadId ?? undefined : state.threadId
  const modelProvider = Object.hasOwn(next, 'modelProvider') ? next.modelProvider ?? undefined : state.modelProvider
  const model = Object.hasOwn(next, 'model') ? next.model ?? undefined : state.model
  const reasoningEffort = Object.hasOwn(next, 'reasoningEffort')
    ? next.reasoningEffort ?? undefined
    : state.reasoningEffort
  const reasoningEfforts = Object.hasOwn(next, 'reasoningEfforts')
    ? next.reasoningEfforts ?? undefined
    : state.reasoningEfforts
  const serviceTier = Object.hasOwn(next, 'serviceTier') ? next.serviceTier ?? null : state.serviceTier
  const nativeModelsScope = next.nativeModelsScope ?? state.nativeModelsScope
  const draftPreference = Object.hasOwn(next, 'draftPreference')
    ? next.draftPreference ?? undefined
    : state.draftPreference
  const error = Object.hasOwn(next, 'error') ? next.error ?? undefined : state.error
  return {
    available: next.available ?? suspendedAvailability ?? state.available,
    busy,
    ...(state.providerSwitchAvailable === undefined ? {} : { providerSwitchAvailable: state.providerSwitchAvailable }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(nativeModelsScope === undefined ? {} : { nativeModelsScope }),
    ...(draftPreference === undefined ? {} : { draftPreference }),
    ...(error === undefined ? {} : { error }),
  }
}

export function nativeThreadBusy(thread: Record<string, unknown>): boolean | undefined {
  const status = typeof thread.status === 'object' && thread.status !== null
    ? (thread.status as Record<string, unknown>).type
    : undefined
  if (status === 'idle' || status === 'notLoaded' || status === 'systemError') return false
  return status === 'active' ? true : undefined
}

export function nextSendSelectionFields(
  projection: import('./native-provider-selection-client.js').NativeProviderSelectionProjection,
  submissionActive: boolean,
  selectionActive: boolean,
  details: {
    effort?: string | undefined
    confirmation?: import('./native-provider-selection-client.js').NativeProviderSubmitConfirmation | undefined
    error?: NativeSubmissionRejection | undefined
  },
) {
  return {
    selectionLocked: submissionActive || selectionActive,
    ...(projection.pendingProviderIntent ? { pendingProviderIntent: projection.pendingProviderIntent } : {}),
    ...(projection.nextSend ? { nextSend: projection.nextSend } : {}),
    ...(projection.pending
      ? {
        pendingProviderId: projection.pending.providerId,
        pendingModel: projection.pending.model,
        ...(details.effort === undefined ? {} : { pendingReasoningEffort: details.effort }),
      }
      : {}),
    ...(details.confirmation ? { confirmation: details.confirmation } : {}),
    ...(details.error ? { submissionError: details.error } : {}),
  }
}

export function sameValues(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
}

export interface PendingNativeRequest {
  readonly method: 'thread/start' | 'thread/resume'
  readonly navigationGeneration: number
  readonly threadId?: string
  readonly provider?: string
  readonly model?: string
}

export interface EffectiveSelection {
  readonly providerId?: string
  readonly model?: string
}

export const record = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)
export const string = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 && value.length <= 1_000_000 ? value : undefined
)
export const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'Native model provider selection failed'

/** Preserve external-store identity when only object allocation or key order changed. */
export function sameSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).filter(key => a[key] !== undefined)
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => sameSnapshot(a[key], b[key]))
}
