/** Classify only structured native error variants; never retain provider messages or details. */
export function channelNativeFailureCode(turn: unknown): string {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return 'NATIVE_TURN_FAILED'
  const row = turn as Record<string, unknown>
  if (row.status !== 'failed' || !row.error || typeof row.error !== 'object' || Array.isArray(row.error)) {
    return 'NATIVE_TURN_FAILED'
  }
  const info = (row.error as Record<string, unknown>).codexErrorInfo
  if (info === 'unauthorized') return 'NATIVE_MODEL_AUTH_FAILED'
  if (info === 'usageLimitExceeded') return 'NATIVE_MODEL_RATE_LIMITED'
  if (info === 'serverOverloaded') return 'NATIVE_MODEL_SERVICE_UNAVAILABLE'
  if (!info || typeof info !== 'object' || Array.isArray(info)) return 'NATIVE_TURN_FAILED'
  const variants = Object.entries(info as Record<string, unknown>)
  if (variants.length !== 1) return 'NATIVE_TURN_FAILED'
  const [kind, value] = variants[0]!
  if (
    ![
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
    ].includes(kind) || !value || typeof value !== 'object' || Array.isArray(value)
  ) {
    return 'NATIVE_TURN_FAILED'
  }
  const details = value as Record<string, unknown>
  if (Object.keys(details).length !== 1 || !Object.hasOwn(details, 'httpStatusCode')) return 'NATIVE_TURN_FAILED'
  const status = details.httpStatusCode
  if (status === null) return 'NATIVE_MODEL_CONNECTION_FAILED'
  if (!Number.isSafeInteger(status) || Number(status) < 100 || Number(status) > 599) return 'NATIVE_TURN_FAILED'
  if (status === 401 || status === 403) return 'NATIVE_MODEL_AUTH_FAILED'
  if (status === 429) return 'NATIVE_MODEL_RATE_LIMITED'
  if (status === 408) return 'NATIVE_MODEL_CONNECTION_FAILED'
  if (Number(status) >= 500) return 'NATIVE_MODEL_SERVICE_UNAVAILABLE'
  return 'NATIVE_TURN_FAILED'
}
