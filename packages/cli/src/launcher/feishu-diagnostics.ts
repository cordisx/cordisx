import type { Logger } from '@larksuiteoapi/node-sdk'
import { bindDiagnostic, diagnosticError, type DiagnosticEvent, diagnosticRef } from '../diagnostics/context.js'
import { feishuFailureDiagnostic } from './feishu-operation-error.js'

const REJECT_REASONS = new Set([
  'group_not_allowed',
  'sender_not_allowed',
  'no_mention',
  'dm_disabled',
  'mention_all_blocked',
])

/** SDK logs may contain entire messages or Axios credentials. Project fixed stages only. */
export function createFeishuDiagnostics(accountId: string) {
  const emit = bindDiagnostic(), serviceRef = diagnosticRef(accountId)
  let remaining = 512
  let stopped = false
  const event = (phase: string, fields: Omit<DiagnosticEvent, 'event'> = {}) => {
    if (stopped || remaining <= 0) return
    emit({ ...fields, event: 'channel-feishu', phase, serviceRef })
    if (--remaining === 0) emit({ event: 'channel-feishu', phase: 'observation-limit', serviceRef, count: 512 })
  }
  const failure = (phase: string, error: unknown) => {
    const detail = feishuFailureDiagnostic('inbound', error)
    event(phase, {
      ...diagnosticError(error),
      ...(detail.httpStatus === undefined ? {} : { statusCode: detail.httpStatus }),
      ...(detail.platformCode === undefined ? {} : { errorCode: String(detail.platformCode) }),
    })
  }
  const debug: Logger['debug'] = (...values: unknown[]) => {
    // LoggerProxy passes one array; direct callers pass rest arguments. Never stringify either.
    if (values.length === 1 && Array.isArray(values[0])) values = values[0] as unknown[]
    // Inspect only the transport prefix. Never parse or emit its appended data payload.
    if (values[0] === '[ws]' && typeof values[1] === 'string') {
      const match = /^receive message, message_type: (\w+); message_id: ([\w-]{1,512}); trace_id:/u.exec(values[1])
      if (match) {
        event('ws-receive', { requestRef: diagnosticRef(match[2]!), reason: match[1] === 'event' ? 'event' : 'other' })
      }
      if (values[1] === 'ws connect success') event('ws-ready')
      if (values[1] === 'reconnect success') event('ws-reconnected')
      if (values[1] === 'client closed') event('ws-closed')
    } else if (typeof values[0] === 'string') {
      const match = /^safety: drop (stale|duplicate|in-flight) message ([\w-]{1,512})$/u.exec(values[0])
      if (match) event('sdk-drop', { reason: match[1], requestRef: diagnosticRef(match[2]!) })
      if (values[0] === 'execute im.message.receive_v1 handle') event('sdk-dispatched')
    }
  }
  const logger: Logger = {
    trace: () => {},
    debug,
    info: () => {},
    warn: () => event('sdk-warning'),
    error: (...values: unknown[]) => {
      if (values.length === 1 && Array.isArray(values[0])) values = values[0] as unknown[]
      failure('sdk-error', values.find(value => value instanceof Error))
    },
  }
  return {
    logger,
    event,
    failure,
    message: (phase: string, messageId: string, fields: Omit<DiagnosticEvent, 'event'> = {}) =>
      event(phase, { ...fields, requestRef: diagnosticRef(messageId) }),
    reject: (messageId: string, reason: string) =>
      event('sdk-reject', {
        requestRef: diagnosticRef(messageId),
        reason: REJECT_REASONS.has(reason) ? reason : 'unknown',
      }),
    dispose: () => {
      stopped = true
    },
  }
}
