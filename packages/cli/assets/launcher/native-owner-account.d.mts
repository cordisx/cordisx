export function nativeOwnerIdentity(value: unknown): string | undefined
export function dispatchNativeRecoveryAccount(message: unknown, ports: unknown): boolean
export function nativeAccountBridge(callPeer: (request: Record<string, unknown>) => Promise<unknown>): {
  nativeOwnerIdentity(): Promise<string | undefined>
  nativeRecoveryAccount(): Promise<unknown>
}
