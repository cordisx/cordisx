import type {
  NativeSubmissionConfirmation,
  NativeSubmissionController,
  NativeSubmissionRuntimeAuthority,
} from './native-submission-controller-contracts.js'
import { type Confirmation, type PreparedBase, sameScope } from './native-submission-records.js'

/** Consume the existing single-use non-logical provider confirmation. */
export function nativeSubmissionConfirmation(input: {
  disposed(): boolean
  expire(): Promise<void>
  confirmations: Map<string, Confirmation>
  now(): number
  revalidateSelection(prepared: PreparedBase): boolean
  runtime: NativeSubmissionRuntimeAuthority
  apply(prepared: PreparedBase): Promise<NativeSubmissionConfirmation>
}) {
  return async (
    request: Parameters<NativeSubmissionController['confirmSubmission']>[0],
  ): Promise<NativeSubmissionConfirmation> => {
    if (input.disposed()) return { kind: 'reject', reason: 'unknown-confirmation' }
    await input.expire()
    const confirmation = input.confirmations.get(request.confirmationId)
    if (!confirmation) return { kind: 'reject', reason: 'unknown-confirmation' }
    input.confirmations.delete(confirmation.id)
    if (confirmation.logical || !sameScope(confirmation.scope, request.scope)) {
      return { kind: 'reject', reason: 'stale-operation' }
    }
    if (confirmation.expiresAt <= input.now()) return { kind: 'reject', reason: 'expired-confirmation' }
    if (
      request.expectedSelectionRevision !== confirmation.selectionRevision || !input.revalidateSelection(confirmation)
      || !await input.runtime.revalidate(confirmation.scope, true)
    ) return { kind: 'reject', reason: 'stale-operation' }
    return await input.apply(confirmation)
  }
}
