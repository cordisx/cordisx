import { randomUUID } from 'node:crypto'
import {
  type BridgeApp,
  bridgeFailure,
  BridgeOperationError,
  type BridgeReason,
  type BridgeTurnOperation,
  failureFromError,
  isBridgeFailure,
} from './agent-bridge-contract.js'
/* ------------------------------------------------------------------------ */
/* Started operations                                                        */
/* ------------------------------------------------------------------------ */

export type BridgeOperationState = 'running' | 'done' | 'failed'

export interface BridgeOperationRecord {
  readonly operationId: string
  readonly app: BridgeApp
  readonly operation: BridgeTurnOperation
  state: BridgeOperationState
  /** The session this operation started, or the one it sent a message to. */
  sessionId?: string
  turnId?: string
  fingerprint: string
  link?: string
  /**
   * True once the operation changed something: it started a session, or it sent
   * a message. A repeat with the same id then answers the stored result instead
   * of doing it a second time. An attempt that changed nothing may be retried.
   */
  effected: boolean
  /** What a repeat with the same operationId answers. */
  result?: Record<string, unknown>
  reason?: BridgeReason
  message?: string
  readonly startedAt: number
  finishedAt?: number
}

export interface BridgeOperationRegistry {
  /** An operationId as the tools hand it out: non-empty, at most `max` characters. */
  readonly resolve: (value: unknown, max?: number) => string | undefined
  /**
   * Claims an operationId. A second call with the same id and the same
   * operation answers the first one's result while it still names a session;
   * an attempt that created nothing may be retried.
   */
  begin(input: {
    readonly operationId: string
    readonly app: BridgeApp
    readonly operation: BridgeTurnOperation
    readonly fingerprint: string
  }): { readonly kind: 'started'; readonly record: BridgeOperationRecord } | {
    readonly kind: 'repeated'
    readonly record: BridgeOperationRecord
  }
  /** Records the session an operation produced, with the result a repeat returns. */
  finish(
    operationId: string,
    app: BridgeApp,
    patch: {
      readonly state: BridgeOperationState
      readonly sessionId?: string
      readonly turnId?: string
      readonly link?: string
      readonly effected?: boolean
      readonly result?: Record<string, unknown>
      readonly reason?: BridgeReason
      readonly message?: string
    },
  ): void
  /** Forgets an id that started nothing, as a dry run does. */
  forget(operationId: string, app: BridgeApp): void
  read(operationId: string, app: BridgeApp): BridgeOperationRecord | undefined
}

const MAX_REMEMBERED_OPERATIONS = 200

/**
 * Started operations this bridge process remembers. It is in-memory on purpose:
 * it has to survive only the bridge's lifetime, which is the Codex launch that
 * runs it, and a restarted bridge is reported as `operation-not-found` with
 * what to do instead.
 */
export function createBridgeOperationRegistry(): BridgeOperationRegistry {
  const records = new Map<string, BridgeOperationRecord>()
  const keyOf = (app: BridgeApp, operationId: string): string => `${app}\u0000${operationId}`
  const prune = (): void => {
    if (records.size <= MAX_REMEMBERED_OPERATIONS) return
    const finished = [...records.values()]
      .filter(record => record.state !== 'running')
      .sort((left, right) => left.startedAt - right.startedAt)
    for (const record of finished.slice(0, records.size - MAX_REMEMBERED_OPERATIONS)) {
      records.delete(keyOf(record.app, record.operationId))
    }
  }
  return {
    resolve: (value, max = 128) =>
      typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined,
    begin(input) {
      const existing = records.get(keyOf(input.app, input.operationId))
      if (existing !== undefined) {
        if (existing.operation !== input.operation || existing.fingerprint !== input.fingerprint) {
          throw new BridgeOperationError('operation-id-conflict', {
            message: `operationId ${input.operationId} was used for ${existing.operation}`,
          })
        }
        if (existing.state === 'running' || existing.effected) {
          return { kind: 'repeated', record: existing }
        }
        // Nothing was created and nothing is running: a retry is safe.
      }
      const record: BridgeOperationRecord = {
        operationId: input.operationId,
        app: input.app,
        fingerprint: input.fingerprint,
        operation: input.operation,
        state: 'running',
        effected: false,
        startedAt: Date.now(),
      }
      records.set(keyOf(input.app, input.operationId), record)
      prune()
      return { kind: 'started', record }
    },
    finish(operationId, app, patch) {
      const record = records.get(keyOf(app, operationId))
      if (record === undefined) return
      record.state = patch.state
      if (patch.sessionId !== undefined) record.sessionId = patch.sessionId
      if (patch.turnId !== undefined) record.turnId = patch.turnId
      if (patch.link !== undefined) record.link = patch.link
      if (patch.effected !== undefined) record.effected = patch.effected
      if (patch.result !== undefined) record.result = patch.result
      if (patch.reason !== undefined) record.reason = patch.reason
      if (patch.message !== undefined) record.message = patch.message
      if (patch.state === 'running') delete record.finishedAt
      else record.finishedAt = Date.now()
    },
    forget(operationId, app) {
      records.delete(keyOf(app, operationId))
    },
    read(operationId, app) {
      return records.get(keyOf(app, operationId))
    },
  }
}

