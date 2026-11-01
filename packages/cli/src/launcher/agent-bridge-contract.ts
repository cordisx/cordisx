import { stat } from 'node:fs/promises'

/**
 * The wire contract both sides of the agent bridge implement: which apps and
 * operations exist, the failure shape every rejection uses, the paging rules
 * for a transcript, and the in-memory record of started operations.
 *
 * An agent must be able to recover without reading prose: `status`, `reason`
 * and `retryable` are the fields it branches on, and `howToContinue` is the
 * one sentence it can follow when the reason is unfamiliar.
 */

export const BRIDGE_APPS = ['codex', 'claude'] as const
export type BridgeApp = typeof BRIDGE_APPS[number]

/**
 * `list_sessions`, `read_session` and `list_model_providers` are reads.
 * `start_session` and `send_message` start a background turn and return an
 * `operationId`; `check_operation` reports what became of it.
 */
export const BRIDGE_OPERATIONS = [
  'list_sessions',
  'read_session',
  'start_session',
  'send_message',
  'list_model_providers',
  'check_operation',
] as const
export type BridgeOperation = typeof BRIDGE_OPERATIONS[number]

/** The operations that start a background turn and so carry an `operationId`. */
export const BRIDGE_TURN_OPERATIONS = ['start_session', 'send_message'] as const
export type BridgeTurnOperation = typeof BRIDGE_TURN_OPERATIONS[number]

export const isBridgeApp = (value: unknown): value is BridgeApp =>
  typeof value === 'string' && (BRIDGE_APPS as readonly string[]).includes(value)
export const isBridgeOperation = (value: unknown): value is BridgeOperation =>
  typeof value === 'string' && (BRIDGE_OPERATIONS as readonly string[]).includes(value)

export const BRIDGE_REASONS = [
  'unknown-app',
  'unknown-operation',
  'malformed-request',
  'invalid-arguments',
  'operation-id-conflict',
  'operation-not-found',
  'sessionId-required',
  'prompt-required',
  'sessionId-and-prompt-required',
  'cwd-must-be-absolute',
  'cwd-not-found',
  'cursor-invalid',
  'context-invalid',
  'provider-not-configured',
  'model-not-in-provider-catalog',
  'model-without-provider',
  'provider-not-declared',
  'provider-key-missing',
  'session-not-found',
  'session-busy',
  'session-open-in-claude',
  'claude-not-running',
  'codex-not-running',
  'claude-plugin-unavailable',
  'timeout',
  'turn-failed',
  'session-not-started',
  'claude-code-missing',
  'claude-did-not-start',
  'agent-bridge-unavailable',
  'internal-error',
] as const
export type BridgeReason = typeof BRIDGE_REASONS[number]

/**
 * `retryable` means calling again with the same arguments can plausibly
 * succeed without any other change. `howToContinue` is one sentence an agent
 * can act on when it does not recognise the reason.
 */
const BRIDGE_REASON_GUIDE: Readonly<
  Record<BridgeReason, { readonly retryable: boolean; readonly howToContinue: string }>
