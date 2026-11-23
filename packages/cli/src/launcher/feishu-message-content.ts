import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { ChannelContentBlock, ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelInboundResources } from './channel-inbound-resources.js'
import { feishuInboundContent, type FeishuMessageResourceClient } from './feishu-inbound-media.js'
import { type FeishuForwardClient, feishuForwardedContent } from './feishu-forwarded-content.js'

export interface FeishuMessageContentOptions {
  rawContent?: string
  messageClient?: FeishuForwardClient | undefined
  resourceClient?: FeishuMessageResourceClient | undefined
}

export async function feishuMessageContent(
  message: NormalizedMessage,
  event: ChannelEventRef,
  resources: ChannelInboundResources,
  options: FeishuMessageContentOptions = {},
): Promise<[ChannelContentBlock, ...ChannelContentBlock[]]> {
  if (message.messageId !== event.messageId || message.chatId !== event.conversationId) {
    return [{ type: 'text', text: '[Message unavailable: source mismatch]' }]
  }
  if (message.rawContentType === 'merge_forward') {
    return feishuForwardedContent(message, event, resources, options.messageClient, options.resourceClient)
  }
  return feishuInboundContent(message, event, resources, options.resourceClient, options.rawContent)
}
