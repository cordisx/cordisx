import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { channelLogicalContinuationAdmitted } from './channel-logical-continuation-scope.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelIdlePriorityOperation, channelIdlePriorityUncertain } from './channel-idle-priority-status.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'

/** User acknowledges an orphan may exist; no native effect is repeated or removed. */
export async function abandonChannelLogicalContinuation(input: {
  store: ChannelConversationStore
  fence: ChannelNativeSourceFence
  claims: Set<string>
  appId: string
  profileId: string
  event: ChannelEventRef
  operationId: string
}) {
  const prior = input.store.snapshot().logicalContinuations?.intents[input.operationId]
  if (!prior || !isDeepStrictEqual(prior.actor, channelLogicalActor(input.event))) return false
  const source = prior.request.source
  if (
    source.hostId !== 'local' || source.appId !== input.appId || source.profileId !== input.profileId
    || input.claims.has(source.sessionId)
  ) return false
  const release = input.fence.beginMigration(source.sessionId)
  if (!release) return false
  input.claims.add(source.sessionId)
  try {
    return await channelLogicalTransactionStore(input.store).mutate(state => {
      const intent = state.logicalContinuations!.intents[input.operationId]
      if (
        !intent || intent.state !== 'unknown' || !isDeepStrictEqual(intent.actor, channelLogicalActor(input.event))
        || !channelLogicalContinuationAdmitted(state, input.event, input.profileId, source.sessionId)
      ) return false
      for (const job of Object.values(state.jobs)) {
        if (channelIdlePriorityOperation(job.id) !== input.operationId || !channelIdlePriorityUncertain(state, job)) {
          continue
        }
        job.state = 'cancelled'
        removeChannelIdlePriorityGrant(state.logicalContinuations!, job.bindingId ?? '')
      }
      if (intent.destination) intent.orphanDestination = structuredClone(intent.destination)
      delete intent.destination
      intent.state = 'rejected'
      intent.code = 'USER_ABANDONED_UNKNOWN'
      return true
    })
  } finally {
    input.claims.delete(source.sessionId)
    release()
  }
}
