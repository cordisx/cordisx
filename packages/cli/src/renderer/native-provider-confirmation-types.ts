import type { PendingNativeProviderSelection } from './native-provider-selection-client.js'

export interface NativeProviderSubmitConfirmation {
  readonly confirmationId: string
  readonly expectedSelectionRevision: number
  readonly target: PendingNativeProviderSelection
  readonly threadId: string
  readonly logical?: Readonly<
    {
      recommended: 'linked' | 'fork'
      forkAvailable: boolean
      linkedAvailable: boolean
      legacyFreshPreference?: boolean
      chain?: LogicalChain
      channelBound?: boolean
      channelChallenge?: string
    }
  >
}
export interface LogicalChain {
  readonly links: readonly Readonly<{ source: string; destination: string; mode: 'linked' | 'fork' | 'fresh' }>[]
  readonly truncated: boolean
}
