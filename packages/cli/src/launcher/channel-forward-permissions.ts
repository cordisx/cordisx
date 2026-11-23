export const CHANNEL_FORWARD_PERMISSION_KEYS = ['forward-read', 'forward', 'merge-forward'] as const

export function forwardPermissionKey(operation: 'read' | 'forward' | 'merge-forward') {
  return operation === 'read' ? 'forward-read' : operation
}

export function authorizeChannelForward(
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  operation: 'read' | 'forward' | 'merge-forward',
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
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { type ChannelConversationPolicy, channelPolicyAllows } from './channel-conversation-policy.js'
