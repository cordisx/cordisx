import type { ChannelConversationState } from './channel-conversation-store.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'

/** Export identities only; request contents, actor and credentials stay in the owner. */
export function profileLogicalFenceProjection(state: ChannelConversationState) {
  const sources = new Set<string>()
  for (const intent of Object.values(state.logicalContinuations?.intents ?? {})) {
    if (!['creating', 'unknown'].includes(intent.state)) continue
    sources.add(intent.request.source.sessionId)
    if (intent.destination) sources.add(intent.destination.sessionId)
  }
  return { revision: state.revision, sources: [...sources].sort() }
}

/** Install before the native peer accepts Desktop work, and await every subsequent committed projection. */
export async function bindProfileLogicalFences(
  owner: ProfileLogicalConversationOwner,
  native: { restoreLogicalFences(revision: number, sources: readonly string[]): Promise<boolean> },
  onReady?: () => void,
) {
  await owner.store.bindCommitBarrier(async state => {
    const projection = profileLogicalFenceProjection(state)
    if (!await native.restoreLogicalFences(projection.revision, projection.sources)) {
      throw new Error('LOGICAL_FENCE_SYNC_UNAVAILABLE')
    }
  }, onReady)
}
