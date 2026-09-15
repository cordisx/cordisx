import { randomUUID } from 'node:crypto'

import {
  decideNativeProviderSubmission,
  type NativeProviderSelection,
  type NormalizedNativeSubmissionAction,
  type PendingNativeProviderChange,
  revalidatePreparedNativeProviderChange,
} from '../renderer/native-provider-submission-policy.js'

export interface NativeProviderCredentialLease {
  readonly serviceGeneration: string
  readonly endpoint: Readonly<{ baseUrl: string; wireApi: 'responses' }>
  readonly auth:
    | Readonly<{ scheme: 'none' }>
    | Readonly<{
      scheme: 'bearer-command'
      command: string
      args: readonly string[]
      cwd: string
      timeoutMs: number
      refreshIntervalMs: number
    }>
  dispose(): void | Promise<void>
}

export interface NativeProviderCredentialBroker {
  prepare(providerId: string): Promise<NativeProviderCredentialLease>
}

/** Exact renderer/document owner for every private submission record. */
export interface NativeSubmissionScope {
  readonly targetId: string
  readonly rendererGeneration: string
  readonly navigationGeneration: number
  readonly threadId?: string
}

export interface NativeSubmissionSelectionSnapshot {
  readonly revision: number
  readonly effective: NativeProviderSelection
  readonly pending?: PendingNativeProviderChange
}

export interface NativeSubmissionSelectionAuthority {
  snapshot(scope: NativeSubmissionScope): NativeSubmissionSelectionSnapshot
  adoptScope(source: NativeSubmissionScope, target: NativeSubmissionScope): boolean
  commitEffective(
    input: Readonly<{
      scope: NativeSubmissionScope
      sourceScope?: NativeSubmissionScope
      expectedRevision: number
      pendingGeneration: number
      selection: NativeProviderSelection
    }>,
  ): boolean
  clearPending(
    input: Readonly<{
      scope: NativeSubmissionScope
      expectedRevision: number
      pendingGeneration: number
    }>,
  ): boolean
}

export interface NativeSubmissionRuntimeAuthority {
  /** Revalidates the exact target generation and, when requested, authoritative thread idleness. */
  revalidate(scope: NativeSubmissionScope, requireIdle: boolean, createdFrom?: NativeSubmissionScope): Promise<boolean>
  resolveCreatedScope(draft: NativeSubmissionScope, threadId: string): Promise<NativeSubmissionScope | undefined>
}

export interface NativeExistingThreadSwitch {
  /** Resolves only after unsubscribe/resume and native effective-selection acknowledgement. */
  switch(
    input: Readonly<{
      scope: NativeSubmissionScope
      threadId: string
      providerId: string
      model: string
      /** Host-private only. Never return this value through the renderer command API. */
      configOverrides: Readonly<Record<string, unknown>>
      serviceGeneration: string
    }>,
  ): Promise<void>
}

export type NativeSubmissionPreparation =
  | Readonly<{ kind: 'pass-through' }>
  | Readonly<{ kind: 'allow-original'; operationToken: string }>
  | Readonly<{ kind: 'confirm'; confirmationId: string; selectionRevision: number }>
  | Readonly<{
    kind: 'reject'
    reason: 'unsupported-submission-intent' | 'scope-mismatch' | 'stale-operation' | 'provider-preparation-failed'
  }>

export type NativeSubmissionConfirmation =
  | Readonly<{
    kind: 'allow-original'
    operationToken: string
    projection: Readonly<{
      available: true
      revision: number
      effective: NativeProviderSelection
    }>
  }>
  | Readonly<{
    kind: 'reject'
    reason: 'unknown-confirmation' | 'expired-confirmation' | 'stale-operation' | 'thread-switch-failed'
  }>

export interface NativeMarkedRequest {
  readonly method: 'thread/start' | 'turn/start'
  readonly operationToken: string
  readonly requestId: string | number
  readonly threadId?: string
}

export interface NativeReservedRequest {
  readonly operationToken: string
  readonly requestId: string | number
}

/** Host-internal result for the eventual pre-dispatch request mutator. */
export type NativeMarkedRequestConsumption =
  | Readonly<{
    kind: 'dispatch'
    configOverrides: Readonly<Record<string, unknown>>
    providerId: string
    model: string
    serviceGeneration: string
  }>
  | Readonly<{
    kind: 'reject'
    reason: 'unknown-token' | 'expired-token' | 'stale-operation' | 'request-mismatch' | 'scope-mismatch'
  }>

