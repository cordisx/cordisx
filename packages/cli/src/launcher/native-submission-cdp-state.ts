import type { NativeSubmissionScope } from './native-submission-controller-contracts.js'
import type { NativeDraftModelPreferenceValue } from './native-draft-model-preference.js'
import type {
  NativeProviderSelection,
  PendingNativeProviderChange,
} from '../renderer/native-provider-submission-policy.js'

export const key = (scope: NativeSubmissionScope): string =>
  JSON.stringify([
    scope.targetId,
    scope.rendererGeneration,
    scope.navigationGeneration,
    scope.threadId ?? null,
    scope.composerId ?? null,
  ])
export interface State {
  scope: NativeSubmissionScope
  revision: number
  nextGeneration: number
  effective?: NativeProviderSelection
  pendingProviderIntent?: Readonly<{ providerId: string; generation: number }>
  pending?: PendingNativeProviderChange
  draftPreference?: NativeDraftModelPreferenceValue
  draftUserSelected?: true
}
export const projection = (state: State) => ({
  available: state.effective !== undefined,
  revision: state.revision,
  ...(state.effective ? { effective: state.effective } : {}),
  ...(state.pendingProviderIntent ? { pendingProviderIntent: state.pendingProviderIntent } : {}),
  ...(state.pending === undefined
    ? {}
    : {
      pending: {
        providerId: state.pending.providerId,
        model: state.pending.model,
        generation: state.pending.selectionGeneration,
        ...(state.pending.sendOnly ? { sendOnly: true } : {}),
        ...(state.pending.blockedReason ? { blockedReason: state.pending.blockedReason } : {}),
      },
    }),
  ...(state.draftPreference === undefined ? {} : { draftPreference: state.draftPreference }),
})
