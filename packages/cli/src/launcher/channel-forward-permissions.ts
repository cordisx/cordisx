import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { type ChannelConversationPolicy, channelPolicyAllows } from './channel-conversation-policy.js'

export const CHANNEL_FORWARD_PERMISSION_KEYS = ['forward-read', 'forward', 'merge-forward', 'thread-forward'] as const
export type ChannelForwardPolicyOperation = 'read' | 'forward' | 'merge-forward' | 'thread-forward'

export function forwardPermissionKey(operation: ChannelForwardPolicyOperation) {
  return operation === 'read' ? 'forward-read' : operation
}

export function authorizeChannelForward(
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  operation: ChannelForwardPolicyOperation,
): void {
  const key = forwardPermissionKey(operation)
  const restricted = {
    ...policy,
    rules: policy.rules.filter(rule => rule.effect === 'deny' || rule.commands?.includes(key)),
  }
  if (!policy.enabled || !channelPolicyAllows(restricted, 'command', event, key)) {
    throw new Error('CHANNEL_FORWARD_PERMISSION_DENIED')
  }
}
