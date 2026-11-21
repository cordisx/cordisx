import { validateOutboundMedia } from '../../../channel-runtime/src/outbound-media.js'
import type { ChannelOutboundMedia } from '../../../channel-runtime/src/outbound-media.js'

export function parseChannelCliMedia(source: string): ChannelOutboundMedia {
  if (source.length > 2048) throw new Error('INVALID_CHANNEL_MEDIA')
  return validateOutboundMedia(JSON.parse(source))
}
