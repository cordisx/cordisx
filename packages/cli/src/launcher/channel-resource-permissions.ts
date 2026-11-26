import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { type ChannelConversationPolicy, channelPolicyAllows } from './channel-conversation-policy.js'

export const CHANNEL_RESOURCE_PERMISSION_KEYS = ['resource-read'] as const

export function authorizeChannelResource(policy: ChannelConversationPolicy, event: ChannelEventRef): void {
  const restricted = {
    ...policy,
    rules: policy.rules.filter(rule => rule.effect === 'deny' || rule.commands?.includes('resource-read')),
  }
  if (!policy.enabled || !channelPolicyAllows(restricted, 'command', event, 'resource-read')) {
    throw new Error('CHANNEL_RESOURCE_PERMISSION_DENIED')
  }
}
