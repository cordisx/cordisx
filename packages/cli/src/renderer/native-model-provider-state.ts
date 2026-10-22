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
