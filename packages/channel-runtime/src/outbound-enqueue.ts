import type {
  ChannelAdapterConnection,
  ChannelDeliveryHandle,
  ChannelNotification,
  ChannelPermissionRequest,
  ChannelPluginIdentity,
  ChannelRuntimeOptions,
  ChannelThreadRef,
} from './types.js'
import type { ChannelQuestionCard } from './question-card.js'
import type { ChannelStoreState, JsonChannelStore, StoredAuditRecord, StoredOutboxRecord } from './store.js'
import { accountKey, canonical, ChannelIntegrityError, sanitizedThread } from './runtime-validation.js'
import { validateOutboundContent, validateOutboundFallback } from './outbound-content.js'
import { validateNotificationMedia, validateOutboundMedia } from './outbound-media.js'
import { richtextRequirementsV3, validateOutboundContentV3 } from './outbound-richtext-v3.js'

interface EnqueueContext {
  assertActive(): void
  store: JsonChannelStore
  connections: ReadonlyMap<string, { connection: ChannelAdapterConnection }>
  requirePermission(request: ChannelPermissionRequest): Promise<void>
  mediaDescriptor: ChannelRuntimeOptions['outboundMediaDescriptor']
  observers: ReadonlySet<(target: ChannelThreadRef) => void>
  guarded?(id: string): boolean
  now(): string
  cancel(id: string): Promise<'cancelled' | 'irreversible' | 'not-found'>
  FencedError: new() => Error
  appendAudit(state: ChannelStoreState, record: StoredAuditRecord): void
  auditRecord(
    input: Omit<StoredAuditRecord, 'auditId' | 'source' | 'pluginId' | 'pluginGeneration'> & {
      caller: ChannelPluginIdentity
    },
  ): StoredAuditRecord
}
export async function enqueueOutbound(
  context: EnqueueContext,
  notification: ChannelNotification,
  caller: ChannelPluginIdentity,
  deliveryId: string,
  questionCard?: ChannelQuestionCard,
  terminalDelivery = false,
): Promise<ChannelDeliveryHandle> {
  context.assertActive()
  const target = sanitizedThread(notification.target)
  if (!['completion', 'approval', 'failure', 'reply'].includes(notification.kind)) {
    throw new ChannelIntegrityError('Channel notification kind is invalid')
  }
  const content = notification.content === undefined
    ? undefined
    : notification.outboundVersion === 3
    ? validateOutboundContentV3(notification.content)
    : validateOutboundContent(notification.content)
  const fallback = content ? validateOutboundFallback(notification.fallback ?? { mode: 'reject' }) : undefined
  if (
    content && Buffer.byteLength(
        JSON.stringify({
          contract: 'cordisx.channel-message-send/v2',
          schemaVersion: 2,
          target,
          kind: notification.kind,
          idempotencyKey: notification.idempotencyKey ?? deliveryId,
          content,
          fallback,
        }),
        'utf8',
      ) > 196_608
  ) throw new ChannelIntegrityError('Typed send request exceeds transport bound')
  if (content && (notification.text !== '' || notification.media !== undefined || questionCard !== undefined)) {
    throw new ChannelIntegrityError('Typed content cannot be combined with legacy content')
  }
  if (!content && notification.fallback !== undefined) {
    throw new ChannelIntegrityError('Fallback requires typed content')
  }
  let media = content ? undefined : validateNotificationMedia(notification, questionCard !== undefined)
  const key = accountKey(target)
  const adapter = context.store.snapshot().adapters[key]
  if (adapter === undefined) throw new context.FencedError()
  const priorTyped = context.store.snapshot().outbox[deliveryId]
  let effectiveType = content?.type
  let effectiveText = notification.text
  let preparedImages: readonly import('./outbound-media.js').ChannelOutboundMedia[] | undefined
  if (content) {
    const connection = context.connections.get(key)?.connection
    const types = connection?.outboundTypes ?? ['text']
    const requirements = richtextRequirementsV3(content)
    if (requirements.userIds.length) {
      await context.requirePermission({
        caller,
        capability: 'channel.messages.send',
        source: target,
        generation: adapter.generation,
        operationId: deliveryId,
      })
      if (!connection?.verifyMentions) throw new ChannelIntegrityError('CHANNEL_MENTION_UNVERIFIED')
      await connection.verifyMentions(target, requirements.userIds)
    }
    const unsupported = !types.includes(content.type)
      || notification.outboundVersion === 3 && content.type === 'richtext' && connection?.richtextV3 !== true
      || requirements.imageHandles.length > 0
        && (connection?.supportsOutboundMedia !== true || (connection.maxMediaBytes ?? 30000000) <= 0)
      || requirements.paragraphs && connection?.richtext?.paragraphs !== true
      || requirements.userIds.length > 0 && connection?.richtext?.mentions !== true
    if (!priorTyped?.content && unsupported) {
      if (fallback?.mode !== 'text' || !types.includes('text')) {
        throw new ChannelIntegrityError('Channel outbound type is unsupported; fallback rejected')
      }
      effectiveType = 'text'
      effectiveText = fallback.text
    } else if (content.type === 'text') effectiveText = content.text
    if (priorTyped?.content) {
      if (
        canonical(priorTyped.content) !== canonical(content) || canonical(priorTyped.fallback) !== canonical(fallback)
      ) throw new ChannelIntegrityError('Operation conflict')
      effectiveType = priorTyped.effectiveType
      effectiveText = priorTyped.text
      media = priorTyped.media
      preparedImages = priorTyped.preparedImages
    } else if (effectiveType !== 'text' && 'handle' in content) {
      await context.requirePermission({
        caller,
        capability: 'channel.messages.send',
        source: target,
        generation: adapter.generation,
        operationId: deliveryId,
      })
      if (!context.mediaDescriptor) throw new ChannelIntegrityError('Prepared media authority unavailable')
      media = validateOutboundMedia(await context.mediaDescriptor(caller, content.handle, target))
      if (media.handle !== content.handle || media.type !== content.type) {
        throw new ChannelIntegrityError('Prepared media type mismatch')
      }
      const maximum = context.connections.get(key)?.connection.maxMediaBytes ?? 30_000_000
      if (media.size > maximum) throw new ChannelIntegrityError('Prepared media exceeds adapter limit')
    }
    if (!priorTyped?.content && effectiveType !== 'text' && requirements.imageHandles.length) {
      await context.requirePermission({
        caller,
        capability: 'channel.messages.send',
        source: target,
        generation: adapter.generation,
        operationId: deliveryId,
      })
      if (!context.mediaDescriptor) throw new ChannelIntegrityError('Prepared media authority unavailable')
      const images = []
      const maximum = connection?.maxMediaBytes ?? 30_000_000
      let size = 0
      for (const handle of requirements.imageHandles) {
        const image = validateOutboundMedia(await context.mediaDescriptor(caller, handle, target))
        if (image.type !== 'image' || image.handle !== handle) {
          throw new ChannelIntegrityError('Prepared image type mismatch')
        }
        size += image.size
        if (size > maximum) throw new ChannelIntegrityError('Prepared images exceed adapter limit')
        images.push(image)
      }
      preparedImages = images
    }
  }
  if (!/^delivery:[A-Za-z0-9-]{1,128}$/u.test(deliveryId)) {
    throw new ChannelIntegrityError('Invalid delivery identity')
  }
  await context.requirePermission({
    caller,
    capability: 'channel.messages.send',
    source: target,
    generation: adapter.generation,
    operationId: deliveryId,
  })
  for (const listener of context.observers) {
    try {
      listener(target)
    } catch {}
  }
  const now = context.now()
  await context.store.transaction(state => {
    if (state.adapters[key]?.generation !== adapter.generation) throw new context.FencedError()
    const prior = state.outbox[deliveryId]
    if (prior) {
      if (
        canonical(prior.caller) !== canonical(caller) || canonical(prior.target) !== canonical(target)
        || prior.kind !== notification.kind || prior.text !== effectiveText
        || canonical(prior.content ?? null) !== canonical(content ?? null)
        || canonical(prior.fallback ?? null) !== canonical(fallback ?? null)
        || prior.idempotencyKey !== notification.idempotencyKey
        || canonical(prior.media ?? null) !== canonical(media ?? null)
        || prior.outboundVersion !== notification.outboundVersion
        || canonical(prior.preparedImages ?? null) !== canonical(preparedImages ?? null)
        || canonical(prior.questionCard ?? null) !== canonical(questionCard ?? null)
        || (prior.terminalDelivery === true) !== terminalDelivery
      ) throw new ChannelIntegrityError('Operation conflict')
      return
    }
    state.outbox[deliveryId] = {
      deliveryId,
      accountKey: key,
      generation: adapter.generation,
      caller,
      target,
      kind: notification.kind,
      text: effectiveText,
      ...(notification.idempotencyKey === undefined ? {} : { idempotencyKey: notification.idempotencyKey }),
      ...(content
        ? { content, fallback: fallback!, requestedType: content.type, effectiveType: effectiveType! }
        : {}),
      ...(media ? { media } : {}),
      ...(notification.outboundVersion === 3 ? { outboundVersion: 3 as const } : {}),
      ...(preparedImages ? { preparedImages } : {}),
      ...(questionCard ? { questionCard } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      ...(terminalDelivery ? { terminalDelivery: true as const } : {}),
      ...(context.guarded?.(deliveryId) ? { guardedDelivery: true } : {}),
      attempts: 0,
    }
    context.appendAudit(
      state,
      context.auditRecord({
        caller,
        recordedAt: now,
        accountKey: key,
        generation: adapter.generation,
        operationId: deliveryId,
        action: 'channel.delivery.enqueue',
        outcome: 'queued',
      }),
    )
  })
  return Object.freeze({
    deliveryId,
    cancel: () => context.cancel(deliveryId),
  })
}

export async function outboundCapabilitiesPublic(
  context: Pick<EnqueueContext, 'assertActive' | 'store' | 'requirePermission' | 'connections' | 'FencedError'>,
  target: ChannelThreadRef,
  caller: ChannelPluginIdentity,
): Promise<import('@cordisx/protocol/channel-outbound/v1').ChannelOutboundCapabilitiesV1> {
  context.assertActive()
  const safeTarget = sanitizedThread(target)
  const key = accountKey(safeTarget)
  const adapter = context.store.snapshot().adapters[key]
  if (!adapter) throw new context.FencedError()
  await context.requirePermission({
    caller,
    source: safeTarget,
    generation: adapter.generation,
    capability: 'channel.messages.send',
    operationId: 'outbound-capabilities',
  })
  const connection = context.connections.get(key)?.connection
  return {
    contract: 'cordisx.channel-outbound-capabilities/v1',
    schemaVersion: 1,
    target: safeTarget,
    types: [...(connection?.outboundTypes ?? ['text'])],
    maxMediaBytes: Math.min(
      30_000_000,
      connection?.maxMediaBytes ?? (connection?.supportsOutboundMedia ? 30_000_000 : 0),
    ),
  }
}

export function isEligibleOutbox(record: StoredOutboxRecord, now: number, leaseMs: number): boolean {
  if (record.terminalDelivery) return record.status === 'queued' && record.attempts === 0
  if (record.status === 'queued') return true
  if (record.status === 'retrying') return Date.parse(record.nextAttemptAt ?? '') <= now
  return record.status === 'processing' && Date.parse(record.claimedAt ?? '') + leaseMs <= now
}

/** A permission decision applies only to the same still-claimable delivery snapshot. */
export function canApplyOutboxDecision(
  current: StoredOutboxRecord | undefined,
  selected: StoredOutboxRecord,
  generation: number,
  accountGeneration: number | undefined,
  now: number,
  leaseMs: number,
): current is StoredOutboxRecord {
  return current !== undefined && isEligibleOutbox(current, now, leaseMs) && accountGeneration === generation
    && current.accountKey === selected.accountKey && current.generation === selected.generation
    && current.status === selected.status && current.attempts === selected.attempts
    && current.claimedAt === selected.claimedAt && current.updatedAt === selected.updatedAt
}
