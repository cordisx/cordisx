import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { LogicalHistoryCaller, LogicalHistoryRelation } from './logical-continuation-reader.js'
import { channelHistoryChain } from './channel-logical-history-chain.js'
import { projectChannelNativeItems } from './channel-logical-history-projection.js'

/** Read a bounded chain with source versions and Host-envelope projection shared by both entry points. */
export async function logicalHistoryChainPage(
  store: ChannelConversationStore,
  native: ChannelNativeSessions,
  cursor: string | undefined,
  current: LogicalHistoryCaller,
  relation: LogicalHistoryRelation,
) {
  const chain = channelHistoryChain(store.snapshot(), relation, current.actorKey)
  let index = 0, nativeCursor: string | undefined
  if (cursor) {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { index?: unknown; native?: unknown }
    if (
      !Number.isSafeInteger(raw.index) || Number(raw.index) < 0 || Number(raw.index) >= chain.length
      || raw.native !== undefined && (typeof raw.native !== 'string' || !raw.native)
    ) throw new Error('HISTORY_CURSOR_INVALID')
    index = Number(raw.index)
    nativeCursor = raw.native as string | undefined
  }
  for (; index < chain.length; index++) {
    const link = chain[index]!
    for (const earlier of chain.slice(0, index + 1)) {
      if (await native.logicalSourceVersion(earlier.source) !== earlier.version) {
        throw new Error('HISTORY_SOURCE_CHANGED')
      }
    }
    const page = await native.logicalHistoryPage(link.source, nativeCursor)
    const next = page.nextCursor
      ? { index, native: page.nextCursor }
      : index + 1 < chain.length && chain[index + 1]!.categories.length
      ? { index: index + 1 }
      : undefined
    if (page.items.length || !next) {
      const { nextCursor: _nativeNext, turnIds, ...body } = page
      const contextTokens = native.logicalContextTokens(link.source.sessionId)
      if (!contextTokens) throw new Error('HISTORY_REDACTION_UNAVAILABLE')
      const projected = projectChannelNativeItems(
        store.snapshot(),
        link.source.sessionId,
        JSON.stringify(store.snapshot().logicalContinuations?.intents[relation.operationId]?.channelHistoryActor)
          || current.actorKey,
        page.items,
        turnIds,
        contextTokens,
      )
      return {
        ...body,
        ...projected,
        source: link.source,
        historyCategories: link.categories,
        ...(next ? { nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url') } : {}),
      }
    }
    nativeCursor = undefined
  }
  throw new Error('HISTORY_CHAIN_UNAVAILABLE')
}
