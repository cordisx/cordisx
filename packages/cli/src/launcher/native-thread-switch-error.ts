export type NativeThreadSwitchReason = 'provider-switch-unsupported' | 'provider-switch-reconciliation-required'

/** Only fixed native-switch outcomes cross the private control boundary. */
export class NativeThreadSwitchError extends Error {
  constructor(readonly reason: NativeThreadSwitchReason) {
    super('Native switch rejected')
  }
}

export function nativeThreadSwitchReason(error: unknown): NativeThreadSwitchReason | undefined {
  return error instanceof NativeThreadSwitchError ? error.reason : undefined
}
