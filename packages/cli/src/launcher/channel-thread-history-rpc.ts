import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-access.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'

const text = (value: unknown, maximum = 512): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
const sameAccount = (left: ChannelTenantRef, right: ChannelTenantRef) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId

export async function channelThreadHistoryRpc(input: Record<string, unknown>, ref: ChannelTenantRef, context: {
  readonly current: ChannelConversationAccess
  readonly consumer?: ChannelConversationConsumer | undefined
  readonly source?: ChannelEventRef | undefined
  readonly nativeCaller?: string | undefined
  readonly active: () => boolean
}): Promise<unknown> {
  const { current, consumer, source, nativeCaller } = context
  if (
    Object.keys(input).some(key =>
      !['account', 'conversationId', 'kind', 'threadId', 'anchorMessageId', 'pageSize', 'pageToken', 'order'].includes(
        key,
      )
    )
  ) throw new Error('INVALID_REQUEST')
  const conversationId = text(input.conversationId), kind = input.kind
  const threadId = text(input.threadId), anchorMessageId = text(input.anchorMessageId)
  const pageSize = input.pageSize ?? 50, order = input.order ?? 'asc'
  if (
    !/^oc_[A-Za-z0-9_]+$/u.test(conversationId) || !['direct', 'group'].includes(String(kind))
    || !/^om[t]?_[A-Za-z0-9_]{1,200}$/u.test(threadId)
    || !/^om_[A-Za-z0-9_]{1,200}$/u.test(anchorMessageId)
    || !Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 50
    || !['asc', 'desc'].includes(String(order))
  ) throw new Error('INVALID_REQUEST')
  const pageToken = input.pageToken === undefined ? undefined : text(input.pageToken, 2048)
  const authorize = () => {
    if (!context.active()) throw new Error('CHANNEL_GENERATION_CHANGED')
    if (nativeCaller && consumer?.taskSettings.isBound(nativeCaller) && !source) {
      throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
    }
    if (
      source && (!sameAccount(source, ref) || source.conversationId !== conversationId
        || source.kind !== kind)
    ) throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
    if (source && consumer && !consumer.commandAllowed(source, 'history')) throw new Error('CHANNEL_POLICY_DENIED')
    if (!current.accounts().some(item => sameAccount(item.ref, ref) && item.state === 'ready')) {
      throw new Error('CONNECTION_NOT_READY')
    }
  }
  authorize()
  if (!current.threadHistory) return { status: 'unavailable', code: 'CHANNEL_THREAD_HISTORY_UNAVAILABLE' }
  const result = await current.threadHistory(ref, {
    conversationId,
    kind: kind as 'direct' | 'group',
    threadId,
    anchorMessageId,
    pageSize: Number(pageSize),
    order: order as 'asc' | 'desc',
    ...(pageToken ? { pageToken } : {}),
  }, authorize)
  authorize()
  return result
}
