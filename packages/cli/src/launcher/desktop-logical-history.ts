import { isDeepStrictEqual } from 'node:util'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { LogicalContinuationReader } from './logical-continuation-reader.js'
import { logicalHistoryToolCall } from './logical-continuation-tool.js'
import { channelHistoryChain } from './channel-logical-history-chain.js'
import { logicalHistoryChainPage } from './logical-history-chain-page.js'
import { jointHistoryCurrentEvent, jointHistorySourceAllowed } from './channel-joint-history.js'

/** Identity must be tied by the Host to this live native turn, never supplied by the tool. */
export function createDesktopLogicalHistory(input: {
  owner: ProfileLogicalConversationOwner
  native: ChannelNativeSessions
  appId: string
  profileId: string
  activeIdentity(threadId: string, turnId: string): Promise<string | undefined>
}) {
  const caller = async (threadId: string, turnId: string) => {
    if (!input.owner.store.hasCommitBarrier() || !await input.native.logicalTurnActive(threadId, turnId)) {
      return undefined
    }
    const identity = await input.activeIdentity(threadId, turnId)
    if (!identity || !await input.native.logicalTurnActive(threadId, turnId)) return undefined
    const actor = { principal: identity, scope: `desktop:${input.appId}:${input.profileId}` }
    return {
      session: { hostId: 'local', appId: input.appId, profileId: input.profileId, sessionId: threadId },
      turnId,
      actorKey: JSON.stringify(actor),
    }
  }
  const reader = new LogicalContinuationReader({
    relation: async current => {
      const logical = input.owner.store.snapshot().logicalContinuations
      const matches = Object.values(logical?.relations ?? {}).filter(relation =>
        relation.mode === 'linked' && isDeepStrictEqual(relation.destination, current.session)
        && logical?.intents[relation.operationId]?.state === 'applied'
        && JSON.stringify(logical.intents[relation.operationId]?.actor) === current.actorKey
      )
      return matches.length === 1 && matches[0]?.mode === 'linked' ? matches[0] : undefined
    },
    authorized: async (current, relation, pageSource) => {
      if (!isDeepStrictEqual(await caller(current.session.sessionId, current.turnId), current)) return false
      const state = input.owner.store.snapshot()
      const intent = state.logicalContinuations?.intents[relation.operationId]
      const jointActor = intent?.channelHistoryActor
      if (jointActor) {
        const event = jointHistoryCurrentEvent(state, relation.destination, jointActor)
        if (
          !event || !jointHistorySourceAllowed(state, relation.source, event, intent.actor.principal)
          || await input.native.logicalOwnerIdentity() !== intent.actor.principal
        ) return false
      }
      const chain = channelHistoryChain(state, relation, current.actorKey)
      const end = chain.findIndex(link => isDeepStrictEqual(link.source, pageSource ?? relation.source))
      if (end < 0) return false
      for (const link of chain.slice(0, end + 1)) {
        if (
          await input.native.logicalSourceVersion(link.source) !== link.version
          || jointActor && !await input.native.logicalJointSourceRoot(link.source)
        ) return false
      }
      return !jointActor || await input.native.logicalOwnerIdentity() === intent?.actor.principal
          && await input.native.logicalJointSourceRoot(relation.source)
          && isDeepStrictEqual(input.owner.store.snapshot(), state)
    },
    page: async (_source, cursor, current, relation) => {
      if (!current || !relation) throw new Error('NATIVE_BACKEND_UNAVAILABLE')
      return await logicalHistoryChainPage(input.owner.store, input.native, cursor, current, relation)
    },
  })
  return (params: unknown) => logicalHistoryToolCall(params, { activeCaller: caller }, reader)
}
