import { createHash } from 'node:crypto'
import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import { channelExact, channelRecord, channelText } from './channel-conversation-policy.js'

/** Conversation identity and binding target parsing are shared by dispatch and question routing. */
export const identity = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sameConversation = (left: ChannelThreadRef, right: ChannelThreadRef): boolean =>
  ['adapterId', 'accountId', 'tenantId', 'conversationId'].every(key =>
    left[key as keyof ChannelThreadRef] === right[key as keyof ChannelThreadRef]
  )
export const bindingIdentity = (profileId: string, channel: ChannelThreadRef, sessionId: string): string =>
  `binding:${
    identity([profileId, channel.adapterId, channel.accountId, channel.tenantId, channel.conversationId, sessionId])
  }`
export function eventThread(event: ChannelEventRef): ChannelThreadRef {
  const { adapterId, accountId, tenantId, conversationId, kind, threadId, semantics } = event
  return { adapterId, accountId, tenantId, conversationId, kind, threadId, semantics }
}
export function thread(value: unknown): ChannelThreadRef {
  const ref = channelRecord(value)
  channelExact(ref, ['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind', 'threadId', 'semantics'])
  if (!['direct', 'group'].includes(String(ref.kind))) throw new Error('INVALID_TARGET')
  const conversationId = channelText(ref.conversationId)
  if (['feishu', 'lark'].includes(String(ref.adapterId)) && !/^oc_[A-Za-z0-9_]+$/u.test(conversationId)) {
    throw new Error('INVALID_TARGET')
  }
  const semantics = ref.semantics ?? 'conversation'
  if (!['conversation', 'topic', 'reply-chain'].includes(String(semantics))) throw new Error('INVALID_TARGET')
  return {
    adapterId: channelText(ref.adapterId),
    accountId: channelText(ref.accountId),
    tenantId: channelText(ref.tenantId),
    conversationId,
    kind: ref.kind as 'direct' | 'group',
    threadId: channelText(ref.threadId ?? conversationId),
    semantics: semantics as ChannelThreadRef['semantics'],
  }
}
