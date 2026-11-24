import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { sameConversation } from './channel-conversation-refs.js'
import { channelAutoReplyTarget, channelCommandReplyTarget, channelReplyDefaults } from './channel-reply-routing.js'

/** Reserve a generic notice once before calling the stable outbox. */
export async function channelFailureNotice(
  store: ChannelConversationStore,
  jobId: string,
  access: ChannelConversationAccess | undefined,
  reply: (operation: string, event: ChannelEventRef, text: string, target?: ChannelThreadRef) => Promise<string>,
  report?: (code: string) => void,
): Promise<void> {
  const reserved = await store.mutate(state => {
    const job = state.jobs[jobId], record = job && state.inputs[job.recordId]
    if (!job || !record || job.failureNotice !== 'pending') return undefined
    if (!['failed', 'reconciliation-required'].includes(job.state)) {
      job.failureNotice = 'attempted'
      return undefined
    }
    const event = record.input.source.event
    const binding = job.bindingId ? state.bindings[job.bindingId] : undefined
    const defaults = job.replyDefaults ?? channelReplyDefaults(state.policy, event, binding)
    job.failureNotice = 'attempted'
    if (
      !state.failureNotices.enabled || !state.policy.enabled
      || !channelDispatchAllowed(state, event) || !channelPolicyAllows(state.policy, 'send', event)
      || job.bindingId && (binding?.state !== 'active' || binding.mode !== 'deliver'
          || binding.sessionId !== job.sessionId || binding.channel.kind !== event.kind
          || !sameConversation(binding.channel, event))
    ) return undefined
    try {
      const target = job.replyTarget ?? channelAutoReplyTarget(event, defaults, job.replyMode)
        ?? channelCommandReplyTarget(event, access?.replyCapabilities?.(event))
      return { event, target, uncertain: job.state === 'reconciliation-required' }
    } catch {
      return undefined
    }
  })
  if (!reserved || !store.snapshot().failureNotices.enabled) return
  const text = reserved.uncertain
    ? '任务状态暂时无法确认，请联系管理员核查。'
    : '任务处理失败，请联系管理员。'
  try {
    await reply(`${jobId}:failure`, reserved.event, text, reserved.target)
  } catch {
    // A delivery with an unknown receipt is never blindly sent again.
    report?.('CHANNEL_FAILURE_NOTICE_UNKNOWN')
  }
}
