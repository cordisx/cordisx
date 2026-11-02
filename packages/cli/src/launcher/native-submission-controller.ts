import type { RemotePreparedProvider } from './remote-terminal-provider-client.js'
import { nativeProviderConfig } from './native-provider-config.js'
export { nativeProviderConfig } from './native-provider-config.js'
import { randomUUID } from 'node:crypto'

import {
  decideNativeProviderSubmission,
  type NativeProviderSelection,
  type NormalizedNativeSubmissionAction,
  type PendingNativeProviderChange,
  revalidatePreparedNativeProviderChange,
} from '../renderer/native-provider-submission-policy.js'

export type {
  NativeExistingThreadSwitch,
  NativeMarkedRequest,
  NativeMarkedRequestConsumption,
  NativeProviderCredentialBroker,
  NativeProviderCredentialLease,
  NativeReservedRequest,
  NativeSubmissionConfirmation,
  NativeSubmissionController,
  NativeSubmissionControllerOptions,
  NativeSubmissionPreparation,
  NativeSubmissionRuntimeAuthority,
  NativeSubmissionScope,
  NativeSubmissionSelectionAuthority,
  NativeSubmissionSelectionSnapshot,
  NativeThreadResumePreparation,
} from './native-submission-controller-contracts.js'
import type {
  NativeMarkedRequest,
  NativeProviderCredentialLease,
  NativeSubmissionConfirmation,
  NativeSubmissionController,
  NativeSubmissionControllerOptions,
  NativeSubmissionScope,
  NativeSubmissionSelectionSnapshot,
} from './native-submission-controller-contracts.js'

type SubmissionLease =
  & Pick<NativeProviderCredentialLease, 'serviceGeneration' | 'dispose'>
  & Partial<Pick<RemotePreparedProvider, 'validate' | 'provider'>>

interface PreparedBase {
  readonly intentGeneration?: number
  readonly scope: NativeSubmissionScope
  readonly scopeKey: string
  readonly action: NormalizedNativeSubmissionAction
  readonly pending: PendingNativeProviderChange
  readonly selectionRevision: number
  readonly expiresAt: number
}

interface Confirmation extends PreparedBase {
  readonly id: string
}

interface PreparedOperation extends PreparedBase {
  readonly token: string
  readonly configOverrides: Readonly<Record<string, unknown>>
  readonly serviceGeneration: string
  readonly credential: SubmissionLease
  selectionRevision: number
  expiresAt: number
  selectionState: 'pending' | 'effective'
  state: 'available' | 'reserved' | 'consumed'
  request?: Readonly<{
    key: string
    method: NativeMarkedRequest['method']
    threadId?: string
  }>
  boundScope?: NativeSubmissionScope
}

interface ActiveBinding {
  readonly threadId: string
  readonly selection: NativeProviderSelection
  readonly serviceGeneration: string
  readonly credential: SubmissionLease
}

interface PreparedThreadResume extends ActiveBinding {
  readonly token: string
}

const DEFAULT_OPERATION_TTL_MS = 120_000
const DEFAULT_CONFIRMATION_TTL_MS = 300_000

function scopeKey(scope: NativeSubmissionScope): string {
  if (
    scope.targetId.length === 0 || scope.targetId.length > 512
    || scope.rendererGeneration.length === 0 || scope.rendererGeneration.length > 256
    || !Number.isSafeInteger(scope.navigationGeneration) || scope.navigationGeneration < 0
    || scope.threadId?.length === 0 || (scope.threadId?.length ?? 0) > 512
  ) throw new Error('native submission scope is invalid')
  return JSON.stringify([scope.targetId, scope.rendererGeneration, scope.navigationGeneration, scope.threadId ?? null])
}

function sameScope(left: NativeSubmissionScope, right: NativeSubmissionScope): boolean {
  return scopeKey(left) === scopeKey(right)
}

function validText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
}

function requestKey(requestId: string | number): string {
  if (
    (typeof requestId === 'string' && validText(requestId, 512))
    || (typeof requestId === 'number' && Number.isSafeInteger(requestId))
  ) return JSON.stringify([typeof requestId, requestId])
  throw new Error('native request id is invalid')
}

function bindingKey(threadId: string): string {
  if (!validText(threadId, 512)) throw new Error('native thread binding is invalid')
  return threadId
}

