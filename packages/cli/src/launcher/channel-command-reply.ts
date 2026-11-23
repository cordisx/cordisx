import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import { channelCommandReplyTarget } from './channel-reply-routing.js'
import { channelAutoReplyTarget, channelReplyDefaults } from './channel-reply-routing.js'
import { identity } from './channel-conversation-refs.js'
import { type ChannelConversationPolicy, channelPolicyAllows } from './channel-conversation-policy.js'
import { CALLER } from './channel-conversation-consumer-contract.js'
import type { ChannelThreadRef } from '@cordisx/channel-runtime'

export async function channelCommandReply(
  input: {
    access: ChannelConversationAccess | undefined
    reply: (
      operation: string,
      event: ChannelEventRef,
      text: string,
      target: ReturnType<typeof channelCommandReplyTarget>,
    ) => Promise<string>
    report?: ((code: string) => void) | undefined
  },
  operation: string,
  event: ChannelEventRef,
  text: string,
): Promise<string> {
  try {
    return await input.reply(
      operation,
      event,
      text,
      channelCommandReplyTarget(event, input.access?.replyCapabilities?.(event)),
    )
  } catch {
    // A second error reply could duplicate an outbound effect whose result is unknown.
    input.report?.('CHANNEL_COMMAND_REPLY_RESULT_UNKNOWN')
    return 'unknown'
  }
}

export async function channelConsumerReply(
  input: {
    access: ChannelConversationAccess | undefined
    signal: AbortSignal
    policy: ChannelConversationPolicy
  },
  operation: string,
  event: ChannelEventRef,
  text: string,
  reservedTarget?: ChannelThreadRef,
): Promise<string> {
  const access = input.access
  if (!access || input.signal.aborted || !channelPolicyAllows(input.policy, 'send', event)) return 'denied'
  const deliveryId = `delivery:${identity([operation, event])}`, defaults = channelReplyDefaults(input.policy, event)
  const mode = defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode
  if (!reservedTarget && mode === 'none') return 'denied'
  const target = reservedTarget ?? access.runtime.deliverySnapshot(deliveryId, CALLER)?.target
    ?? channelAutoReplyTarget(event, defaults)
  if (!target) return 'denied'
  await access.runtime.notifyOnce({ target, kind: 'reply', text }, CALLER, deliveryId)
  if (input.signal.aborted) return 'queued'
  await access.drain(event)
  return access.runtime.deliverySnapshot(deliveryId, CALLER)?.state ?? 'unavailable'
}
