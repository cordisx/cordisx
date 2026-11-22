import { createHash } from 'node:crypto'
import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { FeishuSdkChannel } from './feishu-adapter.js'

/** Uses only the SDK channel already owned by the current account and generation. */
export function channelFeedbackSdk(
  channelFor: (event: ChannelEventRef) => FeishuSdkChannel | undefined,
  current: () => boolean,
) {
  const clientFor = (event: ChannelEventRef) => {
    const channel = channelFor(event)
    if (!current() || !['feishu', 'lark'].includes(event.adapterId) || !channel?.rawClient) {
      throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE')
    }
    return channel.rawClient
  }
  return {
    feedbackReact: async (event: ChannelEventRef, emojiType: string) => {
      if (!event.messageId) throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE')
      const result = await clientFor(event).im.v1.messageReaction.create({
        path: { message_id: event.messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      if (result.code !== 0) throw new Error('CHANNEL_FEEDBACK_REACTION_FAILED')
    },
    feedbackWait: async (event: ChannelEventRef, target: ChannelThreadRef, text: string, recordId: string) => {
      if (
        !['adapterId', 'accountId', 'tenantId', 'conversationId'].every(key =>
          event[key as keyof ChannelEventRef] === target[key as keyof ChannelThreadRef]
        )
      ) throw new Error('CHANNEL_FEEDBACK_UNAVAILABLE')
      const client = clientFor(event),
        uuid = createHash('sha256').update(`channel-feedback:${recordId}`).digest('hex').slice(0, 32),
        content = JSON.stringify({ text })
      const result = target.semantics === 'conversation'
        ? await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: target.conversationId, msg_type: 'text', content, uuid },
        })
        : await client.im.v1.message.reply({
          path: { message_id: target.threadId },
          data: { msg_type: 'text', content, uuid, reply_in_thread: target.semantics === 'topic' },
        })
      if (result.code !== 0 || !result.data?.message_id) throw new Error('CHANNEL_FEEDBACK_WAIT_FAILED')
    },
  }
}
