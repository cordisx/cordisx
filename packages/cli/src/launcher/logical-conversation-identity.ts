import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { LogicalContinuationState } from './logical-continuation-control.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'

/** Resolve one Host conversation identity for Desktop and Channel, preserving experimental preference keys. */
export function logicalConversationIdentity(state: LogicalContinuationState | undefined, source: LogicalSessionRef) {
  const parents = Object.values(state?.relations ?? {}).filter(relation =>
    isDeepStrictEqual(relation.destination, source)
  )
  if (parents.length > 1) return undefined
  if (parents[0]) return parents[0].logicalConversationId
  const digest = createHash('sha256').update(JSON.stringify({
    hostId: source.hostId,
    appId: source.appId,
    profileId: source.profileId,
    sessionId: source.sessionId,
  })).digest('hex')
  const legacy = ['desktop:' + digest, 'channel-logical:' + digest].filter(id => {
    const key = JSON.stringify(['conversation', id])
    return state?.preferences?.[key] !== undefined || state?.preferenceRevisions?.[key] !== undefined
  })
  if (legacy.length > 1) return undefined
  return legacy[0] ?? 'logical:' + digest
}
