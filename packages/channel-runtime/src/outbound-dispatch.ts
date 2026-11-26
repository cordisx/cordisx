import type { StoredOutboxRecord } from './store.js'
import type {
  ChannelAdapterConnection,
  ChannelOutboundDelivery,
  ChannelPermissionRequest,
  ChannelRuntimeOptions,
} from './types.js'
import { canonical, ChannelIntegrityError } from './runtime-validation.js'
import { validateOutboundContent } from './outbound-content.js'
import { validateOutboundMedia } from './outbound-media.js'
import { richtextRequirementsV3, validateOutboundContentV3 } from './outbound-richtext-v3.js'
import { validateMentionDispatch } from './outbound-mention.js'

interface DispatchAuthority {
  assertGeneration(): void
  authorize(request: ChannelPermissionRequest): Promise<void>
  descriptor: ChannelRuntimeOptions['outboundMediaDescriptor']
  processing(): boolean
}

export async function prepareOutboundDispatch(
  record: StoredOutboxRecord,
  connection: ChannelAdapterConnection,
  authority: DispatchAuthority,
): Promise<ChannelOutboundDelivery> {
  const verifyPreparedImages = async () => {
    authority.assertGeneration()
    await authority.authorize({
      caller: record.caller,
      capability: 'channel.messages.send',
      source: record.target,
      generation: record.generation,
      operationId: record.deliveryId,
    })
    for (const image of record.preparedImages ?? []) {
      if (
        !authority.descriptor
        || canonical(await authority.descriptor(record.caller, image.handle, record.target)) !== canonical(image)
      ) throw new ChannelIntegrityError('Prepared image authority revoked')
    }
    authority.assertGeneration()
    if (!authority.processing()) throw new ChannelIntegrityError('Prepared image delivery revoked')
  }
  if (record.content && record.effectiveType !== 'text') {
    if (record.outboundVersion === 3) {
      const safe = validateOutboundContentV3(record.content)
      const requirements = richtextRequirementsV3(safe)
      if (safe.type === 'richtext' && !connection.richtextV3) {
        throw new ChannelIntegrityError('CHANNEL_OUTBOUND_UNSUPPORTED')
      }
      if (requirements.userIds.length) {
        if (!connection.verifyMentions) throw new ChannelIntegrityError('CHANNEL_MENTION_UNVERIFIED')
        await connection.verifyMentions(record.target, requirements.userIds)
      }
      await verifyPreparedImages()
    } else await validateMentionDispatch(record.target, validateOutboundContent(record.content), connection)
  }
  if (record.content && !(connection.outboundTypes ?? ['text']).includes(record.effectiveType!)) {
    throw new ChannelIntegrityError('Effective outbound type is no longer supported')
  }
  if ((record.media || record.preparedImages?.length) && connection.supportsOutboundMedia !== true) {
    throw new ChannelIntegrityError('Channel adapter media support is unavailable')
  }
  return {
    deliveryId: record.deliveryId,
    target: record.target,
    kind: record.kind,
    text: record.text,
    ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
    ...(record.content
      ? {
        content: record.effectiveType === 'text'
          ? { type: 'text' as const, text: record.text }
          : record.outboundVersion === 3
          ? validateOutboundContentV3(record.content)
          : validateOutboundContent(record.content),
        fallback: record.fallback!,
        requestedType: record.requestedType!,
        effectiveType: record.effectiveType!,
      }
      : {}),
    ...(record.media ? { media: validateOutboundMedia(record.media) } : {}),
    ...(record.outboundVersion === 3 ? { outboundVersion: 3 as const, verifyPreparedImages } : {}),
    ...(record.preparedImages ? { preparedImages: record.preparedImages } : {}),
    ...(record.questionCard ? { questionCard: record.questionCard } : {}),
    createdAt: record.createdAt,
  }
}
