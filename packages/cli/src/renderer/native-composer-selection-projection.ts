import type { ProviderSelectionSnapshot } from './model-provider-selector.js'
import { nextSendSelectionFields, type SelectionSnapshot } from './native-model-provider-state.js'
import type { nativeComposerSelectionPresentation } from './native-composer-refresh.js'
import type { NativeProviderSelectionClient, NativeSubmissionRejection } from './native-provider-selection-client.js'
import type { ComposerModelReasoning, PendingModelReasoning } from './native-model-reasoning.js'
import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'

/** Combine already-owned composer facts into the renderer's read-only selection. */
export function nativeComposerSelectionProjection(input: {
  next: SelectionSnapshot
  cachedDisplay: ProviderSelectionSnapshot['cachedDisplay']
  presentation: ReturnType<typeof nativeComposerSelectionPresentation>
  creationDisplay: ProviderSelectionSnapshot['creationDisplay']
  suspended: boolean
  assignments(): NonNullable<ProviderSelectionSnapshot['nativeModelAssignments']>
  selectionActive: boolean
  selection: NativeProviderSelectionClient
  pendingReasoning: PendingModelReasoning
  reasoning: ComposerModelReasoning
  navigationGeneration: number
  control: NativeModelSelectionControl | undefined
  submissionError: NativeSubmissionRejection | undefined
}): SelectionSnapshot {
  const base = { ...input.next }
  Reflect.deleteProperty(base, 'nativeModelsProviderId')
  const projection = input.selection.snapshot()
  input.pendingReasoning.resolve(input.navigationGeneration, projection.pending)
  const pending = projection.pending === undefined || input.control === undefined
    ? undefined
    : input.reasoning.pendingTarget(projection.pending, input.control)
  return {
    ...base,
    cachedDisplay: input.cachedDisplay,
    ...input.presentation,
    creationDisplay: input.creationDisplay,
    available: input.presentation.pendingCreation === undefined && !input.suspended && input.next.available,
    ...(input.next.nativeModelsScope === 'global' ? { nativeModelAssignments: input.assignments() } : {}),
    busy: input.presentation.pendingCreation !== undefined || input.next.busy || input.selectionActive,
    ...nextSendSelectionFields(projection, input.selection.submissionActive(), input.selection.selectionActive(), {
      effort: pending?.effort,
      confirmation: input.selection.confirmation(),
      error: input.submissionError,
    }),
  }
}
