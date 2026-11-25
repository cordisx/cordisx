import type { ChannelThreadForwardRequestV1 } from '@cordisx/protocol/channel-thread-forward/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { ChannelForwardStore } from './channel-forward-store.js'
import { threadForwardCodec } from './channel-thread-forward-validation.js'
import { feishuThreadForward } from './feishu-thread-forward.js'

export function createChannelThreadForwardService(input: {
  filename: string
  channel(request: ChannelThreadForwardRequestV1): FeishuSdkChannel | undefined
  active(): boolean
  supported(request: ChannelThreadForwardRequestV1): boolean
}) {
  const store = new ChannelForwardStore(input.filename, threadForwardCodec)
  return async (request: ChannelThreadForwardRequestV1, scope: string, readOnly: boolean, authorize: () => void) => {
    if (!input.active() || !input.supported(request)) throw new Error('THREAD_FORWARD_UNAVAILABLE')
    authorize()
    const channel = input.channel(request)
    if (!channel?.rawClient) throw new Error('THREAD_FORWARD_UNAVAILABLE')
    const current = () => input.active() && input.channel(request) === channel
    const result = await store.run(
      scope,
      request,
      platformRequest => feishuThreadForward(platformRequest, channel, current, authorize),
      readOnly,
    )
    if (!current()) throw new Error('THREAD_FORWARD_REVOKED')
    authorize()
    return result
  }
}
