import type { ChannelOutboundCapabilitiesV2 } from '@cordisx/protocol/channel-outbound/v2'
import type { ChannelOutboundCapabilitiesV3 } from '@cordisx/protocol/channel-outbound/v3'
import type { ChannelAdapterConnection } from './types.js'
import { codeLanguagesV3 } from './outbound-richtext-v3.js'

export function richtextV3Capabilities(
  original: ChannelOutboundCapabilitiesV2,
  connection: ChannelAdapterConnection | undefined,
): ChannelOutboundCapabilitiesV3 {
  const supported = connection?.richtextV3 === true && original.richtext.paragraphs
  return {
    ...original,
    contract: 'cordisx.channel-outbound-capabilities/v3',
    schemaVersion: 3,
    richtext: {
      ...original.richtext,
      links: supported,
      preparedImages: supported && connection?.supportsOutboundMedia === true
        && (connection.maxMediaBytes ?? 30000000) > 0,
      inlineCode: supported,
      inlineCodeMode: 'standalone-paragraph',
      codeLanguages: supported ? [...codeLanguagesV3] : [],
    },
  }
}
