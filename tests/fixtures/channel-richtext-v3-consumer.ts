import type { ChannelRuntimeContextV4 } from '@cordisx/protocol/channel-runtime/v4'
import type { ChannelMessageSendV3 } from '@cordisx/protocol/channel-outbound/v3'

declare const context: ChannelRuntimeContextV4
declare const request: ChannelMessageSendV3
context.channel.outboundV3.capabilities(request.target).then(capabilities => {
  const mode: 'standalone-paragraph' = capabilities.richtext.inlineCodeMode
  void mode
})
context.channel.outboundV3.send(request).then(handle => handle.receipt())
// @ts-expect-error The installed v1 facade remains frozen.
context.channel.outbound.send(request)
// @ts-expect-error The installed v2 facade remains frozen.
context.channel.outboundV2.send(request)
