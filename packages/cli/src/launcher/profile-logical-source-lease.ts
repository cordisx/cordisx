import { ChannelConversationStore } from './channel-conversation-store.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'

/** Acquire both owner fences before reading source history or creating a destination. */
export async function acquireProfileLogicalSource(
  owner: ProfileLogicalConversationOwner,
  native: {
    acquireLogicalFence(threadId: string): Promise<string | undefined>
    releaseLogicalFence(threadId: string, lease: string): Promise<boolean>
  },
  threadId: string,
) {
  const releaseLocal = owner.fence.beginMigration(threadId)
  if (!releaseLocal) return { state: 'busy' as const }
  let lease: string | undefined
  try {
    if (ChannelConversationStore.logicalSourceFenced(owner.store.snapshot(), threadId)) {
      releaseLocal()
      return { state: 'busy' as const }
    }
    lease = await native.acquireLogicalFence(threadId)
  } catch {
    // A timeout can follow a successful remote acquisition. Retain the local
    // fence for this owner lifetime; a token that was never received cannot be released.
    return { state: 'unknown' as const }
  }
  if (!lease) {
    releaseLocal()
    return { state: 'busy' as const }
  }
  let released = false, pending: Promise<boolean> | undefined
  return {
    state: 'acquired' as const,
    lease,
    release: () =>
      pending ??= (async () => {
        if (released) return false
        try {
          if (ChannelConversationStore.logicalSourceFenced(owner.store.snapshot(), threadId)) return false
          if (!await native.releaseLogicalFence(threadId, lease)) return false
          releaseLocal()
          released = true
          return true
        } catch {
          return false
        }
      })().finally(() => {
        pending = undefined
      }),
  }
}
