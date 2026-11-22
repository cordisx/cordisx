import { ChannelConversationStore } from './channel-conversation-store.js'
import { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import { DesktopChannelGrants } from './desktop-channel-grants.js'

/** One profile runtime owns this store and shares its source fence with every entry point. */
export function profileLogicalConversationOwner(store: ChannelConversationStore) {
  const fence = new ChannelNativeSourceFence(threadId =>
    ChannelConversationStore.logicalSessionFenced(store.snapshot(), threadId)
  )
  const desktopChannelGrants = new DesktopChannelGrants()
  let recoveryProbe: ((sources: readonly string[]) => Promise<boolean>) | undefined
  return {
    store,
    fence,
    desktopChannelGrants,
    bindRecoveryProbe(probe: (sources: readonly string[]) => Promise<boolean>) {
      if (recoveryProbe) throw new Error('LOGICAL_RECOVERY_ALREADY_BOUND')
      recoveryProbe = probe
    },
    canAbandon(sources: readonly string[]) {
      return recoveryProbe?.(sources) ?? Promise.resolve(false)
    },
  }
}
export type ProfileLogicalConversationOwner = ReturnType<typeof profileLogicalConversationOwner>
