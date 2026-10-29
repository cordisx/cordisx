import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

export interface DiagnosticEvent {
  readonly event: string
  readonly [key: string]: string | number | boolean | null | undefined
}
export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void
}
const context = new AsyncLocalStorage<DiagnosticSink>()
const ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EMFILE',
  'EADDRINUSE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])
export function withDiagnostics<T>(sink: DiagnosticSink, operation: () => T): T {
  return context.run(sink, operation)
}
export function diagnostic(event: DiagnosticEvent): void {
  try {
    context.getStore()?.emit(event)
  } catch { /* Diagnostics never control product behavior. */ }
}
export function diagnosticRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}
export function diagnosticId(): string {
  return randomUUID()
}

/** No error messages/stacks: even innocent-looking provider errors can contain prompts or credentials. */
export function diagnosticError(error: unknown): { errorCode: string; errorClass: string; statusCode?: number } {
  try {
    return classifyDiagnosticError(error, 0)
  } catch {
    return { errorCode: 'unknown', errorClass: 'unknown' }
  }
}
function classifyDiagnosticError(
  error: unknown,
  depth: number,
): { errorCode: string; errorClass: string; statusCode?: number } {
  if (error instanceof Error) {
    if (error.message === 'CDP connection closed' || error.message === 'CDP connection is closed') {
      return { errorCode: 'CDP_CLOSED', errorClass: 'local-cdp' }
    }
    if (error.message.startsWith('CDP request timed out:')) {
      return { errorCode: 'CDP_DEADLINE', errorClass: 'local-cdp' }
    }
    const http = /^Unexpected server response: ([1-5][0-9]{2})$/u.exec(error.message)
    if (http) return { errorCode: 'HTTP_RESPONSE', errorClass: 'http-response', statusCode: Number(http[1]) }
  }
  const candidate = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  const errorCode = typeof candidate === 'string' && ERROR_CODES.has(candidate) ? candidate : 'unknown'
  if (errorCode === 'unknown' && depth < 2 && error instanceof Error) {
    const nested = error instanceof AggregateError ? error.errors.slice(0, 8) as unknown[] : [error.cause]
    for (const value of nested) {
      const detail = classifyDiagnosticError(value, depth + 1)
      if (detail.errorCode !== 'unknown') return detail
    }
  }
  const errorClass = ['ENOTFOUND', 'EAI_AGAIN'].includes(errorCode)
    ? 'dns'
    : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(errorCode)
    ? 'network'
    : ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(errorCode)
    ? 'tls'
    : ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(errorCode)
    ? 'upstream-timeout'
    : error instanceof Error && error.name === 'AbortError'
    ? 'cancelled'
    : 'unknown'
  return { errorCode, errorClass }
}

/** Event emitters may invoke a callback outside the async context that registered it. */
export function bindDiagnostic(): (event: DiagnosticEvent) => void {
  const sink = context.getStore()
  return event => {
    try {
      sink?.emit(event)
    } catch { /* Best effort observer. */ }
  }
}

/** Restore the owning log context when an existing launch callback crosses an event boundary. */
export function bindDiagnosticContext<Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  const sink = context.getStore()
  return (...args) => sink ? context.run(sink, () => operation(...args)) : operation(...args)
}
