/** Shared validation for the private native control socket. */
export const MAX_LINE = 256 * 1024
export const TIMEOUT = 30_000
export const valid = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export const requestId = (value: unknown): value is string | number =>
  (typeof value === 'string' && valid(value)) || (typeof value === 'number' && Number.isSafeInteger(value))
export const processId = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

export function rejectionReason(error: unknown): string {
  const reasons: Readonly<Record<string, string>> = {
    'Invalid control id': 'invalid-id',
    'Unauthenticated response': 'unauthenticated-response',
    'Unknown control response': 'unknown-response',
    'Unauthenticated diagnostic': 'unauthenticated-diagnostic',
    'Invalid control authentication': 'invalid-authentication',
    'Control unavailable': 'control-unavailable',
    'Invalid native thread': 'invalid-thread',
    'Invalid native request id': 'invalid-request-id',
  }
  return error instanceof Error ? reasons[error.message] ?? 'protocol-validation' : 'protocol-validation'
}