/** A fresh operationId for a call that did not bring one, so `check_operation` always works. */
export const newOperationId = (): string => randomUUID()

/** `check_operation`'s answer for one recorded operation: idempotent and side-effect free. */
export function operationState(record: BridgeOperationRecord): Record<string, unknown> {
  const base = {
    operationId: record.operationId,
    operation: record.operation,
    app: record.app,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.link === undefined ? {} : { link: record.link }),
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
  }
  if (record.state === 'running' && record.result?.completion === 'unavailable') {
    return {
      status: 'submitted',
      ...base,
      completion: 'unavailable',
      howToContinue:
        'The open Claude session accepted the message; read_session to inspect the outcome. The bridge cannot observe that model turn finishing.',
    }
  }
  if (record.state === 'running') {
    return {
      status: 'running',
      ...base,
      howToContinue:
        'The turn is still running in the app; call check_operation again later, then read_session for its output.',
    }
  }
  if (record.state === 'failed') {
    const failure = bridgeFailure(record.reason ?? 'turn-failed', {
      status: 'failed',
      ...(record.message === undefined ? {} : { message: record.message }),
    })
    return {
      status: 'failed',
      ...base,
      reason: failure.reason,
      retryable: failure.retryable,
      howToContinue: failure.howToContinue,
      message: failure.message,
    }
  }
  return {
    status: 'done',
    ...base,
    howToContinue: record.sessionId === undefined
      ? 'The operation finished; call list_sessions to find the conversation.'
      : 'The turn finished; call read_session with this sessionId for its output.',
  }
}

/* ------------------------------------------------------------------------ */
/* The turn runner both apps use                                             */
/* ------------------------------------------------------------------------ */

/** What a turn reports once it ends in the background. */
export interface BackgroundTurn {
  readonly status: 'succeeded' | 'failed'
  readonly error?: string
}

/**
 * The context a turn body gets: how to record what it produced, so a repeat
 * with the same operationId answers instead of doing it twice.
 */
export interface TurnContext {
  readonly operationId: string
  /** True when this call only validates: start nothing, spend no model call. */
  readonly dryRun: boolean
  /** Records the session this operation produced; a repeat then answers the stored result. */
  readonly uncertain: () => void
  readonly effected: (sessionId: string, link?: string) => void
  /** Records the result a repeat and `check_operation` answer with, and marks the operation done. */
  readonly started: (result: Record<string, unknown>, turnId?: string) => Record<string, unknown>
  readonly done: (result: Record<string, unknown>) => Record<string, unknown>
  /** Records a failure the caller can act on. The session, if any, stays readable. */
  readonly failed: (result: Record<string, unknown>) => Record<string, unknown>
  /** A background turn still running: `check_operation` says `running` until it settles. */
  readonly follow: (ended: Promise<BackgroundTurn>) => void
}

export interface TurnRunnerOptions {
  /** Validates a `dryRun` start and returns what it would do. Absent, `dryRun` is refused. */
  readonly dryRun?: (
    args: Record<string, unknown>,
    operationId: string,
  ) => Promise<Record<string, unknown>>
  readonly registry: BridgeOperationRegistry
  readonly refresh?: (record: BridgeOperationRecord) => Promise<BackgroundTurn | undefined>
}

/**
 * `start_session` and `send_message` on either app: one operationId per call
 * (made up when the caller brings none), the same id answered from memory
 * instead of starting a second session, `dryRun` for a start, and a thrown
 * error turned into the same failure shape as a returned one.
 */
