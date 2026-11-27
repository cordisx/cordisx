import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { isDeepStrictEqual } from 'node:util'
import type { ChannelConversationJob, ChannelConversationState } from './channel-conversation-store.js'
import type { ChannelTaskPatch } from './channel-task-config.js'
import { channelTaskChangeAllowed, channelTaskChangeDenied, channelTaskFields } from './channel-task-config.js'
import { channelCommandDenied, channelPolicyAllows } from './channel-conversation-policy.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { sameConversation } from './channel-conversation-refs.js'

/** Scope recovery to one existing group binding and its authenticated, permitted senders. */
export function confirmedGroupRecoveryScope(
  state: ChannelConversationState,
  event: ChannelEventRef,
  profileId: string,
  source: string,
  job: ChannelConversationJob,
  target: { providerId: string; model: string },
  selection: ChannelTaskPatch,
): ChannelEventRef | undefined {
  const binding = job.bindingId && state.bindings[job.bindingId]
  const active = Object.values(state.bindings).filter(row => row.state === 'active' && row.sessionId === source)
  if (
    !state.policy.enabled || !binding || active.length !== 1 || active[0]?.id !== binding.id
    || binding.hostId !== 'local' || binding.profileId !== profileId || binding.mode !== 'deliver'
    || binding.channel.kind !== 'group' || event.kind !== 'group' || !sameConversation(binding.channel, event)
    || !event.actor?.userId || event.actor.adapterId !== event.adapterId || event.actor.accountId !== event.accountId
    || event.actor.tenantId !== event.tenantId || !channelDispatchAllowed(state, event)
    || state.jobs[job.id]?.state !== 'queued' || state.jobs[job.id]?.sessionId !== source
    || !state.inputs[job.recordId]?.accepted || !state.inputs[job.recordId]?.routed
    || !isDeepStrictEqual(state.inputs[job.recordId]?.input.source.event, event)
    || Object.values(state.jobs).some(row =>
      row.sessionId === source
      && !['queued', 'completed', 'failed', 'cancelled'].includes(row.state)
    )
    || Object.values(state.taskRequests).some(row =>
      row.threadId === source
      && !['applied', 'denied', 'expired'].includes(row.state)
    )
    || Object.values(state.logicalContinuations?.intents ?? {}).some(intent =>
      intent.request.source.sessionId === source && (intent.state === 'unknown'
        || intent.state === 'creating' && intent.request.operationId !== 'confirmed-resume:' + job.id)
    )
    || state.liveTakeovers[source] && !['finished', 'abandoned'].includes(state.liveTakeovers[source]!.state)
    || state.continuations[source]?.intent && state.continuations[source]?.intent?.state !== 'completed'
    || state.taskSettings[source] && (state.taskSettings[source]?.application !== 'applied'
        || state.taskSettings[source]?.pending || state.taskSettings[source]?.pendingPatch)
  ) return undefined
  const denied = (actor: ChannelEventRef) =>
    [...channelTaskFields(target), 'continue-provider', 'task-settings'].some(command =>
      channelCommandDenied(state.policy, actor, command)
    ) || channelTaskChangeDenied(state.taskConfig, state.policy, actor, target, { ...selection, ...target })
  for (const queued of Object.values(state.jobs).filter(row => row.sessionId === source && row.state === 'queued')) {
    const record = state.inputs[queued.recordId], origin = record?.input.source.event
    if (
      queued.bindingId !== binding.id || queued.autoCreate || !record?.accepted || !origin
      || origin.kind !== 'group' || !sameConversation(origin, binding.channel) || !origin.actor?.userId
      || origin.actor.adapterId !== origin.adapterId || origin.actor.accountId !== origin.accountId
      || origin.actor.tenantId !== origin.tenantId || !channelDispatchAllowed(state, origin) || denied(origin)
    ) return undefined
  }
  const approvers = Object.values(state.taskRequests).flatMap(request =>
    request.threadId === source && request.state === 'applied' && request.approvedBy
      && request.selection.providerId === target.providerId && request.selection.model === target.model
      && sameConversation(request.approvedBy, binding.channel)
      ? [request.approvedBy]
      : []
  )
  const candidate = [event, ...approvers].find(actor =>
    actor.actor?.userId && actor.actor.adapterId === actor.adapterId && actor.actor.accountId === actor.accountId
    && actor.actor.tenantId === actor.tenantId && sameConversation(actor, binding.channel)
    && channelPolicyAllows(state.policy, 'command', actor, 'allow-user')
    && channelPolicyAllows(state.policy, 'command', actor, 'continue-provider') && !denied(actor)
    && channelTaskChangeAllowed(state.taskConfig, state.policy, actor, target, { ...selection, ...target })
  )
  return candidate?.actor ? { ...binding.channel, eventId: 'group-history', actor: candidate.actor } : undefined
}
