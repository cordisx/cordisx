import { nativeThreadSwitchReason } from './native-thread-switch-error.js'
import { type PreparedBase, type PreparedOperation, validText } from './native-submission-records.js'
import type {
  NativeSubmissionControllerOptions,
  NativeSubmissionPreparation,
} from './native-submission-controller-contracts.js'

interface ContinuationAdmission {
  readonly options: NativeSubmissionControllerOptions
  readonly operations: Map<string, PreparedOperation>
  readonly operationTtlMs: number
  now(): number
  disposed(): boolean
  prepare(prepared: PreparedBase): Promise<PreparedOperation | undefined>
  revalidate(prepared: PreparedBase): boolean
  validateLease(operation: PreparedOperation): Promise<boolean>
  release(operation: PreparedOperation): Promise<void>
}

/** Owns the fork admission; credential and request lifetimes remain in the submission controller. */
export async function prepareNativeContinuation(
  prepared: PreparedBase,
  authority: ContinuationAdmission,
): Promise<NativeSubmissionPreparation> {
  const { options, operations } = authority
  if (
    !options.existingThread.continue || !options.selection.commitContinuation
    || prepared.action.continuationAvailable !== true
  ) {
    return { kind: 'reject', reason: 'provider-switch-unsupported' }
  }
  if ([...operations.values()].some(operation => operation.scopeKey === prepared.scopeKey)) {
    return { kind: 'reject', reason: 'stale-operation' }
  }
  const operation = await authority.prepare(prepared)
  if (operation === undefined) return { kind: 'reject', reason: 'stale-operation' }
  if ([...operations.values()].some(current => current.scopeKey === prepared.scopeKey)) {
    await operation.credential.dispose()
    return { kind: 'reject', reason: 'stale-operation' }
  }
  operations.set(operation.token, operation)
  try {
    if (
      authority.disposed() || !authority.revalidate(operation)
      || !await options.runtime.revalidate(operation.scope, true)
    ) throw new Error('Native continuation source changed')
    const fork = await options.existingThread.continue({
      scope: prepared.scope,
      threadId: prepared.scope.threadId!,
      providerId: prepared.pending.providerId,
      model: prepared.pending.model,
      configOverrides: operation.configOverrides,
      operationToken: operation.token,
    })
    if (!validText(fork.threadId, 512) || fork.threadId === prepared.scope.threadId) {
      throw new Error('Native continuation identity differed')
    }
    operation.continuationThreadId = fork.threadId
    if (
      authority.disposed() || operations.get(operation.token) !== operation || !authority.revalidate(operation)
      || !await options.runtime.revalidate(operation.scope, true) || !await authority.validateLease(operation)
    ) {
      if (operations.get(operation.token) !== operation) {
        await options.existingThread.discardContinuation?.({ threadId: fork.threadId, operationToken: operation.token })
      }
      throw new Error('Native continuation admission changed')
    }
    operation.expiresAt = authority.now() + authority.operationTtlMs
    return {
      kind: 'allow-original',
      operationToken: operation.token,
      continuation: { sourceThreadId: prepared.scope.threadId!, threadId: fork.threadId },
    }
  } catch (error) {
    await authority.release(operation)
    return { kind: 'reject', reason: nativeThreadSwitchReason(error) ?? 'provider-preparation-failed' }
  }
}