export function createTurnRunner(app: BridgeApp, options: TurnRunnerOptions) {
  const begin = (operation: BridgeTurnOperation, operationId: string, args: Record<string, unknown>) =>
    options.registry.begin({
      operationId,
      app,
      operation,
      fingerprint: JSON.stringify(
        Object.entries(args).filter(([key]) => key !== 'operationId' && key !== 'launch' && key !== 'callerSummary')
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    })

  return {
    async run(
      operation: BridgeTurnOperation,
      args: Record<string, unknown>,
      execute: (context: TurnContext) => Promise<Record<string, unknown>>,
    ): Promise<unknown> {
      const brought = options.registry.resolve(args.operationId)
      if (args.operationId !== undefined && brought === undefined) {
        return bridgeFailure('invalid-arguments', {
          message: 'operationId must be a non-empty string of at most 128 characters',
          detail: 'operationId',
        })
      }
      const operationId = brought ?? newOperationId()
      const dryRun = operation === 'start_session' && args.dryRun === true
      if (operation === 'start_session' && args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
        return bridgeFailure('invalid-arguments', { message: 'dryRun must be true or false', detail: 'dryRun' })
      }
      if (dryRun && options.dryRun === undefined) {
        return bridgeFailure('invalid-arguments', { message: 'dryRun is not supported here', detail: 'dryRun' })
      }
      // A dry run starts nothing, so it neither claims the id nor is remembered.
      if (!dryRun) {
        let claim: ReturnType<BridgeOperationRegistry['begin']>
        try {
          claim = begin(operation, operationId, args)
        } catch (error) {
          return failureFromError(error)
        }
        if (claim.kind === 'repeated') {
          const record = claim.record
          // The same id answers with what the first call produced, never a second run.
          return {
            ...(record.result ?? {
              status: record.state === 'failed' ? 'failed' : 'started',
              ...(record.reason === undefined
                ? {}
                : { reason: record.reason, retryable: true, message: record.message }),
            }),
            ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
            ...(record.link === undefined ? {} : { link: record.link }),
            operationId,
            repeated: true,
            howToContinue: record.state === 'running'
              ? 'This operation is still running; call check_operation with this operationId for its result.'
              : 'This operation already ran; call check_operation with this operationId for its result, or use a new operationId for a new start.',
          }
        }
      }
      const context: TurnContext = {
        operationId,
        dryRun,
        uncertain: () => {
          options.registry.finish(operationId, app, { state: 'running', effected: true })
        },
        effected: (sessionId, link) => {
          if (dryRun) return
          options.registry.finish(operationId, app, {
            state: 'running',
            effected: true,
            sessionId,
            ...(link === undefined ? {} : { link }),
          })
        },
        started: (result, turnId) => {
          options.registry.finish(operationId, app, {
            state: 'running',
            result,
            ...(turnId === undefined ? {} : { turnId }),
          })
          return result
        },
        done: result => {
          if (!dryRun) options.registry.finish(operationId, app, { state: 'done', result })
          return result
        },
        failed: result => {
          if (!dryRun) {
            const failure = failureFromError(
              new BridgeOperationError((result.reason as BridgeReason) ?? 'turn-failed', {
                status: 'failed',
                ...(typeof result.message === 'string' ? { message: result.message } : {}),
              }),
            )
            options.registry.finish(operationId, app, {
              state: 'failed',
              result,
              reason: failure.reason,
              message: failure.message,
              effected: options.registry.read(operationId, app)?.effected === true || result.sessionId !== undefined,
            })
          }
          return result
        },
        follow: ended => {
          if (dryRun) return
          void ended.then(turn => {
            const record = options.registry.read(operationId, app)
            if (record === undefined || record.state !== 'running') return
            const settled = turn.status === 'failed'
              ? {
                ...(record.result ?? {}),
                status: 'failed',
                turn: { status: 'failed', ...(turn.error === undefined ? {} : { error: turn.error }) },
                reason: 'turn-failed',
                retryable: true,
                howToContinue: bridgeFailure('turn-failed').howToContinue,
                message: turn.error ?? 'The background turn failed',
              }
              : {
                ...(record.result ?? {}),
                status: record.result?.status ?? 'started',
                turn: { status: 'succeeded' },
              }
            options.registry.finish(operationId, app, {
              state: turn.status === 'failed' ? 'failed' : 'done',
              result: settled as Record<string, unknown>,
              ...(turn.status === 'failed'
                ? { reason: 'turn-failed' as const, message: turn.error ?? 'The background turn failed' }
                : {}),
              effected: true,
            })
          })
        },
      }
      try {
        if (dryRun) {
          const checked = await options.dryRun!(args, operationId)
          return { ...checked, operationId }
        }
        // Every answer carries the id it belongs to, success or failure: an
        // agent that kept only this field can still call `check_operation`.
        const result = await execute(context)
        if (isBridgeFailure(result)) context.failed(result)
        return { ...result, operationId }
      } catch (error) {
        const failure = failureFromError(error)
        // The id stays claimed when something may have happened; a pre-flight
        // refusal that changed nothing may be retried with the same id.
        options.registry.finish(operationId, app, {
          state: 'failed',
          result: { ...failure, operationId },
          reason: failure.reason,
          message: failure.message,
        })
        return { ...failure, operationId }
      }
    },
    async check(input: unknown): Promise<unknown> {
      const args = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {}
      const operationId = options.registry.resolve(args.operationId)
      if (operationId === undefined) {
        return bridgeFailure('invalid-arguments', {
          message: 'check_operation needs the operationId start_session or send_message returned',
          detail: 'operationId',
        })
      }
      const record = options.registry.read(operationId, app)
      if (record === undefined) {
        return bridgeFailure('operation-not-found', {
          message: `No operation ${operationId} was started from ${app} since this bridge came up`,
          detail: operationId,
        })
      }
      if (record.state === 'running' && options.refresh !== undefined) {
        try {
          const settled = await options.refresh(record)
          if (settled !== undefined) {
            options.registry.finish(operationId, app, {
              state: settled.status === 'failed' ? 'failed' : 'done',
              result: {
                ...record.result,
                status: settled.status === 'failed' ? 'failed' : record.result?.status ?? 'started',
                turn: settled,
              },
              ...(settled.status === 'failed'
                ? { reason: 'turn-failed', message: settled.error ?? 'The turn failed' }
                : {}),
            })
          }
        } catch { /* An unavailable readback is not evidence that the turn finished. */ }
      }
      return operationState(record)
    },
  }
}
