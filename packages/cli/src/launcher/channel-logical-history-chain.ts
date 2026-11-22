import { isDeepStrictEqual } from 'node:util'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { LogicalHistoryCategory } from './logical-continuation-history.js'
import type { LogicalHistoryRelation, LogicalSessionRef } from './logical-continuation-reader.js'

/** Trace only committed links owned by this same actor, intersecting every prior consent. */
export function channelHistoryChain(
  state: ChannelConversationState,
  relation: LogicalHistoryRelation,
  actorKey: string,
) {
  const logical = state.logicalContinuations
  const chain: { source: LogicalSessionRef; version: string; categories: readonly LogicalHistoryCategory[] }[] = []
  let current = relation
  let categories: readonly LogicalHistoryCategory[] = relation.historyCategories
  const seen = new Set<string>()
  for (let depth = 0; depth < 16; depth++) {
    const intent = logical?.intents[current.operationId]
    const stored = logical?.relations[current.operationId]
    if (
      !intent || intent.state !== 'applied'
      || JSON.stringify(intent.actor) !== actorKey && JSON.stringify(intent.channelHistoryActor) !== actorKey
      || !stored || stored.mode !== 'linked' || !isDeepStrictEqual(stored.source, current.source)
      || !isDeepStrictEqual(stored.destination, current.destination) || seen.has(current.source.sessionId)
    ) {
      throw new Error('HISTORY_CHAIN_UNAVAILABLE')
    }
    seen.add(current.source.sessionId)
    categories = categories.filter(category => stored.historyCategories.includes(category))
    chain.push({ source: stored.source, version: intent.evidence.sourceHistoryVersion, categories })
    const parents = Object.values(logical.relations).filter(item =>
      item.logicalConversationId === relation.logicalConversationId
      && isDeepStrictEqual(item.destination, stored.source)
    )
    if (parents.length > 1) throw new Error('HISTORY_CHAIN_UNAVAILABLE')
    const parent = parents[0]
    if (!parent || parent.mode !== 'linked' || categories.length === 0) return chain
    current = parent
  }
  throw new Error('HISTORY_CHAIN_LIMIT')
}
