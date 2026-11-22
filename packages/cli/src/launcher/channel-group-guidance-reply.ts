import type { ChannelUserInput } from '@cordisx/channel-runtime'
import { createHash } from 'node:crypto'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { CALLER } from './channel-conversation-consumer-contract.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelGroupGuidance } from './channel-group-guidance.js'
import { channelCommandReplyTarget } from './channel-reply-routing.js'

/** Give a denied, addressed group request one bounded hint without widening its task or send permission. */
export async function channelGroupGuidanceReply(input: {
  readonly message: ChannelUserInput
  readonly recordId: string
  readonly mentionedBot: boolean
  readonly consumer: ChannelConversationConsumer
  readonly access: () => ChannelConversationAccess | undefined
  readonly guidance: ChannelGroupGuidance
}): Promise<void> {
  const event = input.message.source.event
  const text = input.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim()
  if (
    !['feishu', 'lark'].includes(event.adapterId) || event.kind !== 'group' || !input.mentionedBot
    || !event.actor || !text || text.startsWith('/')
  ) return
  const access = input.access(), snapshot = input.consumer.policy(), policy = snapshot.policy
  if (
    !access || !policy.enabled || channelPolicyAllows(policy, 'dispatch', event)
    || !channelPolicyAllows(policy, 'send', event) || !channelPolicyAllows(policy, 'command', event, 'help')
  ) return
  if (!await input.guidance.reserve(event, event.conversationId)) return
  const updated = input.consumer.policy(), latest = updated.policy, current = input.access()
  if (
    !current || current.generation !== access.generation || snapshot.revision !== updated.revision || !latest.enabled
    || channelPolicyAllows(latest, 'dispatch', event) || !channelPolicyAllows(latest, 'send', event)
    || !channelPolicyAllows(latest, 'command', event, 'help')
  ) return
  const target = channelCommandReplyTarget(event, current.replyCapabilities?.(event))
  await current.runtime.notifyOnce(
    {
      target,
      kind: 'reply',
      text: '当前群消息没有任务投递权限。请私聊机器人，并联系管理员确认任务权限。',
    },
    CALLER,
    `delivery:${createHash('sha256').update(`group-guide:${input.recordId}`).digest('hex')}`,
  )
  await current.drain(event)
}
