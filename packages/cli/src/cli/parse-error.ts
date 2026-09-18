export type CordisXCliParseErrorCode =
  | 'unknown-option'
  | 'duplicate-option'
  | 'missing-option-value'
  | 'invalid-option-value'
  | 'unexpected-positional'
  | 'unexpected-host-arguments'
  | 'unsupported-option'
  | 'conflicting-options'

export class CordisXCliParseError extends Error {
  readonly code: CordisXCliParseErrorCode

  constructor(code: CordisXCliParseErrorCode, message: string) {
    super(message)
    this.name = 'CordisXCliParseError'
    this.code = code
  }
}
