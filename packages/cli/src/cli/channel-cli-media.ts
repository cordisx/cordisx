import { validateOutboundMedia } from '@cordisx/channel-runtime'
import type { ChannelOutboundMedia } from '@cordisx/channel-runtime'

export function parseChannelCliMedia(source: string): ChannelOutboundMedia {
  if (source.length > 2048) throw new Error('INVALID_CHANNEL_MEDIA')
  return validateOutboundMedia(JSON.parse(source))
}
