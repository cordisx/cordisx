export type NativeAdapterPreparationErrorCode = 'cancelled' | 'worker' | 'identity' | 'analysis'
export class NativeAdapterPreparationError extends Error {
  constructor(readonly code: NativeAdapterPreparationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NativeAdapterPreparationError'
  }
}
export function checkPreparationSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NativeAdapterPreparationError('cancelled', 'Native adapter preparation cancelled')
}
