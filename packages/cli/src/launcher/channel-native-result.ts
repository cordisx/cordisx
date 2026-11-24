export interface ChannelNativeTurnResult {
  readonly state: 'running' | 'busy' | 'failed' | 'reconciliation-required'
  readonly sessionId?: string
  readonly turnId?: string
  readonly code?: string
}
export type ChannelNativeReconciliationResult = Omit<ChannelNativeTurnResult, 'state'> & {
  readonly state: 'running' | 'reconciliation-required'
}
