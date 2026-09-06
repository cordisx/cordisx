import { createHash } from 'node:crypto'
import type {
  ChannelAdapterDescriptor,
  ChannelEventRef,
  ChannelInboundEnvelope,
  ChannelTenantRef,
  ChannelThreadRef,
} from './types.js'

export class ChannelIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelIntegrityError'
  }
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')
  }}`
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function accountKey(ref: ChannelTenantRef): string {
  return canonical([ref.adapterId, ref.accountId, ref.tenantId])
}

export function threadKey(ref: ChannelThreadRef): string {
  return canonical([
    ref.adapterId,
    ref.accountId,
    ref.tenantId,
    ref.conversationId,
    ref.kind,
    ref.threadId,
    ref.semantics,
  ])
}

export function replayKey(event: ChannelEventRef): string {
  return canonical([event.adapterId, event.accountId, event.eventId])
}

export function sameTenant(left: ChannelTenantRef, right: ChannelTenantRef): boolean {
  return accountKey(left) === accountKey(right)
}

export function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelIntegrityError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0) throw new ChannelIntegrityError(`${label} contains unsupported fields`)
}

export function nonEmptyText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

export function validateActor(value: unknown): void {
  const actor = objectRecord(value, 'Channel actor')
  exactKeys(actor, ['adapterId', 'accountId', 'tenantId', 'userId'], 'Channel actor')
  for (const field of ['adapterId', 'accountId', 'tenantId', 'userId']) {
    if (!nonEmptyText(actor[field], 512)) throw new ChannelIntegrityError(`Channel actor ${field} is invalid`)
  }
}

export function validateEvent(value: unknown): void {
  const event = objectRecord(value, 'Channel event')
  exactKeys(event, [
    'adapterId',
    'accountId',
    'tenantId',
    'conversationId',
    'kind',
    'threadId',
    'semantics',
    'eventId',
    'messageId',
    'actor',
  ], 'Channel event')
  for (const field of ['adapterId', 'accountId', 'tenantId', 'conversationId', 'threadId', 'eventId']) {
    if (!nonEmptyText(event[field], 512)) throw new ChannelIntegrityError(`Channel event ${field} is invalid`)
  }
  if (event.messageId !== undefined && !nonEmptyText(event.messageId, 512)) {
    throw new ChannelIntegrityError('Channel event messageId is invalid')
  }
  if (event.kind !== 'direct' && event.kind !== 'group' && event.kind !== 'broadcast') {
    throw new ChannelIntegrityError('Channel conversation kind is invalid')
  }
  if (event.semantics !== 'conversation' && event.semantics !== 'topic' && event.semantics !== 'reply-chain') {
    throw new ChannelIntegrityError('Channel thread semantics are invalid')
  }
  if (event.actor !== undefined) validateActor(event.actor)
}

export function validateInput(ref: ChannelTenantRef, envelope: ChannelInboundEnvelope): void {
  const rawEnvelope = objectRecord(envelope, 'Channel inbound envelope')
  exactKeys(rawEnvelope, ['input'], 'Channel inbound envelope')
  const input = objectRecord(envelope.input, 'Channel user input')
  exactKeys(input, ['contract', 'schemaVersion', 'role', 'content', 'source', 'receivedAt'], 'Channel user input')
  if (input.contract !== 'cordisx.channel-user-input/v1' || input.schemaVersion !== 1 || input.role !== 'user') {
    throw new ChannelIntegrityError('Channel ingress must be a version-1 sourced user input')
  }
  if (!Array.isArray(input.content) || input.content.length === 0 || input.content.length > 64) {
    throw new ChannelIntegrityError('Channel input content is invalid')
  }
  for (const [index, rawBlock] of input.content.entries()) {
    const block = objectRecord(rawBlock, `Channel content block ${index}`)
    if (block.type === 'text') {
      exactKeys(block, ['type', 'text'], `Channel content block ${index}`)
      if (!nonEmptyText(block.text, 100_000)) throw new ChannelIntegrityError('Channel text block is invalid')
    } else if (block.type === 'attachment') {
      exactKeys(block, ['type', 'handle', 'mediaType', 'name', 'size'], `Channel content block ${index}`)
      if (!nonEmptyText(block.handle, 512) || !nonEmptyText(block.mediaType, 255)) {
        throw new ChannelIntegrityError('Channel attachment handle or media type is invalid')
      }
      if (block.name !== undefined && !nonEmptyText(block.name, 1_024)) {
        throw new ChannelIntegrityError('Channel attachment name is invalid')
      }
      if (!Number.isInteger(block.size) || Number(block.size) < 0 || Number(block.size) > 1_073_741_824) {
        throw new ChannelIntegrityError('Channel attachment size is invalid')
      }
    } else {
      throw new ChannelIntegrityError('Channel content block type is invalid')
    }
  }
  const source = objectRecord(input.source, 'Channel input source')
  exactKeys(source, ['kind', 'event'], 'Channel input source')
  if (source.kind !== 'channel') throw new ChannelIntegrityError('Channel input source kind is invalid')
  validateEvent(source.event)
  if (!nonEmptyText(input.receivedAt, 64) || !Number.isFinite(Date.parse(input.receivedAt))) {
    throw new ChannelIntegrityError('Channel input receivedAt is invalid')
  }
  const typedEvent = envelope.input.source.event
  if (!sameTenant(ref, typedEvent)) {
    throw new ChannelIntegrityError('Channel event does not belong to the active adapter account/tenant')
  }
  if (typedEvent.actor !== undefined && !sameTenant(typedEvent, typedEvent.actor)) {
    throw new ChannelIntegrityError('Channel actor does not belong to the event account/tenant')
  }
}

export function sanitizedTenant(ref: ChannelTenantRef): ChannelTenantRef {
  if (
    !nonEmptyText(ref.adapterId, 128)
    || !nonEmptyText(ref.accountId, 512)
    || !nonEmptyText(ref.tenantId, 512)
  ) {
    throw new ChannelIntegrityError('Channel tenant identity is invalid')
  }
  return { adapterId: ref.adapterId, accountId: ref.accountId, tenantId: ref.tenantId }
}

export function sanitizedDescriptor(descriptor: ChannelAdapterDescriptor): ChannelAdapterDescriptor {
  const ref = sanitizedTenant(descriptor.ref)
  if (
    ![
      'simulator',
      'feishu',
      'lark',
      'wecom-intelligent-bot',
      'wecom-enterprise-app',
      'wecom-message-push',
      'wechat-service',
    ].includes(descriptor.kind)
  ) {
    throw new ChannelIntegrityError('Channel adapter kind is invalid')
  }
  if (
    !['implemented', 'verified', 'experimental', 'unavailable', 'planned'].includes(descriptor.implementationStatus)
  ) {
    throw new ChannelIntegrityError('Channel adapter implementation status is invalid')
  }
  if (!Number.isInteger(descriptor.configurationRevision) || descriptor.configurationRevision < 1) {
    throw new ChannelIntegrityError('Channel adapter configuration revision is invalid')
  }
  if (!['missing', 'ready', 'unavailable'].includes(descriptor.secretState)) {
    throw new ChannelIntegrityError('Channel adapter secret readiness is invalid')
  }
  return {
    ref,
    kind: descriptor.kind,
    implementationStatus: descriptor.implementationStatus,
    configurationRevision: descriptor.configurationRevision,
    secretState: descriptor.secretState,
  }
}

export function sanitizedThread(ref: ChannelThreadRef): ChannelThreadRef {
  if (
    !nonEmptyText(ref.adapterId, 128)
    || !nonEmptyText(ref.accountId, 512)
    || !nonEmptyText(ref.tenantId, 512)
    || !nonEmptyText(ref.conversationId, 512)
    || !nonEmptyText(ref.threadId, 512)
  ) {
    throw new ChannelIntegrityError('Channel target identity is invalid')
  }
  if (ref.kind !== 'direct' && ref.kind !== 'group' && ref.kind !== 'broadcast') {
    throw new ChannelIntegrityError('Channel target conversation kind is invalid')
  }
  if (ref.semantics !== 'conversation' && ref.semantics !== 'topic' && ref.semantics !== 'reply-chain') {
    throw new ChannelIntegrityError('Channel target thread semantics are invalid')
  }
  return {
    adapterId: ref.adapterId,
    accountId: ref.accountId,
    tenantId: ref.tenantId,
    conversationId: ref.conversationId,
    kind: ref.kind,
    threadId: ref.threadId,
    semantics: ref.semantics,
  }
}
