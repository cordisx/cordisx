import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-access.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'

const sameAccount = (left: ChannelTenantRef, right: ChannelTenantRef) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId

export async function channelMessageSearchRpc(input: Record<string, unknown>, ref: ChannelTenantRef, context: {
  current: ChannelConversationAccess
  consumer?: ChannelConversationConsumer | undefined
  source?: ChannelEventRef | undefined
  nativeCaller?: string | undefined
  active(): boolean
}) {
  if (
    Object.keys(input).some(key =>
      !['account', 'conversationId', 'kind', 'query', 'startTime', 'endTime', 'pageSize', 'pageToken'].includes(key)
    )
  ) {
    throw new Error('INVALID_REQUEST')
  }
  const { conversationId, kind, query, startTime, endTime, pageToken } = input
  const pageSize = input.pageSize ?? 50
  if (
    typeof conversationId !== 'string' || !/^oc_[A-Za-z0-9_]{1,200}$/u.test(conversationId)
    || kind !== 'direct' && kind !== 'group' || typeof query !== 'string' || !query.trim() || query.length > 1024
    || query.includes('\u0000')
    || typeof startTime !== 'string' || !/^[0-9]{1,13}$/u.test(startTime) || typeof endTime !== 'string'
    || !/^[0-9]{1,13}$/u.test(endTime)
    || BigInt(startTime) >= BigInt(endTime) || BigInt(endTime) * 1000n > 8_640_000_000_000_000n
    || !Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 50
    || pageToken !== undefined
      && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 2048 || /[\u0000\r\n]/u.test(pageToken))
  ) {
    throw new Error('INVALID_REQUEST')
  }
  const { current, source, consumer, nativeCaller } = context
  const authorize = () => {
    if (!context.active()) throw new Error('CHANNEL_GENERATION_CHANGED')
    if (nativeCaller && consumer?.taskSettings.isBound(nativeCaller) && !source) {
      throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
    }
    if (source && (!sameAccount(source, ref) || source.conversationId !== conversationId || source.kind !== kind)) {
      throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
    }
    if (source && consumer && !consumer.commandAllowed(source, 'history')) throw new Error('CHANNEL_POLICY_DENIED')
    if (!current.accounts().some(item => sameAccount(item.ref, ref) && item.state === 'ready')) {
      throw new Error('CONNECTION_NOT_READY')
    }
  }
  authorize()
  if (!current.messageSearch) return { status: 'unavailable', code: 'CHANNEL_SEARCH_UNAVAILABLE' }
  const result = await current.messageSearch(ref, {
    conversationId,
    kind,
    query,
    startTime,
    endTime,
    pageSize: Number(pageSize),
    ...(typeof pageToken === 'string' ? { pageToken } : {}),
  }, authorize)
  authorize()
  return result
}