export interface NativeSubmissionController {
  readonly nativeManagedModelRoutingAvailable: false
  commitSelection(scope: NativeSubmissionScope): Promise<
    | Readonly<{
      kind: 'accepted'
      projection: Readonly<{
        available: true
        revision: number
        effective: NativeProviderSelection
      }>
    }>
    | Readonly<{ kind: 'reject'; reason: 'stale-operation' | 'thread-switch-failed' }>
  >
  prepareSubmission(
    scope: NativeSubmissionScope,
    action: NormalizedNativeSubmissionAction,
  ): Promise<NativeSubmissionPreparation>
  confirmSubmission(
    input: Readonly<{
      scope: NativeSubmissionScope
      confirmationId: string
      expectedSelectionRevision: number
    }>,
  ): Promise<NativeSubmissionConfirmation>
  consumeMarkedRequest(request: NativeMarkedRequest): Promise<NativeMarkedRequestConsumption>
  authorizeMarkedRequest(request: NativeReservedRequest): Promise<boolean>
  completeMarkedRequest(
    input: Readonly<{
      operationToken: string
      requestId: string | number
      succeeded: boolean
      /** Stable native response id, joined with the token's private document scope. */
      boundThreadId?: string
    }>,
  ): Promise<void>
  cancel(input: Readonly<{ scope: NativeSubmissionScope; id: string }>): Promise<boolean>
  releaseScope(scope: NativeSubmissionScope): Promise<void>
  releaseThread(threadId: string): Promise<void>
  dispose(): Promise<void>
}

export interface NativeSubmissionControllerOptions {
  readonly selection: NativeSubmissionSelectionAuthority
  readonly credentials: NativeProviderCredentialBroker
  readonly runtime: NativeSubmissionRuntimeAuthority
  readonly existingThread: NativeExistingThreadSwitch
  readonly operationTtlMs?: number
  readonly confirmationTtlMs?: number
  readonly now?: () => number
  readonly createId?: () => string
}

