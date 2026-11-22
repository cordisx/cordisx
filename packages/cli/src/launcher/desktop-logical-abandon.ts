import { isDeepStrictEqual } from 'node:util'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'

/** Local user accepts a possible orphan; no native operation is retried or removed. */
export async function abandonDesktopLogicalContinuation(
  owner: ProfileLogicalConversationOwner,
  appId: string,
  profileId: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const args = value as Record<string, unknown>
  const valid = (item: unknown): item is string =>
    typeof item === 'string' && !!item && item.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(item)
  if (
    Object.keys(args).some(key => !['sessionId', 'operationId', 'confirmOrphanPossible'].includes(key))
    || !valid(args.sessionId) || !valid(args.operationId) || args.confirmOrphanPossible !== true
  ) {
    throw new Error('INVALID_REQUEST')
  }
  if (!owner.store.hasCommitBarrier()) throw new Error('LOGICAL_RECOVERY_UNAVAILABLE')
  const prior = owner.store.snapshot().logicalContinuations?.intents[args.operationId]
  if (
    !prior || prior.state !== 'unknown' || prior.actor.scope !== `desktop:${appId}:${profileId}`
    || prior.request.source.hostId !== 'local' || prior.request.source.appId !== appId
    || prior.request.source.profileId !== profileId || prior.request.source.sessionId !== args.sessionId
  ) {
    throw new Error('OPERATION_UNAVAILABLE')
  }
  const sources = [args.sessionId, ...(prior.destination ? [prior.destination.sessionId] : [])]
  const releases: Array<() => void> = []
  try {
    for (const source of sources) {
      const release = owner.fence.beginMigration(source)
      if (!release) throw new Error('LOGICAL_RECOVERY_BUSY')
      releases.push(release)
    }
    if (!await owner.canAbandon(sources) || !owner.store.hasCommitBarrier()) {
      throw new Error('LOGICAL_RECOVERY_BUSY')
    }
    return await channelLogicalTransactionStore(owner.store).mutate(state => {
      const current = state.logicalContinuations!.intents[args.operationId as string]
      if (!isDeepStrictEqual(current, prior)) throw new Error('OPERATION_CHANGED')
      if (current!.destination) current!.orphanDestination = structuredClone(current!.destination)
      delete current!.destination
      current!.state = 'rejected'
      current!.code = 'USER_ABANDONED_UNKNOWN'
      return { status: 'ok' as const, orphanPossible: true as const }
    })
  } finally {
    releases.reverse().forEach(release => release())
  }
}
