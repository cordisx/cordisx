import type {
  NativeSubmissionConfirmation,
  NativeSubmissionController,
  NativeSubmissionControllerOptions,
  NativeSubmissionPreparation,
  NativeSubmissionRuntimeAuthority,
} from './native-submission-controller-contracts.js'
import type { DesktopLogicalMode } from './desktop-logical-migration.js'
import { type Confirmation, type PreparedBase, sameScope, validText } from './native-submission-records.js'

/** Prepare a single-use choice only while the captured selection is still current. */
export async function prepareLogicalConfirmation(prepared: PreparedBase, authority: {
  migration: NonNullable<NativeSubmissionControllerOptions['logicalMigration']>
  canCommit: boolean
  disposed(): boolean
  revalidateSelection(prepared: PreparedBase): boolean
  createId(): string
  confirmations: Map<string, Confirmation>
}): Promise<NativeSubmissionPreparation> {
  if (!authority.canCommit || prepared.action.continuationAvailable !== true) {
    return { kind: 'reject', reason: 'provider-switch-unsupported' }
  }
  const suggestion = await authority.migration.suggest(prepared.scope, {
    providerId: prepared.pending.providerId,
    model: prepared.pending.model,
  }, prepared.action.reasoningEffort)
  if (!suggestion || authority.disposed() || !authority.revalidateSelection(prepared)) {
    return { kind: 'reject', reason: 'provider-preparation-failed' }
  }
  const confirmationId = authority.createId()
  if (!validText(confirmationId, 256) || confirmationId.length < 16 || authority.confirmations.has(confirmationId)) {
    return { kind: 'reject', reason: 'provider-preparation-failed' }
  }
  authority.confirmations.set(confirmationId, {
    ...prepared,
    id: confirmationId,
    logical: {
      forkAvailable: suggestion.forkAvailable,
      linkedAvailable: suggestion.linkedAvailable,
      channelBound: suggestion.channelBound,
      ...(suggestion.channelChallenge ? { channelChallenge: suggestion.channelChallenge } : {}),
    },
  })
  return { kind: 'confirm-logical', confirmationId, selectionRevision: prepared.selectionRevision, ...suggestion }
}

/** Consume a single-use confirmation and revalidate the granted mode before creating a destination. */
export function logicalSubmissionConfirmation(authority: {
  disposed(): boolean
  expire(): Promise<void>
  confirmations: Map<string, Confirmation>
  now(): number
  revalidateSelection(prepared: PreparedBase): boolean
  runtime: NativeSubmissionRuntimeAuthority
  prepareContinuation(
    prepared: PreparedBase,
    mode: DesktopLogicalMode,
    remember?: 'conversation' | 'profile' | 'inherit',
    channelCode?: string,
  ): Promise<NativeSubmissionPreparation>
}) {
  return async function confirmLogicalSubmission(
    input: Parameters<NativeSubmissionController['confirmLogicalSubmission']>[0],
  ): Promise<NativeSubmissionConfirmation> {
    if (authority.disposed()) return { kind: 'reject', reason: 'unknown-confirmation' }
    await authority.expire()
    const confirmation = authority.confirmations.get(input.confirmationId)
    if (!confirmation?.logical) return { kind: 'reject', reason: 'unknown-confirmation' }
    authority.confirmations.delete(confirmation.id)
    if (confirmation.expiresAt <= authority.now()) return { kind: 'reject', reason: 'expired-confirmation' }
    if (
      !sameScope(confirmation.scope, input.scope)
      || input.expectedSelectionRevision !== confirmation.selectionRevision
      || !authority.revalidateSelection(confirmation) || !await authority.runtime.revalidate(confirmation.scope, true)
      || input.mode === 'fork' && !confirmation.logical.forkAvailable
      || input.mode === 'linked' && !confirmation.logical.linkedAvailable
      || input.historyConsent !== (input.mode === 'linked' ? 'on-demand' : 'inherit')
      || !['linked', 'fork'].includes(input.mode)
      || input.remember !== undefined && !['conversation', 'profile', 'inherit'].includes(input.remember)
      || confirmation.logical.channelBound
        && (input.mode === 'fork' || !input.channelCode || input.channelCode !== confirmation.logical.channelChallenge
          || !/^[A-Za-z0-9_-]{32}$/u.test(input.channelCode))
      || !confirmation.logical.channelBound && input.channelCode !== undefined
    ) return { kind: 'reject', reason: 'stale-operation' }
    const result = await authority.prepareContinuation(confirmation, input.mode, input.remember, input.channelCode)
    if (result.kind === 'allow-original' && result.continuation) {
      return {
        kind: 'allow-logical-continuation',
        operationToken: result.operationToken,
        continuation: result.continuation,
      }
    }
    return {
      kind: 'reject',
      reason: result.kind === 'reject'
          && (result.reason === 'provider-switch-reconciliation-required'
            || result.reason === 'provider-switch-unsupported')
        ? result.reason
        : 'thread-switch-failed',
    }
  }
}
