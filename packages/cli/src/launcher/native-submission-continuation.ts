import { nativeThreadSwitchReason } from './native-thread-switch-error.js'
import { NativeThreadSwitchError } from './native-thread-switch-error.js'
import type { DesktopLogicalMode } from './desktop-logical-migration.js'
import { type PreparedBase, type PreparedOperation, validText } from './native-submission-records.js'
import type {
  NativeSubmissionControllerOptions,
  NativeSubmissionPreparation,
} from './native-submission-controller-contracts.js'

interface ContinuationAdmission {
  readonly options: NativeSubmissionControllerOptions
  readonly operations: Map<string, PreparedOperation>
  readonly operationTtlMs: number
  readonly logicalMode?: DesktopLogicalMode
  readonly remember?: 'conversation' | 'profile' | 'inherit'
  readonly channelCode?: string
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
    (!authority.logicalMode && !options.existingThread.continue)
    || (authority.logicalMode && !options.logicalMigration) || !options.selection.commitContinuation
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
  let logicalCommitted = false
  try {
    if (
      authority.disposed() || !authority.revalidate(operation)
      || !await options.runtime.revalidate(operation.scope, true)
    ) throw new Error('Native continuation source changed')
    let fork: { threadId: string }
    if (authority.logicalMode) {
      operation.logicalContinuation = true
      const result = await options.logicalMigration!.continue({
        scope: prepared.scope,
        operationId: prepared.action.operationId,
        target: { providerId: prepared.pending.providerId, model: prepared.pending.model },
        mode: authority.logicalMode,
        ...(authority.remember ? { remember: authority.remember } : {}),
        ...(authority.channelCode ? { channelCode: authority.channelCode } : {}),
        current: () => !authority.disposed() && authority.revalidate(operation),
        configOverrides: operation.configOverrides,
      })
      if (!result || result.state === 'unknown' || result.state === 'applied' && !result.navigationReady) {
        throw new NativeThreadSwitchError('provider-switch-reconciliation-required')
      }
      if (result.state !== 'applied') throw new Error('Logical continuation rejected')
      logicalCommitted = true
      fork = { threadId: result.destination.sessionId }
    } else {
      fork = await options.existingThread.continue!({
        scope: prepared.scope,
        threadId: prepared.scope.threadId!,
        providerId: prepared.pending.providerId,
        model: prepared.pending.model,
        configOverrides: operation.configOverrides,
        operationToken: operation.token,
      })
    }
    if (!validText(fork.threadId, 512) || fork.threadId === prepared.scope.threadId) {
      throw new Error('Native continuation identity differed')
    }
    operation.continuationThreadId = fork.threadId
    if (
      authority.disposed() || operations.get(operation.token) !== operation || !authority.revalidate(operation)
      || !await options.runtime.revalidate(operation.scope, true) || !await authority.validateLease(operation)
    ) {
      if (operations.get(operation.token) !== operation && !operation.logicalContinuation) {
        await options.existingThread.discardContinuation?.({ threadId: fork.threadId, operationToken: operation.token })
      }
      throw new Error('Native continuation admission changed')
    }
    if (
      authority.logicalMode === 'linked'
      && !await options.logicalTurns?.attach(prepared.scope, fork.threadId, operation.token)
    ) {
      throw new NativeThreadSwitchError('provider-switch-reconciliation-required')
    }
    operation.expiresAt = authority.now() + authority.operationTtlMs
    return {
      kind: 'allow-original',
      operationToken: operation.token,
      continuation: { sourceThreadId: prepared.scope.threadId!, threadId: fork.threadId },
    }
  } catch (error) {
    await authority.release(operation)
    return {
      kind: 'reject',
      reason: logicalCommitted
        ? 'provider-switch-reconciliation-required'
        : nativeThreadSwitchReason(error) ?? 'provider-preparation-failed',
    }
  }
}