> = Object.freeze({
  'unknown-app': {
    retryable: false,
    howToContinue: 'Pass app "codex" or "claude"; both apps expose the same tools.',
  },
  'unknown-operation': {
    retryable: false,
    howToContinue: 'Call one of the bridge tools by name; the operation is fixed by the tool.',
  },
  'malformed-request': {
    retryable: false,
    howToContinue: 'Send one JSON object as the request body.',
  },
  'invalid-arguments': {
    retryable: false,
    howToContinue: 'Check the argument names and types against the tool schema and call again.',
  },
  'operation-id-conflict': {
    retryable: false,
    howToContinue: 'An operationId names one operation; reuse it only to repeat that call, otherwise use a new one.',
  },
  'operation-not-found': {
    retryable: false,
    howToContinue:
      'This bridge knows only operations it started since it last came up; start the work again and keep the operationId it returns.',
  },
  'sessionId-required': {
    retryable: false,
    howToContinue: 'Pass sessionId from list_sessions.',
  },
  'prompt-required': {
    retryable: false,
    howToContinue: 'Pass the full brief as prompt.',
  },
  'sessionId-and-prompt-required': {
    retryable: false,
    howToContinue: 'Pass both sessionId (from list_sessions) and prompt.',
  },
  'cwd-must-be-absolute': {
    retryable: false,
    howToContinue: 'Pass cwd as an absolute path such as /Users/me/project, or omit it.',
  },
  'cwd-not-found': {
    retryable: false,
    howToContinue: 'Pass a cwd that exists and is a directory, or omit it to use the home directory.',
  },
  'context-invalid': { retryable: false, howToContinue: 'Pass context none or summary.' },
  'cursor-invalid': {
    retryable: false,
    howToContinue:
      'Pass nextCursor from the previous read_session result unchanged, or omit cursor to read the newest messages.',
  },
  'provider-not-configured': {
    retryable: false,
    howToContinue: 'Call list_model_providers for that app and pass a providerId it lists, or omit providerId.',
  },
  'model-not-in-provider-catalog': {
    retryable: false,
    howToContinue: 'Call list_model_providers and pass a model id listed under that providerId.',
  },
  'model-without-provider': {
    retryable: false,
    howToContinue: "Pass providerId together with model, or drop model to use the app's own model.",
  },
  'provider-not-declared': {
    retryable: false,
    howToContinue: 'Pick a provider declared as a model-service in the CordisX config, or omit providerId.',
  },
  'provider-key-missing': {
    retryable: false,
    howToContinue:
      "Set the provider's apiKeyEnv variable in the CordisX config or the launch environment, or pick a provider whose key is set.",
  },
  'session-not-found': {
    retryable: false,
    howToContinue: 'Call list_sessions and use a sessionId it returns; the session may have been deleted.',
  },
  'session-busy': {
    retryable: true,
    howToContinue:
      'A turn is already running there; call check_operation or read_session, then send again once it is done.',
  },
  'session-open-in-claude': {
    retryable: false,
    howToContinue:
      'Claude Desktop has that session open; send the message from Claude, or close the session there and call again.',
  },
  'claude-not-running': {
    retryable: false,
    howToContinue:
      'Ask the user, in their language, whether to start Claude Desktop. If they agree, call this tool again with the same arguments plus launch "once" (start it this time) or "always" (start it automatically from now on, without asking). Do not retry without their answer.',
  },
  'codex-not-running': {
    retryable: false,
    howToContinue:
      'Ask the user, in their language, whether to start Codex Desktop. If they agree, call this tool again with the same arguments plus launch "once" (start it this time) or "always" (start it automatically from now on, without asking). Do not retry without their answer.',
  },
  'claude-plugin-unavailable': {
    retryable: true,
    howToContinue:
      'The open Claude session did not take the message; send it from Claude, or close that session and call again.',
  },
  'timeout': {
    retryable: true,
    howToContinue: 'Claude did not answer in time; call check_operation with the operationId, or call again.',
  },
  'turn-failed': {
    retryable: true,
    howToContinue:
      'The background turn failed; read the session for the reason, then send a new message or start again with a new operationId.',
  },
  'session-not-started': {
    retryable: true,
    howToContinue: 'The app returned no session; call again with a new operationId.',
  },
  'claude-code-missing': {
    retryable: false,
    howToContinue: 'Open one Code session in Claude Desktop once so it installs Claude Code, then call again.',
  },
  'claude-did-not-start': {
    retryable: true,
    howToContinue:
      'Claude Desktop did not start within 30 seconds; start it with `cordisx start claude`, or call again.',
  },
  'agent-bridge-unavailable': {
    retryable: true,
    howToContinue: 'CordisX is not running the bridge; start Codex with `cordisx start codex`, then call again.',
  },
  'internal-error': {
    retryable: true,
    howToContinue: 'Read message; if it repeats, tell the user instead of retrying any further.',
  },
})

/** The failure shape every rejection and failure uses, with human text alongside. */
export interface BridgeFailure {
  readonly status: 'rejected' | 'failed' | 'unavailable' | 'needs-confirmation'
  readonly reason: BridgeReason
  readonly retryable: boolean
  readonly howToContinue: string
  /** Human-readable, safe to show. Never carries an endpoint or a key. */
  readonly message: string
  /** Extra context an agent may branch on, such as the variable a key belongs in. */
  readonly detail?: string
}

