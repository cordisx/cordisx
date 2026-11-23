import type { ChannelOutboundCapabilitiesV1 } from '@cordisx/protocol/channel-outbound/v1'
import type { ChannelOutboundCapabilitiesV2 } from '@cordisx/protocol/channel-outbound/v2'
import type {
  ChannelAdapterConnection,
  ChannelPermissionRequest,
  ChannelPluginIdentity,
  ChannelThreadRef,
} from './types.js'
import { type ChannelOutboundContent, richtextRequirements, validateOutboundContent } from './outbound-content.js'
import { ChannelIntegrityError } from './runtime-validation.js'

export function mentionCapabilities(
  original: ChannelOutboundCapabilitiesV1,
  connection: ChannelAdapterConnection | undefined,
): ChannelOutboundCapabilitiesV2 {
  const paragraphs = original.types.includes('richtext') && connection?.richtext?.paragraphs === true
  return {
    ...original,
    contract: 'cordisx.channel-outbound-capabilities/v2',
    schemaVersion: 2,
    richtext: {
      paragraphs,
      mentions: paragraphs && connection?.richtext?.mentions === true && !!connection.verifyMentions,
    },
  }
}

export async function validateMentionAuthority(
  target: ChannelThreadRef,
  content: ChannelOutboundContent,
  caller: ChannelPluginIdentity,
  active: { generation: number; connection: ChannelAdapterConnection },
  authorize: (request: ChannelPermissionRequest) => Promise<void>,
): Promise<void> {
  const requirements = richtextRequirements(validateOutboundContent(content))
  if (!requirements.userIds.length) return
  await authorize({
    caller,
    capability: 'channel.messages.send',
    source: target,
    generation: active.generation,
    operationId: 'mention-validate',
  })
  if (!active.connection.verifyMentions) throw new ChannelIntegrityError('CHANNEL_MENTION_UNVERIFIED')
  await active.connection.verifyMentions(target, requirements.userIds)
}

export async function validateMentionDispatch(
  target: ChannelThreadRef,
  content: ChannelOutboundContent,
  connection: ChannelAdapterConnection,
): Promise<void> {
  const requirements = richtextRequirements(content)
  if (requirements.userIds.length) {
    if (!connection.verifyMentions) throw new ChannelIntegrityError('CHANNEL_MENTION_UNVERIFIED')
    await connection.verifyMentions(target, requirements.userIds)
  }
  if (
    requirements.paragraphs && connection.richtext?.paragraphs !== true
    || requirements.userIds.length > 0 && connection.richtext?.mentions !== true
  ) {
    throw new ChannelIntegrityError('CHANNEL_OUTBOUND_UNSUPPORTED')
  }
}
