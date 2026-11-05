import type { RemotePreparedProvider } from './remote-terminal-provider-client.js'
import type { StartupActionReasonV1 } from '@cordisx/protocol/startup/v1'
import type { StartupProviderAdmission } from './startup-provider-admission.js'
import type { ModelReasoningEffort } from '../model-reasoning-capabilities.js'
import type {
  NativeProviderSelection,
  NormalizedNativeSubmissionAction,
  PendingNativeProviderChange,
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
  readonly composerId?: string
  readonly threadId?: string
}

export interface NativeSubmissionSelectionSnapshot {
  readonly revision: number
  readonly effective: NativeProviderSelection
  readonly pendingProviderIntent?: Readonly<{ providerId: string; generation: number }>
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
  /** Host-private document witness captured while the exact new composer is still live. */
  captureDraftDocument?(scope: NativeSubmissionScope): Promise<number | undefined>
  /** An admitted first-send may outlive its composer, but never its native document. */
  revalidateDraftDocument?(scope: NativeSubmissionScope, timeOrigin: number, requireIdle: boolean): Promise<boolean>
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
      /** Revalidate the initiating document/selection before restoring a rejected native switch. */
      revalidateRestoration?: () => Promise<boolean>
    }>,
  ): Promise<void>
}

export type NativeSubmissionPreparation =
  | Readonly<{ kind: 'pass-through' }>
  | Readonly<
    {
      kind: 'allow-original'
      operationToken: string
      projection?: NativeSubmissionSelectionSnapshot & { available: boolean }
    }
  >
  | Readonly<{ kind: 'confirm'; confirmationId: string; selectionRevision: number }>
  | Readonly<{
    kind: 'reject'
    startupReason?: StartupActionReasonV1
    reason:
      | 'unsupported-submission-intent'
      | 'scope-mismatch'
      | 'stale-operation'
      | 'provider-preparation-failed'
      | import('./native-thread-switch-error.js').NativeThreadSwitchReason
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
    reason:
      | 'unknown-confirmation'
      | 'expired-confirmation'
      | 'stale-operation'
      | 'thread-switch-failed'
      | import('./native-thread-switch-error.js').NativeThreadSwitchReason
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
    providerSource?: 'managed' | 'config' | 'remote'
    configOverrides: Readonly<Record<string, unknown>>
    providerId: string
    model: string
    serviceGeneration: string
    reasoningEffort?: ModelReasoningEffort
  }>
  | Readonly<{
    kind: 'reject'
    reason: 'unknown-token' | 'expired-token' | 'stale-operation' | 'request-mismatch' | 'scope-mismatch'
  }>

/** Host-internal provider table for natively resuming a thread that a managed provider owns. */
export type NativeThreadResumePreparation =
  | Readonly<{ kind: 'resume'; resumeToken: string; configOverrides: Readonly<Record<string, unknown>> }>
  | Readonly<
    {
      kind: 'reject'
      reason: 'unknown-provider' | 'provider-preparation-failed'
      startupReason?: StartupActionReasonV1
    }
  >

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
    | Readonly<
      {
        kind: 'reject'
        reason:
          | 'stale-operation'
          | 'thread-switch-failed'
          | import('./native-thread-switch-error.js').NativeThreadSwitchReason
        startupReason?: StartupActionReasonV1
      }
    >
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
  /**
   * Refresh launch-scoped routes on resume, including recognized historical provider tables.
   * Never return this value through the renderer command API.
   */
  prepareThreadResume(
    input: Readonly<{ threadId: string; providerId: string; model: string; managedOnly?: boolean }>,
  ): Promise<NativeThreadResumePreparation>
  completeThreadResume(
    input: Readonly<{ threadId: string; resumeToken: string; succeeded: boolean; createdThreadId?: string }>,
  ): Promise<boolean>
  cancel(input: Readonly<{ scope: NativeSubmissionScope; id: string }>): Promise<boolean>
  releaseScope(scope: NativeSubmissionScope): Promise<void>
  releaseThread(threadId: string): Promise<void>
  dispose(): Promise<void>
}

export interface NativeSubmissionControllerOptions {
  readonly startup?: StartupProviderAdmission
  readonly selection: NativeSubmissionSelectionAuthority
  readonly credentials: NativeProviderCredentialBroker
  readonly runtime: NativeSubmissionRuntimeAuthority
  readonly existingThread: NativeExistingThreadSwitch
  readonly prepareConfiguredProvider?: (providerId: string) => Promise<Readonly<Record<string, unknown>>>
  readonly prepareRemoteProvider?: (
    selection: NativeProviderSelection,
    signal: AbortSignal,
  ) => Promise<RemotePreparedProvider>
  readonly providerSource?: (providerId: string) => 'managed' | 'config' | 'remote' | undefined
  readonly validateSelection?: (selection: NativeProviderSelection) => Promise<boolean>
  readonly operationTtlMs?: number
  readonly confirmationTtlMs?: number
  readonly now?: () => number
  readonly createId?: () => string
}
