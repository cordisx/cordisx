import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { LogicalContinuationActor } from './logical-continuation-control.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'

/** Follow only earlier joint grants for the same participants; never widen a prior consent. */
export function jointHistorySourceAllowed(
  state: ChannelConversationState,
  source: LogicalSessionRef,
  event: ChannelEventRef,
  desktopIdentity?: string,
): boolean {
  if (event.kind !== 'direct' || !event.actor?.userId) return false
  const actor = channelLogicalActor(event)
  const logical = state.logicalContinuations, seen = new Set<string>()
  let logicalId: string | undefined
  let current = source
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current.sessionId)) return false
    seen.add(current.sessionId)
    if (
      !Object.values(state.jobs).filter(job => job.sessionId === current.sessionId).every(job => {
        const origin = state.inputs[job.recordId]?.input.source.event
        return !!origin && isDeepStrictEqual(channelLogicalActor(origin), actor)
      })
    ) return false
    const parents = Object.values(logical?.relations ?? {}).filter(relation =>
      isDeepStrictEqual(relation.destination, current)
    )
    if (!parents.length) return true
    if (parents.length !== 1 || parents[0]!.mode !== 'linked') return false
    const parent = parents[0]!, intent = logical?.intents[parent.operationId]
    logicalId ??= parent.logicalConversationId
    if (
      !intent || intent.state !== 'applied' || !isDeepStrictEqual(intent.channelHistoryActor, actor)
      || parent.logicalConversationId !== logicalId
      || intent.actor.scope !== `desktop:${source.appId}:${source.profileId}`
      || desktopIdentity !== undefined && intent.actor.principal !== desktopIdentity
    ) return false
    current = parent.source
  }
  return false
}

/** A recommendation must not expose another participant's earlier relationship. */
export function jointHistoryPotential(state: ChannelConversationState, source: LogicalSessionRef, identity: string) {
  const parents = Object.values(state.logicalContinuations?.relations ?? {}).filter(relation =>
    isDeepStrictEqual(relation.destination, source)
  )
  if (!parents.length) return true
  if (parents.length !== 1) return false
  const actor = state.logicalContinuations?.intents[parents[0]!.operationId]?.channelHistoryActor
  const event = actor && jointHistoryCurrentEvent(state, source, actor)
  return !!event && jointHistorySourceAllowed(state, source, event, identity)
}

/** Reconstruct only the authenticated actor's stable scope and require its current binding and permission. */
export function jointHistoryCurrentEvent(
  state: ChannelConversationState,
  destination: LogicalSessionRef,
  actor: LogicalContinuationActor,
): ChannelEventRef | undefined {
  const bindings = Object.values(state.bindings).filter(binding =>
    binding.state === 'active' && binding.sessionId === destination.sessionId
  )
  if (
    bindings.length !== 1 || bindings[0]!.hostId !== destination.hostId
    || bindings[0]!.profileId !== destination.profileId || bindings[0]!.channel.kind !== 'direct'
    || !state.policy.enabled || !actor.principal
  ) return undefined
  const channel = bindings[0]!.channel
  const event: ChannelEventRef = {
    ...channel,
    eventId: 'joint-history',
    actor: {
      adapterId: channel.adapterId,
      accountId: channel.accountId,
      tenantId: channel.tenantId,
      userId: actor.principal,
    },
  }
  return isDeepStrictEqual(channelLogicalActor(event), actor)
      && channelPolicyAllows(state.policy, 'dispatch', event)
      && channelPolicyAllows(state.policy, 'command', event, 'continue-provider')
    ? event
    : undefined
}
