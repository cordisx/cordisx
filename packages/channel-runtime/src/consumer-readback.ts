import type {
  ChannelPermissionBroker,
  ChannelPluginIdentity,
  ChannelSubscriptionFilter,
  ChannelUserInput,
} from './types.js'
import type { ChannelStoreState } from './store.js'
import { canonical, exactKeys, nonEmptyText, objectRecord, sanitizedTenant } from './runtime-validation.js'

export function ownsPlainCard(
  state: ChannelStoreState,
  target: import('./types.js').ChannelConversationRef,
  messageId: string,
): boolean {
  return Object.values(state.outbox).some(record =>
    record.status === 'sent'
    && record.externalMessageId === messageId && record.content?.type === 'card' && !record.questionCard
    && record.target.adapterId === target.adapterId && record.target.accountId === target.accountId
    && record.target.tenantId === target.tenantId && record.target.conversationId === target.conversationId
  )
}

const key = (value: ChannelSubscriptionFilter['account']) =>
  JSON.stringify([value.adapterId, value.accountId, value.tenantId])
const cursorFor = (state: ChannelStoreState, offset: number) =>
  `channel-input:${offset}:${Object.values(state.inbox)[offset - 1]?.recordId ?? 'empty'}`

/** Launcher consumers read the existing inbox. No second conversation or delivery ledger is created. */
export async function inputsSince(
  state: ChannelStoreState,
  permissions: ChannelPermissionBroker,
  caller: ChannelPluginIdentity,
  filters: readonly ChannelSubscriptionFilter[],
  cursor: string,
  limit: number,
): Promise<{ cursor: string; messages: readonly { recordId: string; input: ChannelUserInput }[] }> {
  if (!filters.length) throw new Error('INVALID_FILTER')
  for (const filter of filters) {
    exactKeys(objectRecord(filter, 'Channel filter'), ['account', 'conversationId', 'userId'], 'Channel filter')
    sanitizedTenant(filter.account)
    if (
      filter.conversationId !== undefined && !nonEmptyText(filter.conversationId, 512)
      || filter.userId !== undefined && !nonEmptyText(filter.userId, 512)
    ) throw new Error('INVALID_FILTER')
    const adapter = state.adapters[key(filter.account)]
    const decision = await permissions.authorize({
      caller,
      capability: 'channel.events.subscribe',
      source: {
        ...filter.account,
        ...(filter.conversationId === undefined ? {} : { conversationId: filter.conversationId }),
        ...(filter.userId === undefined ? {} : { actor: { ...filter.account, userId: filter.userId } }),
      },
      generation: adapter?.generation ?? 0,
      operationId: `read-filter:${canonical(filter)}`,
    })
    if (decision !== 'allow') throw new Error('CHANNEL_PERMISSION_DENIED')
  }
  const records = Object.values(state.inbox)
  const match = /^channel-input:([0-9]+):(.+)$/u.exec(cursor)
  const offset = match === null ? -1 : Number(match[1])
  if (
    offset < 0 || offset > records.length || cursorFor(state, offset) !== cursor || !Number.isInteger(limit)
    || limit < 1 || limit > 100
  ) {
    throw new Error('INVALID_CURSOR')
  }
  const messages: { recordId: string; input: ChannelUserInput }[] = []
  let scanned = offset
  for (const record of records.slice(offset)) {
    scanned += 1
    const event = record.envelope.input.source.event
    if (!['queued', 'processing', 'applied', 'retrying'].includes(record.status)) continue
    if (
      !filters.some(filter =>
        key(filter.account) === key(event)
        && (filter.conversationId === undefined || filter.conversationId === event.conversationId)
        && (filter.userId === undefined || filter.userId === event.actor?.userId)
      )
    ) continue
    const decision = await permissions.authorize({
      caller,
      capability: 'channel.events.subscribe',
      source: event,
      generation: record.generation,
      operationId: `read:${record.recordId}`,
    })
    if (decision !== 'allow') throw new Error('CHANNEL_PERMISSION_DENIED')
    messages.push({ recordId: record.recordId, input: structuredClone(record.envelope.input) })
    if (messages.length >= limit) break
  }
  return { cursor: cursorFor(state, scanned), messages }
}
export function latestInputCursor(state: ChannelStoreState): string {
  return cursorFor(state, Object.keys(state.inbox).length)
}

/** Only a caller's own delivery can be read. Receipts contain no message text or credentials. */
export function deliverySnapshot(state: ChannelStoreState, id: string, caller: ChannelPluginIdentity) {
  const record = state.outbox[id]
  if (!record || canonical(record.caller) !== canonical(caller)) return undefined
  return {
    deliveryId: id,
    state: record.status,
    attempts: record.attempts,
    target: structuredClone(record.target),
    ...(record.content === undefined ? {} : {
      requestedType: record.requestedType,
      effectiveType: record.effectiveType,
      downgraded: record.requestedType !== record.effectiveType,
    }),
    ...(record.externalMessageId === undefined ? {} : { externalMessageId: record.externalMessageId }),
    ...(record.errorCode === undefined ? {} : { code: record.errorCode }),
  }
}

/** Launcher-only lookup of one caller-owned, positively acknowledged group text delivery. */
export function confirmedGroupDeliveryText(
  state: ChannelStoreState,
  id: string,
  caller: ChannelPluginIdentity,
  target: import('./types.js').ChannelConversationRef,
): string | undefined {
  const receipt = deliverySnapshot(state, id, caller)
  if (
    !receipt || receipt.state !== 'sent' || !receipt.externalMessageId || target.kind !== 'group'
    || receipt.target.kind !== 'group' || receipt.target.adapterId !== target.adapterId
    || receipt.target.accountId !== target.accountId || receipt.target.tenantId !== target.tenantId
    || receipt.target.conversationId !== target.conversationId
  ) return undefined
  return state.outbox[id]?.text.slice(0, 4_096)
}
