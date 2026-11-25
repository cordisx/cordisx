import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationJob, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { CALLER } from './channel-conversation-consumer-contract.js'
import { identity } from './channel-conversation-refs.js'
import { mayFinishChannelJob } from './channel-live-takeover.js'
import { channelAutoReplyTarget, channelReplyDefaults } from './channel-reply-routing.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'

/** Deliver a completed native turn through its captured, authorized reply route. */
export async function finishChannelJob(
  input: {
    store: ChannelConversationStore
    native: Pick<ChannelNativeSessions, 'completion'>
    signal: AbortSignal
    access: () => ChannelConversationAccess | undefined
    reply: (operation: string, event: ChannelEventRef, text: string, target?: ChannelThreadRef) => Promise<string>
  },
  job: ChannelConversationJob,
  event: ChannelEventRef,
): Promise<void> {
  const { store, native, signal, reply } = input
  const state = store.snapshot()
  if (!job.sessionId || !job.turnId || !mayFinishChannelJob(state, job)) return
  const binding = job.bindingId === undefined ? undefined : state.bindings[job.bindingId]
  const defaults = job.replyDefaults ?? channelReplyDefaults(state.policy, event, binding)
  const mode = job.replyMode ?? (defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode)
  const includeFinal = job.finalDeliveryEnabled === true && state.policy.enabled && state.policy.autoReply
    && binding?.state === 'active' && binding.autoReply && mode !== 'none'
    && channelDispatchAllowed(state, event) && channelPolicyAllows(state.policy, 'send', event)
  const completion = await native.completion(job.sessionId, job.turnId, includeFinal)
  if (completion.state === 'running') return
  if (completion.state === 'failed') {
    await store.mutate(state => {
      if (!mayFinishChannelJob(state, job)) return
      state.jobs[job.id]!.state = 'failed'
      state.jobs[job.id]!.code = completion.code ?? 'NATIVE_TURN_FAILED'
      state.jobs[job.id]!.failureNotice ??= 'pending'
    })
    return
  }
  if (signal.aborted) return
  if (!includeFinal) {
    await store.mutate(state => {
      if (!mayFinishChannelJob(state, job)) return
      state.jobs[job.id]!.state = 'completed'
    })
    return
  }
  const access = input.access()
  const deliveryId = `delivery:${identity([job.id, event])}`
  const existingTarget = access?.runtime.deliverySnapshot(deliveryId, CALLER)?.target
  const target = await store.mutate(state => {
    if (!mayFinishChannelJob(state, job)) return undefined
    const current = state.jobs[job.id]!
    const binding = current.bindingId === undefined ? undefined : state.bindings[current.bindingId]
    const defaults = current.replyDefaults ?? channelReplyDefaults(state.policy, event, binding)
    const mode = current.replyMode ?? (defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode)
    if (
      current.finalDeliveryEnabled !== true || !state.policy.enabled || !state.policy.autoReply
      || !channelDispatchAllowed(state, event)
      || binding?.state !== 'active' || !binding.autoReply || !completion.text || mode === 'none'
    ) {
      current.state = 'completed'
      return undefined
    }
    try {
      const replyTarget = existingTarget ?? channelAutoReplyTarget(event, defaults, current.replyMode)
      if (!replyTarget) throw new Error('INVALID_REPLY_MODE')
      current.replyTarget ??= replyTarget
    } catch (error) {
      current.state = 'failed'
      current.code = error instanceof Error && error.message === 'REPLY_MESSAGE_REQUIRED'
        ? error.message
        : 'INVALID_REPLY_MODE'
      return undefined
    }
    current.state = 'replying'
    return current.replyTarget
  })
  if (target && completion.text) {
    const receipt = await reply(job.id, event, completion.text, target)
    await store.mutate(state => {
      const current = state.jobs[job.id]!
      current.state = receipt === 'sent' || receipt === 'denied'
        ? 'completed'
        : receipt === 'dead-letter' || receipt === 'cancelled'
        ? 'failed'
        : 'replying'
      if (current.state === 'failed') current.code = 'CHANNEL_DELIVERY_FAILED'
    })
  }
}