export function bridgeFailure(
  reason: BridgeReason,
  extra: {
    readonly status?: BridgeFailure['status']
    readonly message?: string
    readonly retryable?: boolean
    readonly howToContinue?: string
    readonly detail?: string
  } = {},
): BridgeFailure {
  const guide = BRIDGE_REASON_GUIDE[reason]
  return {
    status: extra.status ?? 'rejected',
    reason,
    retryable: extra.retryable ?? guide.retryable,
    howToContinue: extra.howToContinue ?? guide.howToContinue,
    message: extra.message ?? reason,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  }
}

export const isBridgeFailure = (value: unknown): value is BridgeFailure =>
  typeof value === 'object' && value !== null && 'reason' in value && 'howToContinue' in value

/** Thrown inside a handler when the caller's arguments or the backend cannot be honored. */
export class BridgeOperationError extends Error {
  readonly failure: BridgeFailure
  constructor(reason: BridgeReason, extra: Parameters<typeof bridgeFailure>[1] = {}) {
    const failure = bridgeFailure(reason, extra)
    super(failure.message)
    this.name = 'BridgeOperationError'
    this.failure = failure
  }
}

/** A `cwd` an operation cannot run in is refused before anything starts. */
export async function requireDirectory(cwd: string): Promise<void> {
  const found = await stat(cwd).catch(() => undefined)
  if (found !== undefined && found.isDirectory()) return
  throw new BridgeOperationError('cwd-not-found', { message: `cwd ${cwd} is not a directory` })
}

/** A rejected promise from a handler becomes the same structured failure as a returned one. */
export function failureFromError(error: unknown): BridgeFailure {
  if (error instanceof BridgeOperationError) return error.failure
  const message = error instanceof Error && error.message.length > 0 ? error.message : 'The bridge operation failed'
  // A backend that went away mid-call says why; anything else is ours.
  return bridgeFailure(error instanceof AgentBridgeUnavailable ? error.reason : 'internal-error', {
    status: 'failed',
    message: message.slice(0, 2000),
  })
}

/** The bridge or the session it answers through is not there right now. */
export class AgentBridgeUnavailable extends Error {
  readonly reason: 'agent-bridge-unavailable' | 'timeout' | 'claude-plugin-unavailable'
  constructor(
    message: string,
    reason: 'agent-bridge-unavailable' | 'timeout' | 'claude-plugin-unavailable' = 'agent-bridge-unavailable',
  ) {
    super(message)
    this.name = 'AgentBridgeUnavailable'
    this.reason = reason
  }
}

/* ------------------------------------------------------------------------ */
/* Dry runs                                                                  */
/* ------------------------------------------------------------------------ */

/** What a `dryRun` start checked, in the same keys on both apps. */
export interface DryRunChecks {
  readonly provider: 'ok' | 'remembered' | 'not-requested'
  readonly model: 'ok' | 'remembered' | 'not-requested'
  readonly cwd: 'ok' | 'remembered'
  readonly key: 'ok' | 'remembered' | 'not-required'
}

/** One app + provider + model + cwd combination a start proved works. */
export interface BridgeValidationKey {
  readonly app: BridgeApp
  readonly providerId?: string
  readonly model?: string
  readonly cwd: string
  readonly configuration?: string
}

/**
 * Remembers validated combinations under the CordisX home, so a later `dryRun`
 * answers from there instead of repeating the checks. A cache that cannot be
 * read or written only costs a repeated check.
 */
export interface BridgeValidationCache {
  remembers(key: BridgeValidationKey): Promise<boolean>
  remember(key: BridgeValidationKey): Promise<void>
}

/**
 * A `dryRun` start's answer: what would happen, and nothing started. It is
 * shaped like a normal result so an agent reads one set of fields either way.
 */
export function dryRunResult(input: {
  readonly app: BridgeApp
  readonly operationId: string
  readonly checks: DryRunChecks
  readonly wouldStart: Record<string, unknown>
}): Record<string, unknown> {
  return {
    status: 'dry-run',
    app: input.app,
    operationId: input.operationId,
    remembered: Object.values(input.checks).some(check => check === 'remembered'),
    checks: input.checks,
    wouldStart: input.wouldStart,
    note:
      'Nothing was started and no model call was made. Call start_session again with the same arguments and dryRun omitted to run it.',
  }
}

export { pageTranscript, type TranscriptEntry } from './agent-bridge-transcript.js'
export {
  type BridgeOperationRegistry,
  createBridgeOperationRegistry,
  createTurnRunner,
  newOperationId,
  type TurnContext,
} from './agent-bridge-operations.js'