function requestConfig(
  pending: PendingNativeProviderChange,
  lease: NativeProviderCredentialLease,
): Readonly<Record<string, unknown>> {
  if (
    !validText(pending.providerId, 128) || !validText(pending.model, 512)
    || !validText(lease.serviceGeneration, 256)
  ) throw new Error('native provider selection or service generation is invalid')
  return Object.freeze({
    model_provider: pending.providerId,
    model: pending.model,
    [`model_providers.${pending.providerId}`]: nativeProviderConfig(lease),
  })
}

/** Host-only, target-scoped, non-persistent native submission authority. */
export function createNativeSubmissionController(
  options: NativeSubmissionControllerOptions,
): NativeSubmissionController {
  const operationTtlMs = options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS
  const confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS
  if (!Number.isSafeInteger(operationTtlMs) || operationTtlMs < 1 || operationTtlMs > 600_000) {
    throw new Error('native submission operation TTL is invalid')
  }
  if (!Number.isSafeInteger(confirmationTtlMs) || confirmationTtlMs < 1 || confirmationTtlMs > 3_600_000) {
    throw new Error('native submission confirmation TTL is invalid')
  }
  const now = options.now ?? Date.now
  const validSelection = async (selection: NativeProviderSelection): Promise<boolean> => {
    try {
      const startup = options.startup?.availability(selection.providerId, selection.model)
      return startup?.available === false ? false : await options.validateSelection?.(selection) ?? true
    } catch {
      return false
    }
  }
  const createId = options.createId ?? randomUUID
  const confirmations = new Map<string, Confirmation>()
  const operations = new Map<string, PreparedOperation>()
  const bindings = new Map<string, ActiveBinding>()
  const threadResumes = new Map<string, PreparedThreadResume>()
  let disposed = false
  const preparations = new Map<AbortController, NativeSubmissionScope>()
  const validateLease = async (lease: SubmissionLease): Promise<boolean> => {
    try {
      return await lease.validate?.() ?? true
    } catch {
      return false
    }
  }
  const prepareRemote = async (
    selection: NativeProviderSelection,
    scope: NativeSubmissionScope,
  ): Promise<RemotePreparedProvider> => {
    const abort = new AbortController()
    preparations.set(abort, scope)
    try {
      if (disposed || !options.prepareRemoteProvider) throw new Error('Remote provider unavailable')
      return await options.prepareRemoteProvider(selection, abort.signal)
    } finally {
      preparations.delete(abort)
    }
  }
  const remoteConfig = (selection: NativeProviderSelection, lease: SubmissionLease) =>
    Object.freeze({
      model_provider: selection.providerId,
      model: selection.model,
      [`model_providers.${selection.providerId}`]: lease.provider,
    })

  const releaseOperation = async (operation: PreparedOperation): Promise<void> => {
    if (operations.get(operation.token) !== operation) return
    operations.delete(operation.token)
    if ([...bindings.values()].some(binding => binding.credential === operation.credential)) return
    await operation.credential.dispose()
  }
  const replaceBinding = async (binding: ActiveBinding): Promise<void> => {
    const key = bindingKey(binding.threadId)
    const prior = bindings.get(key)
    bindings.set(key, binding)
    if (prior !== undefined && prior.credential !== binding.credential) await prior.credential.dispose()
  }
  const expire = async (): Promise<void> => {
    const time = now()
    for (const [id, confirmation] of confirmations) {
      if (confirmation.expiresAt <= time) confirmations.delete(id)
    }
    for (const operation of [...operations.values()]) {
      if (operation.state === 'available' && operation.expiresAt <= time) await releaseOperation(operation)
    }
  }
  const revalidateSelection = (prepared: PreparedBase): boolean => {
    const snapshot = options.selection.snapshot(prepared.scope)
    return snapshot.pendingProviderIntent?.generation === prepared.intentGeneration
      && snapshot.revision === prepared.selectionRevision
      && revalidatePreparedNativeProviderChange(
          { pending: prepared.pending, action: prepared.action },
          { action: prepared.action, ...(snapshot.pending === undefined ? {} : { pending: snapshot.pending }) },
        ).kind === 'dispatch'
  }
  const revalidateOperationSelection = (
    operation: PreparedOperation,
    currentScope: NativeSubmissionScope,
  ): boolean => {
    try {
      if (operation.selectionState === 'pending') return revalidateSelection(operation)
      const snapshot = options.selection.snapshot(currentScope)
      return snapshot.pendingProviderIntent === undefined
        && snapshot.revision === operation.selectionRevision && snapshot.pending === undefined
        && snapshot.effective.providerId === operation.pending.providerId
        && snapshot.effective.model === operation.pending.model
    } catch {
      return false
    }
  }
  const prepareOperation = async (prepared: PreparedBase): Promise<PreparedOperation | undefined> => {
    let credential: SubmissionLease | undefined
    try {
      if (!await validSelection(prepared.pending) || !revalidateSelection(prepared)) return undefined
      let configOverrides: Readonly<Record<string, unknown>>
      const source = prepared.pending.providerId === 'openai'
        ? 'openai'
        : options.providerSource?.(prepared.pending.providerId)
      if (source === 'openai' || source === 'config') {
        // Codex owns built-in and config-backed authentication. Never synthesize a managed provider table.
        credential = { serviceGeneration: `native-${source}`, dispose() {} }
        configOverrides = Object.freeze({
          ...(source === 'config' ? await options.prepareConfiguredProvider?.(prepared.pending.providerId) : {}),
          model_provider: prepared.pending.providerId,
          model: prepared.pending.model,
          ...(prepared.action.reasoningEffort === undefined
            ? {}
            : { model_reasoning_effort: prepared.action.reasoningEffort }),
        })
      } else if (source === 'remote') {
        credential = await prepareRemote(prepared.pending, prepared.scope)
        configOverrides = Object.freeze({
          ...remoteConfig(prepared.pending, credential),
          ...(prepared.action.reasoningEffort === undefined
            ? {}
            : { model_reasoning_effort: prepared.action.reasoningEffort }),
        })
      } else if (source === 'managed' || options.providerSource === undefined) {
        const managed = await options.credentials.prepare(prepared.pending.providerId)
        credential = managed
        configOverrides = Object.freeze({
          ...requestConfig(prepared.pending, managed),
          ...(prepared.action.reasoningEffort === undefined
            ? {}
            : { model_reasoning_effort: prepared.action.reasoningEffort }),
        })
      } else throw new Error('native provider is unknown')
      if (disposed || !revalidateSelection(prepared) || !await validateLease(credential)) {
        await credential.dispose()
        return undefined
      }
      const token = createId()
      if (!validText(token, 256) || token.length < 16 || operations.has(token)) {
        await credential.dispose()
        return undefined
      }
      return {
        ...prepared,
        token,
        configOverrides,
        serviceGeneration: credential.serviceGeneration,
        credential,
        selectionState: 'pending',
        state: 'available',
      }
    } catch {
      await credential?.dispose()
      return undefined
    }
  }
  const clearMismatchedPending = (scope: NativeSubmissionScope, snapshot: NativeSubmissionSelectionSnapshot): void => {
    const pending = snapshot.pending
    if (pending === undefined || pending.threadId === scope.threadId) return
    options.selection.clearPending({
      scope,
      expectedRevision: snapshot.revision,
      pendingGeneration: pending.selectionGeneration,
    })
  }

  const applyPreparedThreadSelection = async (prepared: PreparedBase): Promise<NativeSubmissionConfirmation> => {
    const operation = await prepareOperation(prepared)
    if (operation === undefined) return { kind: 'reject', reason: 'stale-operation' }
    try {
      if (
        !await options.runtime.revalidate(prepared.scope, true) || !await validSelection(prepared.pending)
        || disposed || !revalidateSelection(prepared) || !await validateLease(operation.credential)
      ) {
        throw new Error('native thread changed before switch')
      }
      await options.existingThread.switch({
        scope: prepared.scope,
        threadId: prepared.scope.threadId!,
        providerId: prepared.pending.providerId,
        model: prepared.pending.model,
        configOverrides: operation.configOverrides,
        serviceGeneration: operation.serviceGeneration,
      })
      // Resume already changed the live thread, even if its subsequent Send is cancelled.
      await replaceBinding({
        threadId: prepared.scope.threadId!,
        selection: prepared.pending,
        serviceGeneration: operation.serviceGeneration,
        credential: operation.credential,
      })
      if (!revalidateSelection(prepared)) throw new Error('selection changed during native thread switch')
      if (
        !options.selection.commitEffective({
          scope: prepared.scope,
          expectedRevision: prepared.selectionRevision,
          pendingGeneration: prepared.pending.selectionGeneration,
          selection: prepared.pending,
        })
      ) throw new Error('native effective selection commit was stale')
      const effective = options.selection.snapshot(prepared.scope)
      if (
        effective.effective.providerId !== prepared.pending.providerId
        || effective.effective.model !== prepared.pending.model
        || effective.pending !== undefined
      ) throw new Error('native effective selection acknowledgement differed')
      operation.selectionRevision = effective.revision
      operation.selectionState = 'effective'
      operation.expiresAt = now() + operationTtlMs
      operations.set(operation.token, operation)
      return {
        kind: 'allow-original',
        operationToken: operation.token,
        projection: {
          available: true,
          revision: effective.revision,
          effective: effective.effective,
        },
      }
    } catch {
      if (![...bindings.values()].some(binding => binding.credential === operation.credential)) {
        await operation.credential.dispose()
      }
      return { kind: 'reject', reason: 'thread-switch-failed' }
    }
  }
  return {
    nativeManagedModelRoutingAvailable: false,
    async commitSelection(scope) {
      if (disposed || scope.threadId === undefined) return { kind: 'reject', reason: 'stale-operation' }
      await expire()
      const snapshot = options.selection.snapshot(scope)
      const pending = snapshot.pending
      const selected = pending ?? snapshot.effective
      const startup = options.startup?.availability(selected.providerId, selected.model)
      if (startup !== undefined && !startup.available) {
        return { kind: 'reject', reason: 'thread-switch-failed', startupReason: startup.reason }
      }
      if (pending === undefined || pending.threadId !== scope.threadId) {
        return { kind: 'reject', reason: 'stale-operation' }
      }
      const prepared: PreparedBase = {
        ...(snapshot.pendingProviderIntent ? { intentGeneration: snapshot.pendingProviderIntent.generation } : {}),
        scope,
        scopeKey: scopeKey(scope),
        action: {
          operationId: createId(),
          operationGeneration: pending.selectionGeneration,
          intent: 'ordinary-send',
          threadId: scope.threadId,
        },
        pending,
        selectionRevision: snapshot.revision,
        expiresAt: now() + operationTtlMs,
      }
      const clearSelection = (): void => {
        if (options.providerSource?.(pending.providerId) === 'remote') return
        if (options.startup?.availability(pending.providerId, pending.model)?.available === false) return
        options.selection.clearPending({
          scope,
          expectedRevision: snapshot.revision,
          pendingGeneration: pending.selectionGeneration,
        })
      }
      if (!await options.runtime.revalidate(scope, true)) {
        clearSelection()
        return { kind: 'reject', reason: 'stale-operation' }
      }
      const operation = await prepareOperation(prepared)
      if (operation === undefined) {
        if (!await validSelection(pending)) clearSelection()
        return { kind: 'reject', reason: 'thread-switch-failed' }
      }
      try {
        if (
          !await options.runtime.revalidate(scope, true) || !await validSelection(pending)
          || disposed || !revalidateSelection(prepared) || !await validateLease(operation.credential)
        ) {
          throw new Error('native thread changed before switch')
        }
        await options.existingThread.switch({
          scope,
          threadId: scope.threadId,
          providerId: pending.providerId,
          model: pending.model,
          configOverrides: operation.configOverrides,
          serviceGeneration: operation.serviceGeneration,
        })
        await replaceBinding({
          threadId: scope.threadId,
          selection: pending,
          serviceGeneration: operation.serviceGeneration,
          credential: operation.credential,
        })
        if (
          !revalidateSelection(prepared)
          || !options.selection.commitEffective({
            scope,
            expectedRevision: snapshot.revision,
            pendingGeneration: pending.selectionGeneration,
            selection: pending,
          })
        ) throw new Error('native effective selection commit was stale')
        const effective = options.selection.snapshot(scope)
        if (
          effective.pending !== undefined || effective.effective.providerId !== pending.providerId
          || effective.effective.model !== pending.model
        ) throw new Error('native effective selection acknowledgement differed')
        return {
          kind: 'accepted',
          projection: { available: true, revision: effective.revision, effective: effective.effective },
        }
      } catch {
        if (disposed || !revalidateSelection(prepared) || !await validSelection(pending)) clearSelection()
        if (![...bindings.values()].some(binding => binding.credential === operation.credential)) {
          await operation.credential.dispose()
        }
        return { kind: 'reject', reason: 'thread-switch-failed' }
      }
    },
    async prepareSubmission(scope, action) {
      if (disposed) return { kind: 'reject', reason: 'stale-operation' }
      const selected = options.selection.snapshot(scope)
      if (selected.pendingProviderIntent) return { kind: 'reject', reason: 'provider-preparation-failed' }
      const desired = selected.pending ?? selected.effective
      const startup = options.startup?.availability(desired.providerId, desired.model)
      if (startup !== undefined && !startup.available) {
        return { kind: 'reject', reason: 'provider-preparation-failed', startupReason: startup.reason }
      }
      const key = scopeKey(scope)
      if (scope.threadId !== action.threadId) return { kind: 'reject', reason: 'scope-mismatch' }
      await expire()
      const snapshot = options.selection.snapshot(scope)
      if (snapshot.pendingProviderIntent) return { kind: 'reject', reason: 'provider-preparation-failed' }
      clearMismatchedPending(scope, snapshot)
      if (snapshot.pending !== undefined && snapshot.pending.threadId !== scope.threadId) {
        return { kind: 'reject', reason: 'scope-mismatch' }
      }
      const decision = decideNativeProviderSubmission(snapshot.pending, action)
      if (decision.kind === 'pass-through') {
        if (options.providerSource?.(snapshot.effective.providerId) === 'remote') {
          if (!await validSelection(snapshot.effective) || !await options.runtime.revalidate(scope, true)) {
            return { kind: 'reject', reason: 'provider-preparation-failed' }
          }
          let credential: SubmissionLease | undefined
          let borrowed = false
          try {
            const binding = scope.threadId === undefined ? undefined : bindings.get(scope.threadId)
            borrowed = binding?.selection.providerId === snapshot.effective.providerId
              && binding?.selection.model === snapshot.effective.model
            credential = borrowed ? binding!.credential : await prepareRemote(snapshot.effective, scope)
            if (
              !await validateLease(credential) || disposed
              || options.selection.snapshot(scope).revision !== snapshot.revision
            ) {
              throw new Error('Remote effective selection changed')
            }
            if (!borrowed && scope.threadId !== undefined) {
              await options.existingThread.switch({
                scope,
                threadId: scope.threadId,
                providerId: snapshot.effective.providerId,
                model: snapshot.effective.model,
                configOverrides: remoteConfig(snapshot.effective, credential),
                serviceGeneration: credential.serviceGeneration,
              })
              if (
                disposed || options.selection.snapshot(scope).revision !== snapshot.revision
                || !await validateLease(credential)
              ) {
                throw new Error('Remote resume acknowledgement stale')
              }
            }
            const token = createId()
            operations.set(token, {
              scope,
              scopeKey: key,
              action,
              pending: { ...snapshot.effective, selectionGeneration: snapshot.revision },
              selectionRevision: snapshot.revision,
              expiresAt: now() + operationTtlMs,
              token,
              configOverrides: remoteConfig(snapshot.effective, credential),
              credential,
              serviceGeneration: credential.serviceGeneration,
              selectionState: 'effective',
              state: 'available',
            })
            return { kind: 'allow-original', operationToken: token }
          } catch {
            if (!borrowed) await credential?.dispose()
            return { kind: 'reject', reason: 'provider-preparation-failed' }
          }
        }
        if (!await validSelection(snapshot.effective)) {
          return { kind: 'reject', reason: 'provider-preparation-failed' }
        }
        const current = options.selection.snapshot(scope)
        if (disposed || current.revision !== snapshot.revision) return { kind: 'reject', reason: 'stale-operation' }
        return { kind: 'pass-through' }
      }
      if (decision.kind === 'reject') return { kind: 'reject', reason: decision.reason }
      const prepared: PreparedBase = {
        scope,
        scopeKey: key,
        action,
        pending: decision.prepared.pending,
        selectionRevision: snapshot.revision,
        expiresAt: now() + (scope.threadId === undefined ? operationTtlMs : confirmationTtlMs),
      }
      if (
        scope.threadId !== undefined && options.providerSource?.(prepared.pending.providerId) === 'remote'
        && prepared.pending.providerId === snapshot.effective.providerId
      ) {
        const result = await applyPreparedThreadSelection(prepared)
        return result.kind === 'allow-original' ? result : { kind: 'reject', reason: 'provider-preparation-failed' }
      }
      if (scope.threadId === undefined || decision.prepared.pending.providerId === snapshot.effective.providerId) {
        if (scope.threadId !== undefined && !await options.runtime.revalidate(scope, true)) {
          return { kind: 'reject', reason: 'stale-operation' }
        }
        const operation = await prepareOperation(prepared)
        if (operation === undefined) return { kind: 'reject', reason: 'provider-preparation-failed' }
        operations.set(operation.token, operation)
        return { kind: 'allow-original', operationToken: operation.token }
      }
      if (decision.prepared.pending.sendOnly) {
        const result = await applyPreparedThreadSelection(prepared)
        return result.kind === 'allow-original' ? result : { kind: 'reject', reason: 'provider-preparation-failed' }
      }
      const confirmationId = createId()
      if (!validText(confirmationId, 256) || confirmationId.length < 16 || confirmations.has(confirmationId)) {
        return { kind: 'reject', reason: 'provider-preparation-failed' }
      }
      confirmations.set(confirmationId, { ...prepared, id: confirmationId })
      return { kind: 'confirm', confirmationId, selectionRevision: snapshot.revision }
    },
    async confirmSubmission(input) {
      if (disposed) return { kind: 'reject', reason: 'unknown-confirmation' }
      await expire()
      const confirmation = confirmations.get(input.confirmationId)
      if (confirmation === undefined) return { kind: 'reject', reason: 'unknown-confirmation' }
      confirmations.delete(confirmation.id)
      if (!sameScope(confirmation.scope, input.scope)) return { kind: 'reject', reason: 'stale-operation' }
      if (confirmation.expiresAt <= now()) return { kind: 'reject', reason: 'expired-confirmation' }
      if (
        input.expectedSelectionRevision !== confirmation.selectionRevision
        || !revalidateSelection(confirmation)
        || !await options.runtime.revalidate(confirmation.scope, true)
      ) return { kind: 'reject', reason: 'stale-operation' }
      return applyPreparedThreadSelection(confirmation)
    },
    async consumeMarkedRequest(request) {
      if (disposed) return { kind: 'reject', reason: 'unknown-token' }
      const operation = operations.get(request.operationToken)
      if (operation === undefined || operation.state !== 'available') return { kind: 'reject', reason: 'unknown-token' }
      let markedRequestKey: string
      try {
        markedRequestKey = requestKey(request.requestId)
      } catch {
        await releaseOperation(operation)
        return { kind: 'reject', reason: 'request-mismatch' }
      }
      if (operation.expiresAt <= now()) {
        await releaseOperation(operation)
        return { kind: 'reject', reason: 'expired-token' }
      }
      const newThread = operation.scope.threadId === undefined && operation.boundScope === undefined
      const threadId = operation.boundScope?.threadId ?? operation.scope.threadId
      if (
        (newThread && (request.method !== 'thread/start' || request.threadId !== undefined))
        || (!newThread && (request.method !== 'turn/start' || request.threadId !== threadId))
      ) {
        await releaseOperation(operation)
        return { kind: 'reject', reason: 'request-mismatch' }
      }
      operation.state = 'reserved'
      operation.request = {
        key: markedRequestKey,
        method: request.method,
        ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      }
      if (operation.boundScope?.threadId !== undefined) {
        const adopted = await options.runtime.resolveCreatedScope(operation.scope, operation.boundScope.threadId)
        if (
          !adopted || disposed || operations.get(operation.token) !== operation
          || !options.selection.adoptScope(operation.boundScope, adopted)
        ) {
          await releaseOperation(operation)
          return { kind: 'reject', reason: 'request-mismatch' }
        }
        operation.boundScope = adopted
      }
      const currentScope = operation.boundScope ?? operation.scope
      if (
        disposed || operation.expiresAt <= now() || !revalidateOperationSelection(operation, currentScope)
        || !await validSelection(operation.pending) || !await validateLease(operation.credential)
        || !await options.runtime.revalidate(
          currentScope,
          true,
          operation.boundScope === undefined ? undefined : operation.scope,
        )
        || disposed || operation.expiresAt <= now()
        || operations.get(operation.token) !== operation || operation.state !== 'reserved'
        || !revalidateOperationSelection(operation, currentScope)
      ) {
        await releaseOperation(operation)
        return { kind: 'reject', reason: 'request-mismatch' }
      }
      return {
        kind: 'dispatch',
        configOverrides: operation.configOverrides,
        providerId: operation.pending.providerId,
        model: operation.pending.model,
        serviceGeneration: operation.serviceGeneration,
        ...(operation.action.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: operation.action.reasoningEffort }),
      }
    },
    async authorizeMarkedRequest(request) {
      if (disposed) return false
      const operation = operations.get(request.operationToken)
      let markedRequestKey: string
      try {
        markedRequestKey = requestKey(request.requestId)
      } catch {
        return false
      }
      if (
        operation === undefined || operation.state !== 'reserved'
        || operation.request?.key !== markedRequestKey
      ) return false
      const currentScope = operation.boundScope ?? operation.scope
      if (
        operation.expiresAt <= now() || !revalidateOperationSelection(operation, currentScope)
        || !await validSelection(operation.pending) || !await validateLease(operation.credential)
        || !await options.runtime.revalidate(
          currentScope,
          true,
          operation.boundScope === undefined ? undefined : operation.scope,
        )
        || disposed || operation.expiresAt <= now()
        || operations.get(operation.token) !== operation || operation.state !== 'reserved'
        || operation.request.key !== markedRequestKey
        || !revalidateOperationSelection(operation, currentScope)
      ) {
        await releaseOperation(operation)
        return false
      }
      operation.state = 'consumed'
      return true
    },
    async completeMarkedRequest(input) {
      const operation = operations.get(input.operationToken)
      if (operation === undefined) return
      let completedRequestKey: string
      try {
        completedRequestKey = requestKey(input.requestId)
      } catch {
        return
      }
      if (operation.request?.key !== completedRequestKey) return
      if (!input.succeeded) {
        await releaseOperation(operation)
        return
      }
      if (operation.state !== 'consumed') return
      if (operation.selectionState === 'effective') {
        if (operation.credential.validate) {
          const bound = operation.scope.threadId === undefined
            ? input.boundThreadId === undefined
              ? undefined
              : await options.runtime.resolveCreatedScope(operation.scope, input.boundThreadId)
            : operation.scope
          if (bound?.threadId && await options.runtime.revalidate(bound, false, operation.scope)) {
            await replaceBinding({
              threadId: bound.threadId,
              selection: operation.pending,
              serviceGeneration: operation.serviceGeneration,
              credential: operation.credential,
            })
          } else await releaseOperation(operation)
        }
        operations.delete(operation.token)
        return
      }
      const boundScope = operation.scope.threadId === undefined
        ? input.boundThreadId === undefined
          ? undefined
          : await options.runtime.resolveCreatedScope(operation.scope, input.boundThreadId)
        : operation.scope
      if (
        boundScope?.threadId === undefined
        || !await options.runtime.revalidate(boundScope, false, operation.scope)
      ) {
        await operation.credential.dispose()
        operations.delete(operation.token)
        return
      }
      if (operation.selectionState === 'pending') {
        if (
          !revalidateSelection(operation)
          || !options.selection.commitEffective({
            scope: boundScope,
            sourceScope: operation.scope,
            expectedRevision: operation.selectionRevision,
            pendingGeneration: operation.pending.selectionGeneration,
            selection: operation.pending,
          })
        ) {
          await operation.credential.dispose()
          operations.delete(operation.token)
          return
        }
        const effective = options.selection.snapshot(boundScope)
        if (
          effective.pending !== undefined || effective.effective.providerId !== operation.pending.providerId
          || effective.effective.model !== operation.pending.model
        ) {
          await operation.credential.dispose()
          operations.delete(operation.token)
          return
        }
        operation.selectionRevision = effective.revision
      }
      await replaceBinding({
        threadId: boundScope.threadId,
        selection: operation.pending,
        serviceGeneration: operation.serviceGeneration,
        credential: operation.credential,
      })
      operation.boundScope = boundScope
      operation.selectionState = 'effective'
      operation.state = 'available'
      delete operation.request
      operation.expiresAt = now() + operationTtlMs
    },
    async prepareThreadResume(input) {
      const startup = options.startup?.availability(input.providerId, input.model)
      if (startup !== undefined && !startup.available) {
        return { kind: 'reject', reason: 'provider-preparation-failed', startupReason: startup.reason }
      }
      if (
        disposed || input.providerId === 'openai' || !validText(input.providerId, 128)
        || !validText(input.model, 512) || !validText(input.threadId, 512)
      ) return { kind: 'reject', reason: 'unknown-provider' }
      const source = options.providerSource?.(input.providerId)
      if (input.managedOnly && source !== 'managed' && source !== 'remote') {
        return { kind: 'reject', reason: 'unknown-provider' }
      }
      if (options.providerSource !== undefined && source === undefined) {
        return { kind: 'reject', reason: 'unknown-provider' }
      }
      if (!await validSelection({ providerId: input.providerId, model: input.model })) {
        return { kind: 'reject', reason: 'unknown-provider' }
      }
      let credential: SubmissionLease | undefined
      try {
        let configOverrides: Readonly<Record<string, unknown>>
        if (source === 'remote') {
          const abort = new AbortController()
          preparations.set(abort, {
            targetId: 'remote-resume',
            rendererGeneration: input.threadId,
            navigationGeneration: 0,
            threadId: input.threadId,
          })
          try {
            credential = await options.prepareRemoteProvider!(input, abort.signal)
          } finally {
            preparations.delete(abort)
          }
          if (!await validateLease(credential)) throw new Error('Remote lease unavailable')
          configOverrides = remoteConfig(input, credential)
        } else if (source === 'config') {
          credential = { serviceGeneration: 'native-config', dispose() {} }
          configOverrides = Object.freeze(await options.prepareConfiguredProvider?.(input.providerId) ?? {})
        } else {
          const managed = await options.credentials.prepare(input.providerId)
          credential = managed
          configOverrides = Object.freeze({ [`model_providers.${input.providerId}`]: nativeProviderConfig(managed) })
        }
        if (disposed) throw new Error('native submission controller was disposed')
        const token = createId()
        if (!validText(token, 256) || token.length < 16 || threadResumes.has(token)) {
          throw new Error('native thread resume token is invalid')
        }
        threadResumes.set(token, {
          token,
          threadId: input.threadId,
          selection: { providerId: input.providerId, model: input.model },
          serviceGeneration: credential.serviceGeneration,
          credential,
        })
        return { kind: 'resume', resumeToken: token, configOverrides }
      } catch {
        if (credential !== undefined && ![...threadResumes.values()].some(resume => resume.credential === credential)) {
          await credential.dispose()
        }
        return { kind: 'reject', reason: 'provider-preparation-failed' }
      }
    },
    async completeThreadResume(input) {
      const resume = threadResumes.get(input.resumeToken)
      if (resume === undefined || resume.threadId !== input.threadId) return false
      threadResumes.delete(resume.token)
      if (!input.succeeded || disposed) {
        await resume.credential.dispose()
        return !disposed
      }
      if (!await validateLease(resume.credential)) {
        await resume.credential.dispose()
        return false
      }
      if (input.createdThreadId !== undefined && !validText(input.createdThreadId, 512)) {
        await resume.credential.dispose()
        return false
      }
      await replaceBinding({ ...resume, threadId: input.createdThreadId ?? resume.threadId })
      return true
    },
    async cancel(input) {
      const confirmation = confirmations.get(input.id)
      if (confirmation !== undefined && sameScope(confirmation.scope, input.scope)) {
        confirmations.delete(input.id)
        return true
      }
      const operation = operations.get(input.id)
      if (operation === undefined || !sameScope(operation.scope, input.scope) || operation.state !== 'available') {
        return false
      }
      await releaseOperation(operation)
      return true
    },
    async releaseScope(scope) {
      for (const [abort, owner] of preparations) if (sameScope(owner, scope)) abort.abort()
      const key = scopeKey(scope)
      for (const [id, confirmation] of confirmations) {
        if (confirmation.scopeKey === key) confirmations.delete(id)
      }
      await Promise.allSettled(
        [...operations.values()].filter(operation =>
          operation.scopeKey === key || (operation.boundScope !== undefined && sameScope(operation.boundScope, scope))
        ).map(releaseOperation),
      )
      let snapshot: NativeSubmissionSelectionSnapshot
      try {
        snapshot = options.selection.snapshot(scope)
      } catch {
        return
      }
      if (snapshot.pending !== undefined) {
        options.selection.clearPending({
          scope,
          expectedRevision: snapshot.revision,
          pendingGeneration: snapshot.pending.selectionGeneration,
        })
      }
    },
    async releaseThread(threadId) {
      for (const [abort, owner] of preparations) if (owner.threadId === threadId) abort.abort()
      const key = bindingKey(threadId)
      const binding = bindings.get(key)
      if (binding === undefined) return
      bindings.delete(key)
      await binding.credential.dispose()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const abort of preparations.keys()) abort.abort()
      confirmations.clear()
      await Promise.allSettled([
        ...[...operations.values()].map(releaseOperation),
        ...[...threadResumes.values()].map(async resume => await resume.credential.dispose()),
        ...[...bindings.values()].map(async binding => await binding.credential.dispose()),
      ])
      threadResumes.clear()
      bindings.clear()
    },
  }
}
