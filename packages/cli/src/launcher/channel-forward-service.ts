import type { ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { ChannelForwardStore } from './channel-forward-store.js'
import { feishuMessageForward } from './feishu-message-forward.js'

export function createChannelForwardService(input: {
  filename: string
  channel(request: ChannelForwardRequestV1): FeishuSdkChannel | undefined
  active(): boolean
  supported(request: ChannelForwardRequestV1): boolean
}) {
  const store = new ChannelForwardStore(input.filename)
  return async (request: ChannelForwardRequestV1, scope: string, readOnly: boolean, authorize: () => void) => {
    if (!input.active() || !input.supported(request)) throw new Error('FORWARD_UNAVAILABLE')
    authorize()
    const channel = input.channel(request)
    if (!channel?.rawClient) throw new Error('FORWARD_UNAVAILABLE')
    const current = () => input.active() && input.channel(request) === channel
    return store.run(scope, request, async platformRequest => {
      if (!current()) throw new Error('FORWARD_GENERATION_REVOKED')
      authorize()
      return feishuMessageForward(platformRequest, channel, current, authorize)
    }, readOnly)
  }
}
