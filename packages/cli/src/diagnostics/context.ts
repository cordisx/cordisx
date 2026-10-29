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
export function diagnosticError(error: unknown): { errorCode: string; errorClass: string } {
  const cause = error instanceof Error ? error.cause : undefined
  const code = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const candidate = (value as { code?: unknown }).code
    return typeof candidate === 'string' && ERROR_CODES.has(candidate)
      ? candidate
      : undefined
  }
  const errorCode = code(error) ?? code(cause) ?? 'unknown'
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
