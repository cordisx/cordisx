import { richtextRequirementsV3 } from '@cordisx/channel-runtime'
import type {
  ChannelOutboundContentV3,
  ChannelOutboundFallback,
  ChannelPluginIdentity,
  ChannelRuntime,
  ChannelThreadRef,
} from '@cordisx/channel-runtime'
import type { ChannelOutboundRpc, ChannelOutboundRpcCaller } from './channel-outbound-rpc.js'

interface OutboundPreflight {
  runtime: Pick<
    ChannelRuntime,
    'outboundCapabilities' | 'outboundCapabilitiesV2' | 'outboundCapabilitiesV3' | 'validateMentionContent'
  >
  outbound: ChannelOutboundRpc
  caller: ChannelPluginIdentity
  outboundCaller: ChannelOutboundRpcCaller
  targets: readonly ChannelThreadRef[]
  contents: readonly { content: ChannelOutboundContentV3; fallback: ChannelOutboundFallback; outboundVersion?: 3 }[]
  deliveryId(index: number): string
  prior(index: number): boolean
  assertGeneration(): void
}

export async function preflightOutboundRequests(input: OutboundPreflight): Promise<void> {
  for (let index = 0; index < input.targets.length; index += 1) {
    if (input.prior(index)) continue
    const target = input.targets[index]!
    const requested = input.contents[index]!
    const capabilities = await input.runtime.outboundCapabilities(target, input.caller)
    input.outbound.validateTransport(
      requested.content,
      requested.fallback,
      target,
      input.deliveryId(index),
      requested.outboundVersion ?? 2,
    )
    const requirements = richtextRequirementsV3(requested.content)
    if (requirements.userIds.length) {
      await input.outbound.validateMentions(
        requested.content,
        requested.outboundVersion ?? 2,
        content => input.runtime.validateMentionContent(target, content, input.caller),
      )
    }
    const richtext = requirements.paragraphs
      ? (await input.runtime.outboundCapabilitiesV2(target, input.caller)).richtext
      : undefined
    const successor = requested.outboundVersion === 3
      ? (await input.runtime.outboundCapabilitiesV3(target, input.caller)).richtext
      : undefined
    if (
      (!capabilities.types.includes(requested.content.type)
        || requested.outboundVersion === 3
          && (!successor?.links || requirements.imageHandles.length > 0 && !successor.preparedImages)
        || requirements.paragraphs && richtext?.paragraphs !== true
        || requirements.userIds.length > 0 && richtext?.mentions !== true)
      && !(requested.fallback.mode === 'text' && capabilities.types.includes('text'))
    ) throw new Error('CHANNEL_OUTBOUND_TYPE_UNSUPPORTED')
    if (capabilities.types.includes(requested.content.type)) {
      input.outbound.validateMediaLimits(requested.content, input.outboundCaller, target, capabilities.maxMediaBytes)
    }
    input.assertGeneration()
  }
}
