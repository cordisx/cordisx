import { createHash } from 'node:crypto'
import type { ChannelAdapterDefinitionV2 } from '@cordisx/protocol/channel-runtime/v2'
import type { ChannelMessageSendV1 } from '@cordisx/protocol/channel-outbound/v1'
import type { ChannelMessageSendV2 } from '@cordisx/protocol/channel-outbound/v2'
import { richtextRequirements, validateOutboundContent } from './outbound-content.js'
import type { ChannelAdapterDefinition, ChannelRuntimeOptions } from './types.js'
import type { StoredOutboxRecord } from './store.js'
import { accountKey, canonical, ChannelIntegrityError } from './runtime-validation.js'
import type { ChannelSendReceiptV1 } from '@cordisx/protocol/channel-outbound/v1'

export function outboundAdapterDefinition(
  definition: ChannelAdapterDefinitionV2,
  recordFor: (id: string) => StoredOutboxRecord | undefined,
  resolveBytes: ChannelRuntimeOptions['resolveOutboundMedia'],
  generationFor: (target: import('./types.js').ChannelTenantRef) => number | undefined,
): ChannelAdapterDefinition {
  const suppliedTypes = definition.outboundCapabilities.types
  const maximum = definition.outboundCapabilities.maxMediaBytes
  if (
    !Array.isArray(suppliedTypes) || suppliedTypes.length === 0 || new Set(suppliedTypes).size !== suppliedTypes.length
    || suppliedTypes.some(type => !['text', 'image', 'audio', 'file', 'video', 'richtext', 'card'].includes(type))
    || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 30_000_000
  ) throw new ChannelIntegrityError('Invalid outbound capabilities')
  const types = Object.freeze([...suppliedTypes])
  return {
    descriptor: definition.descriptor,
    start: async host => {
      let stopped = false
      const connection = await definition.start({
        ...host,
        media: {
          resolve: async (handle, deliveryId) => {
            const record = recordFor(deliveryId)
            const media = record?.media
            if (
              !record || !media || record.status !== 'processing' || record.generation !== host.generation
              || accountKey(record.target) !== accountKey(host.ref)
              || media.handle !== handle || !resolveBytes || stopped || generationFor(host.ref) !== host.generation
              || media.size > maximum || !types.includes(media.type)
            ) throw new ChannelIntegrityError('Adapter media scope denied')
            const bytes = await resolveBytes(handle, record.target, media.size)
            if (stopped || generationFor(host.ref) !== host.generation) {
              throw new ChannelIntegrityError('Adapter media generation revoked')
            }
            if (bytes.length !== media.size || createHash('sha256').update(bytes).digest('hex') !== media.sha256) {
              throw new ChannelIntegrityError('Adapter media bytes invalid')
            }
            const { handle: ignored, ...metadata } = media
            return {
              ...metadata,
              mediaType: metadata.format === 'binary'
                ? 'application/octet-stream'
                : metadata.format === 'pdf'
                ? 'application/pdf'
                : metadata.format === 'mp4'
                ? 'video/mp4'
                : metadata.format === 'opus'
                ? 'audio/ogg'
                : `image/${metadata.format}`,
              bytes,
            } as Awaited<ReturnType<import('@cordisx/protocol/channel-outbound/v1').ChannelAdapterMediaV1['resolve']>>
          },
        },
      })
      return {
        outboundTypes: types,
        maxMediaBytes: maximum,
        supportsOutboundMedia: true,
        stop: reason => {
          stopped = true
          return connection.stop(reason)
        },
        send: delivery => {
          if (!delivery.content) return connection.send(delivery)
          return connection.sendMessage({
            deliveryId: delivery.deliveryId,
            createdAt: delivery.createdAt,
            request: {
              contract: 'cordisx.channel-message-send/v1',
              schemaVersion: 1,
              target: delivery.target,
              kind: delivery.kind,
              idempotencyKey: delivery.idempotencyKey ?? delivery.deliveryId,
              content: delivery.content as ChannelMessageSendV1['content'],
              fallback: { mode: 'reject' },
            },
          })
        },
      }
    },
  }
}

