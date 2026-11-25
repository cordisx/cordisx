import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import type { ChannelConversationState } from './channel-conversation-store.js'
import { channelIdlePriorityUncertain } from './channel-idle-priority-status.js'

/**
 * A deliberately narrow first boundary: the event must be authenticated by the Channel transport,
 * the conversation must be direct, and a native source must have exactly one active binding.
 * A group or multiply bound source requires a future explicit multi-recipient consent contract.
 */
export function channelLogicalContinuationAdmitted(
  state: ChannelConversationState,
  event: ChannelEventRef,
  profileId: string,
  sourceSessionId: string,
): boolean {
  const actor = event.actor
  if (
    !state.policy.enabled || event.kind !== 'direct' || !actor || !profileId || !sourceSessionId
    || !event.adapterId || !event.accountId || !event.tenantId || !event.conversationId || !event.threadId
    || !actor.userId || actor.adapterId !== event.adapterId || actor.accountId !== event.accountId
    || actor.tenantId !== event.tenantId || !channelPolicyAllows(state.policy, 'dispatch', event)
    || !channelPolicyAllows(state.policy, 'command', event, 'task-settings')
  ) return false
  const active = Object.values(state.bindings).filter(binding =>
    binding.state === 'active' && binding.sessionId === sourceSessionId
  )
  if (active.length !== 1) return false
  const binding = active[0]!
  const { adapterId, accountId, tenantId, conversationId, threadId, kind, semantics } = event
  if (
    binding.hostId !== 'local' || binding.profileId !== profileId
    || !isDeepStrictEqual(binding.channel, {
      adapterId,
      accountId,
      tenantId,
      conversationId,
      threadId,
      kind,
      semantics,
    })
  ) return false
  if (
    Object.values(state.jobs).some(job =>
      job.sessionId === sourceSessionId
      && !['queued', 'completed', 'failed', 'cancelled'].includes(job.state)
      && !channelIdlePriorityUncertain(state, job)
    )
    || Object.values(state.taskRequests).some(request =>
      request.threadId === sourceSessionId
      && !['applied', 'denied', 'expired'].includes(request.state)
    )
    || !!state.taskSettings[sourceSessionId] && state.taskSettings[sourceSessionId]?.application !== 'applied'
    || !!state.taskSettings[sourceSessionId]?.pending || !!state.taskSettings[sourceSessionId]?.pendingPatch
  ) return false
  const continuation = state.continuations[sourceSessionId]?.intent
  const live = state.liveTakeovers[sourceSessionId]
  return (!continuation || continuation.state === 'completed')
    && (!live || ['finished', 'abandoned'].includes(live.state))
}
