import type { NativeSubmissionIntent, NormalizedNativeSubmissionAction } from '../native-provider-submission-policy.js'

export interface NativeSubmissionOperationIdentity {
  readonly operationId: string
  readonly operationGeneration: number
}

/** Flattened values available at the audited build-8109 gXr pre-effect point. */
export interface NativeSubmissionOrchestratorDescriptor {
  readonly target: unknown
  readonly thread: unknown
  readonly response: unknown
  readonly followUp: unknown
  readonly followUpThread: unknown
  readonly defaultAction: unknown
  readonly explicitAction: unknown
  readonly edit: unknown
  readonly promptOverride: unknown
}

function explicitIntent(action: unknown): NativeSubmissionIntent | undefined {
  if (action === undefined) return undefined
  if (action === 'queue') return 'queue'
  if (action === 'steer') return 'steer'
  return 'unknown-submission'
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === false
}

function normalizedIntent(descriptor: NativeSubmissionOrchestratorDescriptor): NativeSubmissionIntent {
  if (typeof descriptor.edit === 'number') return 'edit-retry'
  if (descriptor.edit !== null && descriptor.edit !== undefined) return 'unknown-submission'

  const explicit = explicitIntent(descriptor.explicitAction)
  if (explicit !== undefined) return explicit
  if (descriptor.response === true) return explicitIntent(descriptor.defaultAction) ?? 'unknown-submission'
  if (descriptor.response !== false || descriptor.promptOverride !== false) return 'unknown-submission'

  if (descriptor.target === 'worktree') {
    return absent(descriptor.thread) && absent(descriptor.followUp) && absent(descriptor.followUpThread)
      ? 'ordinary-send'
      : 'unknown-submission'
  }
  if (descriptor.target !== 'local') return 'unknown-submission'

  if (absent(descriptor.followUp)) {
    return absent(descriptor.thread) && absent(descriptor.followUpThread) ? 'ordinary-send' : 'unknown-submission'
  }
  return descriptor.followUp === 'local'
      && typeof descriptor.thread === 'string'
      && descriptor.thread !== ''
      && descriptor.followUpThread === descriptor.thread
    ? 'ordinary-send'
    : 'unknown-submission'
}

/**
 * Normalizes the pre-effect submit-orchestrator state audited in Desktop
 * 26.901.51231. The idle path intentionally ignores the UI default follow-up
 * action because build 8109 uses it only when a response is active.
 */
export function normalizeNativeSubmissionAction(
  identity: NativeSubmissionOperationIdentity,
  descriptor: NativeSubmissionOrchestratorDescriptor,
): NormalizedNativeSubmissionAction {
  const threadId = typeof descriptor.thread === 'string' && descriptor.thread !== ''
    ? descriptor.thread
    : typeof descriptor.followUpThread === 'string' && descriptor.followUpThread !== ''
    ? descriptor.followUpThread
    : undefined
  return {
    ...identity,
    intent: normalizedIntent(descriptor),
    ...(threadId === undefined ? {} : { threadId }),
  }
}