interface PreparedBase {
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
  readonly credential: Pick<NativeProviderCredentialLease, 'serviceGeneration' | 'dispose'>
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
  readonly credential: Pick<NativeProviderCredentialLease, 'serviceGeneration' | 'dispose'>
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

function providerConfig(lease: NativeProviderCredentialLease): Readonly<Record<string, unknown>> {
  const baseUrl = new URL(lease.endpoint.baseUrl)
  const loopback = baseUrl.hostname === '127.0.0.1'
    || baseUrl.hostname === 'localhost'
    || baseUrl.hostname === '[::1]'
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username !== '' || baseUrl.password !== ''
    || baseUrl.hash !== '' || lease.endpoint.wireApi !== 'responses'
    || (baseUrl.protocol === 'http:' && !loopback)
  ) throw new Error('native provider credential lease endpoint is invalid')
  if (lease.auth.scheme === 'none') {
    return Object.freeze({
      name: 'CordisX managed provider',
      base_url: lease.endpoint.baseUrl,
      wire_api: 'responses',
      requires_openai_auth: false,
    })
  }
  if (
    !validText(lease.auth.command, 4_096)
    || !validText(lease.auth.cwd, 4_096)
    || lease.auth.args.some(argument => argument.length > 16_384 || argument.includes('\0'))
    || !Number.isSafeInteger(lease.auth.timeoutMs) || lease.auth.timeoutMs < 1 || lease.auth.timeoutMs > 60_000
    || !Number.isSafeInteger(lease.auth.refreshIntervalMs)
    || lease.auth.refreshIntervalMs < 1 || lease.auth.refreshIntervalMs > 60_000
  ) throw new Error('native provider credential command is invalid')
  return Object.freeze({
    name: 'CordisX managed provider',
    base_url: lease.endpoint.baseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    auth: Object.freeze({
      command: lease.auth.command,
      args: Object.freeze([...lease.auth.args]),
      cwd: lease.auth.cwd,
      timeout_ms: lease.auth.timeoutMs,
      refresh_interval_ms: lease.auth.refreshIntervalMs,
    }),
  })
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
    [`model_providers.${pending.providerId}`]: providerConfig(lease),
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
  const createId = options.createId ?? randomUUID
  const confirmations = new Map<string, Confirmation>()
  const operations = new Map<string, PreparedOperation>()
  const bindings = new Map<string, ActiveBinding>()
  let disposed = false

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
    return snapshot.revision === prepared.selectionRevision
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
      return snapshot.revision === operation.selectionRevision && snapshot.pending === undefined
        && snapshot.effective.providerId === operation.pending.providerId
        && snapshot.effective.model === operation.pending.model
    } catch {
      return false
    }
  }
  const prepareOperation = async (prepared: PreparedBase): Promise<PreparedOperation | undefined> => {
    let credential: Pick<NativeProviderCredentialLease, 'serviceGeneration' | 'dispose'> | undefined
    try {
      let configOverrides: Readonly<Record<string, unknown>>
      if (prepared.pending.providerId === 'openai') {
        // The built-in provider owns its auth and endpoint. Never synthesize a managed provider table.
        credential = { serviceGeneration: 'native-openai', dispose() {} }
        configOverrides = Object.freeze({ model_provider: 'openai', model: prepared.pending.model })
      } else {
        const managed = await options.credentials.prepare(prepared.pending.providerId)
        credential = managed
        configOverrides = requestConfig(prepared.pending, managed)
      }
      if (disposed || !revalidateSelection(prepared)) {
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

  return {
    nativeManagedModelRoutingAvailable: false,
    async commitSelection(scope) {
      if (disposed || scope.threadId === undefined) return { kind: 'reject', reason: 'stale-operation' }
      await expire()
      const snapshot = options.selection.snapshot(scope)
      const pending = snapshot.pending
      if (pending === undefined || pending.threadId !== scope.threadId) {
        return { kind: 'reject', reason: 'stale-operation' }
      }
      const prepared: PreparedBase = {
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
        clearSelection()
        return { kind: 'reject', reason: 'thread-switch-failed' }
      }
      try {
        if (!await options.runtime.revalidate(scope, true) || disposed || !revalidateSelection(prepared)) {
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
        clearSelection()
        if (![...bindings.values()].some(binding => binding.credential === operation.credential)) {
          await operation.credential.dispose()
        }
        return { kind: 'reject', reason: 'thread-switch-failed' }
      }
    },
    async prepareSubmission(scope, action) {
      if (disposed) return { kind: 'reject', reason: 'stale-operation' }
      const key = scopeKey(scope)
      if (scope.threadId !== action.threadId) return { kind: 'reject', reason: 'scope-mismatch' }
      await expire()
      const snapshot = options.selection.snapshot(scope)
      clearMismatchedPending(scope, snapshot)
      if (snapshot.pending !== undefined && snapshot.pending.threadId !== scope.threadId) {
        return { kind: 'reject', reason: 'scope-mismatch' }
      }
      const decision = decideNativeProviderSubmission(snapshot.pending, action)
      if (decision.kind === 'pass-through') return { kind: 'pass-through' }
      if (decision.kind === 'reject') return { kind: 'reject', reason: decision.reason }
      const prepared: PreparedBase = {
        scope,
        scopeKey: key,
        action,
        pending: decision.prepared.pending,
        selectionRevision: snapshot.revision,
        expiresAt: now() + (scope.threadId === undefined ? operationTtlMs : confirmationTtlMs),
      }
      if (scope.threadId === undefined) {
        const operation = await prepareOperation(prepared)
        if (operation === undefined) return { kind: 'reject', reason: 'provider-preparation-failed' }
        operations.set(operation.token, operation)
        return { kind: 'allow-original', operationToken: operation.token }
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
      const operation = await prepareOperation(confirmation)
      if (operation === undefined) return { kind: 'reject', reason: 'stale-operation' }
      try {
        if (
          !await options.runtime.revalidate(confirmation.scope, true) || disposed || !revalidateSelection(confirmation)
        ) {
          throw new Error('native thread changed before switch')
        }
        await options.existingThread.switch({
          scope: confirmation.scope,
          threadId: confirmation.scope.threadId!,
          providerId: confirmation.pending.providerId,
          model: confirmation.pending.model,
          configOverrides: operation.configOverrides,
          serviceGeneration: operation.serviceGeneration,
        })
        // Resume already changed the live thread, even if its subsequent Send is cancelled.
        await replaceBinding({
          threadId: confirmation.scope.threadId!,
          selection: confirmation.pending,
          serviceGeneration: operation.serviceGeneration,
          credential: operation.credential,
        })
        if (!revalidateSelection(confirmation)) throw new Error('selection changed during native thread switch')
        if (
          !options.selection.commitEffective({
            scope: confirmation.scope,
            expectedRevision: confirmation.selectionRevision,
            pendingGeneration: confirmation.pending.selectionGeneration,
            selection: confirmation.pending,
          })
        ) throw new Error('native effective selection commit was stale')
        const effective = options.selection.snapshot(confirmation.scope)
        if (
          effective.effective.providerId !== confirmation.pending.providerId
          || effective.effective.model !== confirmation.pending.model
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
      const key = bindingKey(threadId)
      const binding = bindings.get(key)
      if (binding === undefined) return
      bindings.delete(key)
      await binding.credential.dispose()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      confirmations.clear()
      await Promise.allSettled([
        ...[...operations.values()].map(releaseOperation),
        ...[...bindings.values()].map(async binding => await binding.credential.dispose()),
      ])
      bindings.clear()
    },
  }
}