export function outboundReceipt(
  record: StoredOutboxRecord | undefined,
  deliveryId: string,
  request: ChannelMessageSendV1 | ChannelMessageSendV2,
): import('@cordisx/protocol/channel-outbound/v1').ChannelSendReceiptV1 {
  if (!record) {
    return {
      contract: 'cordisx.channel-send-receipt/v1',
      schemaVersion: 1,
      deliveryId,
      idempotencyKey: request.idempotencyKey,
      requestedType: request.content.type,
      effectiveType: request.content.type,
      downgraded: false,
      status: 'unknown',
      code: 'DELIVERY_NOT_FOUND',
    }
  }
  const base = {
    contract: 'cordisx.channel-send-receipt/v1' as const,
    schemaVersion: 1 as const,
    deliveryId,
    idempotencyKey: request.idempotencyKey,
    requestedType: record.requestedType!,
    effectiveType: record.effectiveType!,
    downgraded: record.requestedType !== record.effectiveType,
  }
  if (record.status === 'sent') {
    if (!record.externalMessageId) return { ...base, status: 'unknown', code: 'DELIVERY_RECEIPT_MISSING' }
    return {
      ...base,
      status: 'sent',
      externalMessageId: record.externalMessageId,
      ...(record.recallHandle ? { recallHandle: record.recallHandle } : {}),
    }
  }
  if (record.status === 'unknown') {
    return { ...base, status: 'unknown', code: record.errorCode ?? 'OUTBOUND_RESULT_UNKNOWN' }
  }
  if (record.status === 'dead-letter') {
    return { ...base, status: 'failed', code: record.errorCode ?? 'DELIVERY_FAILED' }
  }
  return { ...base, status: record.status === 'processing' ? 'sending' : record.status }
}

export async function sendOutboundPublic(
  request: ChannelMessageSendV1 | ChannelMessageSendV2,
  caller: import('./types.js').ChannelPluginIdentity,
  enqueue: (
    notification: import('./types.js').ChannelNotification,
    caller: import('./types.js').ChannelPluginIdentity,
    id: string,
  ) => Promise<import('./types.js').ChannelDeliveryHandle>,
  recordFor: (id: string) => StoredOutboxRecord | undefined,
): Promise<import('@cordisx/protocol/channel-outbound/v1').ChannelSendHandleV1> {
  if (
    !(request.contract === 'cordisx.channel-message-send/v1' && request.schemaVersion === 1
      || request.contract === 'cordisx.channel-message-send/v2' && request.schemaVersion === 2)
    || typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0
    || Array.from(request.idempotencyKey).length > 256
    || Object.keys(request).some(key =>
      !['contract', 'schemaVersion', 'target', 'kind', 'idempotencyKey', 'content', 'fallback'].includes(key)
    )
  ) throw new ChannelIntegrityError('Invalid typed send request')
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 196_608) {
    throw new ChannelIntegrityError('Typed send request exceeds transport bound')
  }
  if (request.schemaVersion === 1 && richtextRequirements(validateOutboundContent(request.content)).paragraphs) {
    throw new ChannelIntegrityError('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
  }
  const deliveryId = `delivery:${
    createHash('sha256').update(canonical(caller)).update('\0').update(request.idempotencyKey).digest('hex')
  }`
  const handle = await enqueue(
    {
      target: request.target,
      kind: request.kind,
      text: '',
      content: request.content,
      fallback: request.fallback,
      idempotencyKey: request.idempotencyKey,
    },
    caller,
    deliveryId,
  )
  return Object.freeze({
    ...handle,
    receipt: async (): Promise<ChannelSendReceiptV1> => {
      return outboundReceipt(recordFor(deliveryId), deliveryId, request)
    },
  })
}
