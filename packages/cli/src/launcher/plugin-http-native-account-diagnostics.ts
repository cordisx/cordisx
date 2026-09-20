/** Host-private unavailable phases; no account values or error payloads enter diagnostics. */
export const HTTP_NATIVE_ACCOUNT_UNAVAILABLE_REASONS = Object.freeze(
  [
    'reader-closed',
    'context-missing',
    'context-unavailable',
    'context-rejected',
    'native-pin-unavailable',
    'native-pin-read-exception',
    'native-module-unavailable',
    'native-capability-unavailable',
    'typed-input-missing',
    'typed-retired',
    'typed-connection',
    'typed-identity',
    'typed-unsupported-auth',
    'typed-read-error',
    'typed-read-exception',
    'typed-not-ready',
    'native-identity-invalid',
    'native-read-timeout',
    'native-read-exception',
    'native-evaluation-exception',
    'native-result-invalid',
    'cdp-read-timeout',
    'cdp-read-exception',
    'authority-native-epoch-obsolete',
    'authority-native-read-exception',
    'legacy-input-missing',
    'legacy-read-exception',
  ] as const,
)
export type HttpNativeAccountUnavailableReason = typeof HTTP_NATIVE_ACCOUNT_UNAVAILABLE_REASONS[number]
export function isHttpNativeAccountUnavailableReason(value: unknown): value is HttpNativeAccountUnavailableReason {
  return typeof value === 'string' && (HTTP_NATIVE_ACCOUNT_UNAVAILABLE_REASONS as readonly string[]).includes(value)
}

/** A failed calling context is not an observation of the owner's Native identity. */
export class HttpNativeCallingContextUnavailableError extends Error {
  constructor(readonly reason: 'reader-closed' | 'context-missing' | 'context-unavailable' | 'context-rejected') {
    super('native calling context unavailable')
  }
}
export type HttpNativeAccountValue = string | null | HttpNativeCallingContextUnavailableError
