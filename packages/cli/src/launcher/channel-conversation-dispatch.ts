import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelContinuationManager, ContinuationReservation } from './channel-continuation-manager.js'
import type { ContinuationConfiguration } from './channel-continuation-config.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import {
  type ChannelConversationJob,
  type ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'
import { channelReplyDefaults } from './channel-reply-routing.js'
import { channelLogicalHandoffForJob, reserveChannelLogicalHandoff } from './channel-logical-handoff.js'

export async function channelDispatchHandoff(store: ChannelConversationStore, jobId: string, event: ChannelEventRef) {
  const handoff = channelLogicalHandoffForJob(store.snapshot(), jobId, event)
  if (handoff === false) {
    await store.mutate(state => {
      if (state.jobs[jobId]?.state === 'dispatching') state.jobs[jobId]!.state = 'queued'
    })
  }
  return handoff
}

export function channelContinuationArguments(
  continuation: ContinuationReservation | undefined,
  manager: ChannelContinuationManager,
  logicalHistory: boolean,
  handoff?: string,
): [
  { operationId: string; brief: string; configuration: ContinuationConfiguration } | undefined,
  boolean | undefined,
  string | undefined,
] {
  return [
    continuation
      ? {
        operationId: continuation.operationId,
        brief: manager.brief(continuation),
        configuration: continuation.configuration,
      }
      : undefined,
    logicalHistory || undefined,
    handoff,
  ]
}

/** Revalidate the queued job and claim it in the same transaction as the migration fence. */
export function claimChannelDispatch(
  state: ChannelConversationState,
  job: ChannelConversationJob,
  event: ChannelEventRef,
  continuation: ContinuationReservation | undefined,
): boolean {
  const current = state.jobs[job.id]
  const binding = current?.bindingId === undefined ? undefined : state.bindings[current.bindingId]
  if (
    !current || current.state !== 'queued' || current.sessionId !== job.sessionId
    || current.bindingId !== job.bindingId || !state.policy.enabled
    || !channelPolicyAllows(state.policy, 'dispatch', event)
    || current.sessionId && ChannelConversationStore.logicalSourceFenced(state, current.sessionId)
    || current.bindingId && (binding?.state !== 'active' || binding.sessionId !== current.sessionId)
  ) {
    // This reservation has not started a native effect; release only our own intent.
    const intent = continuation && state.continuations[continuation.source]?.intent
    if (continuation && intent?.operationId === continuation.operationId && intent.state === 'dispatching') {
      delete state.continuations[continuation.source]!.intent
    }
    return false
  }
  if (!reserveChannelLogicalHandoff(state, job.id, event)) {
    const intent = continuation && state.continuations[continuation.source]?.intent
    if (continuation && intent?.operationId === continuation.operationId && intent.state === 'dispatching') {
      delete state.continuations[continuation.source]!.intent
    }
    return false
  }
  current.state = 'dispatching'
  current.finalDeliveryEnabled = state.policy.autoReply && (binding?.autoReply ?? current.autoCreate)
  current.replyDefaults ??= channelReplyDefaults(state.policy, event, binding)
  return true
}
