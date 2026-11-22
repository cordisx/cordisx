import { isDeepStrictEqual } from 'node:util'
import type { ChannelConversationStore } from './channel-conversation-store.js'

/** Local inspection discloses session boundaries, never actor identity or history. */
export function logicalContinuationChain(
  store: ChannelConversationStore,
  appId: string,
  profileId: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const args = value as Record<string, unknown>
  if (
    Object.keys(args).some(key => key !== 'sessionId') || typeof args.sessionId !== 'string' || !args.sessionId
    || args.sessionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(args.sessionId)
  ) throw new Error('INVALID_REQUEST')
  const logical = store.snapshot().logicalContinuations
  let destination = { hostId: 'local', appId, profileId, sessionId: args.sessionId }
  let logicalId: string | undefined
  const seen = new Set<string>(), links = []
  for (let depth = 0; depth <= 16; depth++) {
    if (seen.has(destination.sessionId)) throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
    seen.add(destination.sessionId)
    const matches = Object.values(logical?.relations ?? {}).filter(relation =>
      isDeepStrictEqual(relation.destination, destination)
    )
    if (matches.length > 1) throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
    const relation = matches[0]
    if (!relation) return { status: 'ok' as const, links: links.reverse() }
    if (depth === 16) throw new Error('LOGICAL_CHAIN_LIMIT')
    if (
      logical?.intents[relation.operationId]?.state !== 'applied'
      || logicalId && logicalId !== relation.logicalConversationId
      || relation.source.hostId !== 'local' || relation.source.appId !== appId
      || relation.source.profileId !== profileId
    ) {
      throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
    }
    logicalId = relation.logicalConversationId
    links.push({
      source: relation.source.sessionId,
      destination: relation.destination.sessionId,
      mode: relation.mode,
      target: relation.target,
      ...(relation.mode === 'linked'
        ? { historyCategories: relation.historyCategories, handoff: relation.handoff }
        : {}),
    })
    destination = relation.source
  }
  throw new Error('LOGICAL_CHAIN_LIMIT')
}
