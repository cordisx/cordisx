import { isDeepStrictEqual } from 'node:util'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { LogicalContinuationReader } from './logical-continuation-reader.js'
import { logicalHistoryToolCall } from './logical-continuation-tool.js'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import { jointHistoryCurrentEvent, jointHistorySourceAllowed } from './channel-joint-history.js'
import { channelHistoryChain } from './channel-logical-history-chain.js'
import { logicalHistoryChainPage } from './logical-history-chain-page.js'
import { channelGroupHistoryAuthorized } from './channel-group-history-authority.js'

export function callChannelLogicalHistory(
  handler: ReturnType<typeof createChannelLogicalHistory> | undefined,
  params: unknown,
) {
  return handler?.(params)
    ?? Promise.resolve({
      success: false,
      contentItems: [{ type: 'inputText' as const, text: '{"status":"unavailable"}' }],
    })
}

export function channelLogicalHistoryAvailable(
  state: ChannelConversationState,
  event: ChannelEventRef,
  sessionId?: string,
) {
  const logical = state.logicalContinuations
  return !!sessionId
    && Object.values(logical?.relations ?? {}).some(relation =>
      relation.mode === 'linked' && relation.destination.sessionId === sessionId
      && logical?.intents[relation.operationId]?.state === 'applied'
      && (event.kind === 'group'
        ? channelGroupHistoryAuthorized(state, event, relation)
        : [logical.intents[relation.operationId]?.actor, logical.intents[relation.operationId]?.channelHistoryActor]
          .some(actor => JSON.stringify(actor) === JSON.stringify(channelLogicalActor(event))))
    )
}

/** The caller comes from a live Host-owned Channel turn, not native tool arguments. */
export function createChannelLogicalHistory(input: {
  store: ChannelConversationStore
  native: () => ChannelNativeSessions | undefined
  appId: string
  profileId: string
}) {
  const caller = async (threadId: string, turnId: string) => {
    const native = input.native(), event = await native?.sourceForLogicalTurn(threadId, turnId)
    const actor = event && channelLogicalActor(event)
    if (
      !native || !event || !actor?.principal || !['direct', 'group'].includes(event.kind)
      || event.actor?.adapterId !== event.adapterId || event.actor?.accountId !== event.accountId
      || event.actor?.tenantId !== event.tenantId || !await native.logicalTurnActive(threadId, turnId)
    ) return undefined
    return {
      session: { hostId: 'local', appId: input.appId, profileId: input.profileId, sessionId: threadId },
      turnId,
      actorKey: JSON.stringify(actor),
    }
  }
  const reader = new LogicalContinuationReader({
    relation: async current => {
      const state = input.store.snapshot(), logical = state.logicalContinuations
      const event = await input.native()?.sourceForLogicalTurn(current.session.sessionId, current.turnId)
      const matches = Object.values(logical?.relations ?? {}).filter(relation =>
        relation.mode === 'linked' && isDeepStrictEqual(relation.destination, current.session)
        && logical?.intents[relation.operationId]?.state === 'applied'
        && (event?.kind === 'group'
          ? channelGroupHistoryAuthorized(state, event, relation)
          : [logical.intents[relation.operationId]?.actor, logical.intents[relation.operationId]?.channelHistoryActor]
            .some(actor => JSON.stringify(actor) === current.actorKey))
      )
      const relation = matches.length === 1 ? matches[0] : undefined
      return relation?.mode === 'linked' ? relation : undefined
    },
    authorized: async (current, relation, pageSource) => {
      const native = input.native(),
        event = await native?.sourceForLogicalTurn(current.session.sessionId, current.turnId)
      if (!event || JSON.stringify(channelLogicalActor(event)) !== current.actorKey) return false
      const state = input.store.snapshot()
      if (event.kind === 'group') {
        return (!pageSource || isDeepStrictEqual(pageSource, relation.source))
          && channelGroupHistoryAuthorized(state, event, relation)
      }
      const active = Object.values(state.bindings).filter(binding =>
        binding.state === 'active' && binding.sessionId === current.session.sessionId
      )
      const { adapterId, accountId, tenantId, conversationId, threadId, kind, semantics } = event
      if (
        !(state.policy.enabled && channelPolicyAllows(state.policy, 'dispatch', event)
          && active.length === 1 && active[0]!.hostId === 'local' && active[0]!.profileId === input.profileId
          && isDeepStrictEqual(active[0]!.channel, {
            adapterId,
            accountId,
            tenantId,
            conversationId,
            threadId,
            kind,
            semantics,
          }))
      ) return false
      if (!native) return false
      const intent = state.logicalContinuations?.intents[relation.operationId]
      const jointActor = intent?.channelHistoryActor
      if (jointActor) {
        const jointEvent = jointHistoryCurrentEvent(state, relation.destination, jointActor)
        if (
          !jointEvent || !jointHistorySourceAllowed(state, relation.source, jointEvent, intent.actor.principal)
          || await native.logicalOwnerIdentity() !== intent.actor.principal
        ) return false
      }
      const chain = channelHistoryChain(state, relation, current.actorKey)
      const end = chain.findIndex(link => isDeepStrictEqual(link.source, pageSource ?? relation.source))
      if (end < 0) return false
      for (const link of chain.slice(0, end + 1)) {
        if (
          await native.logicalSourceVersion(link.source) !== link.version
          || jointActor && !await native.logicalJointSourceRoot(link.source)
        ) return false
      }
      return !jointActor || await native.logicalOwnerIdentity() === intent?.actor.principal
          && await native.logicalJointSourceRoot(relation.source)
          && isDeepStrictEqual(input.store.snapshot(), state)
    },
    page: async (_source, cursor, current, relation) => {
      const native = input.native()
      if (!native || !current || !relation) throw new Error('NATIVE_BACKEND_UNAVAILABLE')
      const projection = input.store.snapshot().logicalContinuations?.intents[relation.operationId]?.groupProjection
      if (projection) {
        if (cursor !== undefined) throw new Error('HISTORY_CURSOR_INVALID')
        return {
          source: relation.source,
          historyCategories: relation.historyCategories,
          omitted: ['unsupported' as const, 'attachment' as const],
          items: projection.entries.map(entry =>
            entry.role === 'user'
              ? { type: 'userMessage', content: [{ type: 'text', text: entry.text }] }
              : { type: 'agentMessage', text: entry.text }
          ),
        }
      }
      return await logicalHistoryChainPage(input.store, native, cursor, current, relation)
    },
  })
  return (params: unknown) => logicalHistoryToolCall(params, { activeCaller: caller }, reader)
}
