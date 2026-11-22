import { isDeepStrictEqual } from 'node:util'
import type { LogicalContinuationState } from './logical-continuation-control.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'

/** Show only boundaries already committed for this active Desktop account. */
export function desktopLogicalChain(
  logical: LogicalContinuationState | undefined,
  source: LogicalSessionRef,
  identity: string,
) {
  let destination = source, logicalId: string | undefined
  const seen = new Set<string>(),
    links: Array<{ source: string; destination: string; mode: 'linked' | 'fork' | 'fresh' }> = []
  for (let depth = 0; depth <= 16; depth++) {
    if (seen.has(destination.sessionId)) throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
    seen.add(destination.sessionId)
    const matches = Object.values(logical?.relations ?? {}).filter(relation =>
      isDeepStrictEqual(relation.destination, destination)
    )
    if (matches.length > 1) throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
    const relation = matches[0]
    if (!relation) return { links: links.reverse(), truncated: false }
    if (depth === 16) return { links: links.reverse(), truncated: true }
    const intent = logical?.intents[relation.operationId]
    if (
      !intent || intent.state !== 'applied' || !isDeepStrictEqual(intent.actor, {
        principal: identity,
        scope: `desktop:${source.appId}:${source.profileId}`,
      })
    ) return { links: links.reverse(), truncated: true }
    if (
      logicalId && logicalId !== relation.logicalConversationId || relation.source.hostId !== source.hostId
      || relation.source.appId !== source.appId || relation.source.profileId !== source.profileId
    ) {
      throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
    }
    logicalId = relation.logicalConversationId
    links.push({ source: relation.source.sessionId, destination: relation.destination.sessionId, mode: relation.mode })
    destination = relation.source
  }
  throw new Error('LOGICAL_CHAIN_UNAVAILABLE')
}
