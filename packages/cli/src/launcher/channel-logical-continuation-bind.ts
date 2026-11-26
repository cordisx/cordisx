import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import type { ChannelConversationState } from './channel-conversation-store.js'
import {
  channelLogicalContinuationAdmitted,
  type ChannelTaskContinuationClaim,
} from './channel-logical-continuation-scope.js'

export function channelLogicalDestinationAvailable(
  state: ChannelConversationState,
  source: string,
  destination: string,
) {
  return !!destination && source !== destination
    && !Object.values(state.bindings).some(binding => binding.sessionId === destination)
    && !state.taskSettings[destination] && !state.continuations[destination] && !state.liveTakeovers[destination]
    && !Object.values(state.jobs).some(job => job.sessionId === destination)
    && !Object.values(state.logicalContinuations?.intents ?? {}).some(intent =>
      intent.request.source.sessionId === destination || intent.destination?.sessionId === destination
      || intent.orphanDestination?.sessionId === destination
    )
}

/** Check the direct binding and every queued sender without mutating them. */
export function channelLogicalBindingAdmitted(
  state: ChannelConversationState,
  event: ChannelEventRef,
  profileId: string,
  source: string,
  taskClaim?: ChannelTaskContinuationClaim,
): boolean {
  if (!channelLogicalContinuationAdmitted(state, event, profileId, source, taskClaim)) return false
  const binding = Object.values(state.bindings).find(value => value.sessionId === source && value.state === 'active')!
  const queued = Object.values(state.jobs).filter(job => job.sessionId === source && job.state === 'queued')
  for (const job of queued) {
    const input = state.inputs[job.recordId]
    const origin = input?.input.source.event
    if (
      job.bindingId !== binding.id || job.autoCreate || !origin || !input.accepted
      || !isDeepStrictEqual(origin.actor, event.actor)
      || !isDeepStrictEqual(
        {
          adapterId: origin.adapterId,
          accountId: origin.accountId,
          tenantId: origin.tenantId,
          conversationId: origin.conversationId,
          threadId: origin.threadId,
          kind: origin.kind,
          semantics: origin.semantics,
        },
        binding.channel,
      )
      || !channelPolicyAllows(state.policy, 'dispatch', origin)
    ) return false
  }
  return true
}

/** Called inside the same transaction that commits the logical relation. */
export function bindChannelLogicalContinuation(
  state: ChannelConversationState,
  event: ChannelEventRef,
  profileId: string,
  source: string,
  destination: string,
  target: { readonly providerId: string; readonly model: string },
  groupAuthorized = false,
  taskClaim?: ChannelTaskContinuationClaim,
): boolean {
  if (
    !channelLogicalDestinationAvailable(state, source, destination)
    || !groupAuthorized && !channelLogicalBindingAdmitted(state, event, profileId, source, taskClaim)
  ) return false
  const binding = Object.values(state.bindings).find(value => value.sessionId === source && value.state === 'active')!
  const queued = Object.values(state.jobs).filter(job => job.sessionId === source && job.state === 'queued')
  state.bindings[binding.id] = { ...binding, sessionId: destination }
  for (const job of queued) job.sessionId = destination
  const settings = state.taskSettings[source]
  if (settings) {
    state.taskSettings[destination] = {
      revision: settings.revision,
      application: 'applied',
      settings: { ...structuredClone(settings.settings), ...target },
    }
  }
  const continuation = state.continuations[source]
  if (continuation?.policy || continuation?.livePolicy) {
    state.continuations[destination] = {
      ...(continuation.policy ? { policy: structuredClone(continuation.policy) } : {}),
      ...(continuation.livePolicy ? { livePolicy: structuredClone(continuation.livePolicy) } : {}),
    }
  }
  return true
}
