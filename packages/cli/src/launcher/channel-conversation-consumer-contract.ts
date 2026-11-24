import type { ChannelPluginIdentity } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'

export interface ChannelConversationConsumerInput {
  readonly appId?: string
  /** Enabled only when the owner wires native write fencing and dynamic history callbacks. */
  readonly logicalRuntime?: boolean
  /** Wait for the shared Desktop native fence recovery before consuming jobs. */
  readonly logicalRecoveryRequired?: boolean
  readonly profileId: string
  readonly access: () => ChannelConversationAccess | undefined
  readonly native: () =>
    | (
      & Pick<ChannelNativeSessions, 'exists' | 'start' | 'completion' | 'reconcile'>
      & Partial<
        Pick<
          ChannelNativeSessions,
          | 'liveTurnControl'
          | 'steer'
          | 'steerObserved'
          | 'progressReminder'
          | 'analyzeUserMemory'
          | 'taskSelection'
          | 'creationSelection'
          | 'priorityPreflight'
        >
      >
    )
    | undefined
  readonly report?: (code: string) => void
}

export const CALLER: ChannelPluginIdentity = {
  source: 'cordisx:channel-consumer',
  pluginId: 'host-channel-consumer',
  generation: 'profile',
}
export const isThread = (id: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)
