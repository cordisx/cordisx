import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { LogicalHistoryRelation } from './logical-continuation-reader.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { sameConversation } from './channel-conversation-refs.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelCommandDenied, channelPolicyAllows } from './channel-conversation-policy.js'
import { channelTaskChangeAllowed, channelTaskChangeDenied, channelTaskFields } from './channel-task-config.js'

/** Revalidate the transport actor and group grant on every history page. */
export function channelGroupHistoryAuthorized(
  state: ChannelConversationState,
  event: ChannelEventRef,
  relation: LogicalHistoryRelation,
): boolean {
  const intent = state.logicalContinuations?.intents[relation.operationId], projection = intent?.groupProjection
  const binding = projection && state.bindings[projection.bindingId]
  if (
    !intent || intent.state !== 'applied' || !projection || projection.revoked || !binding
    || binding.state !== 'active' || binding.mode !== 'deliver' || binding.sessionId !== relation.destination.sessionId
    || binding.hostId !== relation.destination.hostId || binding.profileId !== relation.destination.profileId
    || Object.values(state.bindings).filter(row => row.state === 'active' && row.sessionId === binding.sessionId).length
      !== 1
    || binding.channel.kind !== 'group' || event.kind !== 'group'
    || !sameConversation(binding.channel, projection.group) || !sameConversation(binding.channel, event)
    || !event.actor?.userId || event.actor.adapterId !== event.adapterId || event.actor.accountId !== event.accountId
    || event.actor.tenantId !== event.tenantId || !state.policy.enabled || !channelDispatchAllowed(state, event)
    || projection.expiresAt <= Date.now() || projection.policyRevision !== state.policyRevision
    || projection.taskConfigRevision !== state.taskConfigRevision
  ) return false
  const admin: ChannelEventRef = {
    ...binding.channel,
    eventId: 'group-history',
    actor: {
      adapterId: binding.channel.adapterId,
      accountId: binding.channel.accountId,
      tenantId: binding.channel.tenantId,
      userId: projection.authorizer.principal,
    },
  }
  const target = intent.request.target
  const effort = intent.evidence.sourceConfiguration.execution.effort
  const selection = {
    ...target,
    ...(effort === undefined ? {} : { effort }),
    fast: intent.evidence.sourceConfiguration.serviceTier === 'priority',
  }
  const denied = (actor: ChannelEventRef) =>
    [...channelTaskFields(target), 'continue-provider', 'task-settings'].some(command =>
      channelCommandDenied(state.policy, actor, command)
    )
    || channelTaskChangeDenied(state.taskConfig, state.policy, actor, target, selection)
  return isDeepStrictEqual(channelLogicalActor(admin), projection.authorizer)
    && channelPolicyAllows(state.policy, 'command', admin, 'allow-user')
    && channelPolicyAllows(state.policy, 'command', admin, 'continue-provider')
    && !denied(admin) && !denied(event)
    && channelTaskChangeAllowed(state.taskConfig, state.policy, admin, target, selection)
}
