import type { ChannelStoreState } from './store.js'
import type { ChannelConversationRef, ChannelTenantRef } from './types.js'
import { sanitizedThread } from './runtime-validation.js'

export interface ChannelTransportActivity {
  readonly conversation: ChannelConversationRef
  readonly id: string
  readonly direction: 'incoming' | 'outgoing'
  readonly state:
    | 'received'
    | 'queued'
    | 'processing'
    | 'retrying'
    | 'permission-pending'
    | 'denied'
    | 'sent'
    | 'failed'
    | 'cancelled'
    | 'unknown'
  readonly occurredAt: string
  readonly text: string
  readonly actorId?: string
  readonly eventId?: string
  readonly sessionId?: string
  readonly code?: string
}

const same = (left: ChannelConversationRef, right: ChannelTenantRef & { readonly conversationId?: string }) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId
  && (right.conversationId === undefined || left.conversationId === right.conversationId)

/** Launcher management reads actual transport facts, never task text or recalled handles. */
export function conversationReadback(
  state: ChannelStoreState,
  ref: ChannelTenantRef & { readonly conversationId?: string },
): {
  readonly revision: number
  readonly entries: readonly ChannelTransportActivity[]
} {
  if (ref.conversationId !== undefined) {
    sanitizedThread({
      ...ref,
      kind: 'group',
      conversationId: ref.conversationId,
      threadId: ref.conversationId,
      semantics: 'conversation',
    })
  }
  const entries: ChannelTransportActivity[] = []
  for (const record of Object.values(state.inbox)) {
    const event = record.envelope.input.source.event
    if (!same(event, ref)) continue
    entries.push({
      conversation: {
        adapterId: event.adapterId,
        accountId: event.accountId,
        tenantId: event.tenantId,
        conversationId: event.conversationId,
        kind: event.kind,
      },
      id: record.recordId,
      direction: 'incoming',
      state: record.status === 'applied' ? 'received' : record.status === 'dead-letter' ? 'failed' : record.status,
      occurredAt: record.receivedAt,
      text: record.envelope.input.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      ...(event.actor === undefined ? {} : { actorId: event.actor.userId }),
      eventId: event.eventId,
      ...(record.errorCode === undefined ? {} : { code: record.errorCode }),
    })
  }
  for (const record of Object.values(state.outbox)) {
    if (!same(record.target, ref)) continue
    entries.push({
      conversation: {
        adapterId: record.target.adapterId,
        accountId: record.target.accountId,
        tenantId: record.target.tenantId,
        conversationId: record.target.conversationId,
        kind: record.target.kind,
      },
      id: record.deliveryId,
      direction: 'outgoing',
      state: record.status === 'dead-letter'
        ? 'failed'
        : record.status === 'sent' && !record.externalMessageId
        ? 'unknown'
        : record.status,
      occurredAt: record.createdAt,
      text: record.text,
      ...(record.caller.source === 'cordisx:native-channel' && record.caller.pluginId === 'host-channel-tools'
          && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(record.caller.generation)
        ? { sessionId: record.caller.generation }
        : {}),
      ...(record.errorCode === undefined ? {} : { code: record.errorCode }),
    })
  }
  return {
    revision: state.revision,
    entries: entries.sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id)
    ),
  }
}

export function localConversationRefs(
  state: ChannelStoreState,
  ref: Omit<ChannelConversationRef, 'conversationId' | 'kind'>,
): readonly ChannelConversationRef[] {
  const result = new Map<string, ChannelConversationRef>()
  const add = (target: ChannelConversationRef) => {
    if (target.adapterId !== ref.adapterId || target.accountId !== ref.accountId || target.tenantId !== ref.tenantId) {
      return
    }
    result.set(target.conversationId, { ...ref, conversationId: target.conversationId, kind: target.kind })
  }
  for (const record of Object.values(state.inbox)) add(record.envelope.input.source.event)
  for (const record of Object.values(state.outbox)) add(record.target)
  return [...result.values()]
}
