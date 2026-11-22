import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { ChannelAdminPairing } from './channel-admin-pairing.js'
import type { ChannelGroupGuidance } from './channel-group-guidance.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'

const ADMIN_COMMANDS = [
  'bind',
  'unbind',
  'messages-on',
  'messages-off',
  'allow-user',
  'deny-user',
  'reset-user',
  'wake',
]
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
const same = (a: ChannelTenantRef, b: ChannelTenantRef) =>
  a.adapterId === b.adapterId && a.accountId === b.accountId && a.tenantId === b.tenantId

/** Called only from the authenticated SDK connection, before ordinary message persistence. */
export async function receiveAdminPairing(
  pairing: ChannelAdminPairing,
  guidance: Pick<ChannelGroupGuidance, 'reserve'>,
  consumer: ChannelConversationConsumer,
  ref: ChannelTenantRef,
  generation: string,
  message: NormalizedMessage,
): Promise<{ accepted: boolean; reply: boolean }> {
  const raw = message.raw as {
    sender?: { sender_id?: { open_id?: unknown }; tenant_key?: unknown; sender_type?: unknown }
  } | undefined
  const sender = raw?.sender
  const userId = sender?.sender_id?.open_id
  const match = /^\/pair\s+([A-Za-z0-9_-]{22})$/iu.exec(message.content.trim())
  const validSender = typeof userId === 'string' && /^ou_[A-Za-z0-9_]{1,508}$/u.test(userId)
    && userId === message.senderId
    && sender?.sender_type === 'user' && sender.tenant_key === ref.tenantId
  const policy = consumer.policy().policy
  if (!validSender || !message.chatId || !policy.enabled) {
    return { accepted: false, reply: false }
  }
  if (message.chatType === 'group') {
    const group: ChannelEventRef = {
      ...ref,
      conversationId: message.chatId,
      kind: 'group',
      threadId: message.chatId,
      semantics: 'conversation',
      eventId: message.messageId,
      actor: { ...ref, userId },
    }
    if (
      !message.mentionedBot || !channelPolicyAllows(policy, 'send', group)
      || !channelPolicyAllows(policy, 'command', group, 'help') || !await guidance.reserve(ref, message.chatId)
    ) {
      return { accepted: false, reply: false }
    }
    const latest = consumer.policy().policy
    return {
      accepted: false,
      reply: latest.enabled && channelPolicyAllows(latest, 'send', group)
        && channelPolicyAllows(latest, 'command', group, 'help'),
    }
  }
  if (message.chatType !== 'p2p') return { accepted: false, reply: false }
  const event: ChannelEventRef = {
    ...ref,
    conversationId: message.chatId,
    kind: 'direct',
    threadId: message.chatId,
    semantics: 'conversation',
    eventId: message.messageId,
    actor: { ...ref, userId },
  }
  const reply = channelPolicyAllows(policy, 'send', event)
  const accepted = !!match && pairing.receive({
    account: ref,
    generation,
    code: match[1]!,
    chatType: message.chatType,
    conversationId: message.chatId,
    senderId: userId,
    senderTenant: sender.tenant_key,
    senderType: sender.sender_type,
    eventTime: message.createTime,
  })
  return { accepted, reply }
}

/** Management-only RPC. Caller identity must be an explicit local user, never a Channel/Agent context. */
export async function channelAdminPairingOperation(input: {
  readonly operation: string
  readonly value: unknown
  readonly metadata?: unknown
  readonly access: ChannelConversationAccess | undefined
  readonly consumer: ChannelConversationConsumer | undefined
  readonly pairing: ChannelAdminPairing | undefined
}): Promise<unknown> {
  try {
    if (input.metadata !== undefined) throw new Error('LOCAL_USER_REQUIRED')
    const { pairing, consumer, access } = input
    if (!pairing || !consumer || !access) throw new Error('CHANNEL_UNAVAILABLE')
    const args = object(input.value)
    if (input.operation === 'admin-pair-begin') {
      if (Object.keys(args).some(key => key !== 'account')) throw new Error('INVALID_REQUEST')
      const raw = object(args.account)
      if (Object.keys(raw).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
        throw new Error('INVALID_REQUEST')
      }
      const account = { adapterId: id(raw.adapterId), accountId: id(raw.accountId), tenantId: id(raw.tenantId) }
      if (!access.accounts().some(item => same(item.ref, account) && item.state === 'ready')) {
        throw new Error('CHANNEL_UNAVAILABLE')
      }
      const policy = consumer.policy()
      if (!policy.policy.enabled) throw new Error('CHANNEL_POLICY_DISABLED')
      return { status: 'ok', ...pairing.begin(account, access.generation, policy.revision) }
    }
    if (Object.keys(args).some(key => key !== 'pairingId')) throw new Error('INVALID_REQUEST')
    const pairingId = id(args.pairingId)
    if (input.operation === 'admin-pair-status') {
      return {
        status: 'ok',
        ...pairing.inspect(pairingId),
        commandPermissions: [...ADMIN_COMMANDS],
        taskDispatchGrant: false,
      }
    }
    if (input.operation === 'admin-pair-cancel') {
      if (!pairing.cancel(pairingId)) throw new Error('PAIRING_UNAVAILABLE')
      return { status: 'ok', state: 'cancelled' }
    }
    if (input.operation !== 'admin-pair-confirm') throw new Error('INVALID_REQUEST')
    const preview = pairing.inspect(pairingId)
    if (!access.accounts().some(item => same(item.ref, preview.account) && item.state === 'ready')) {
      throw new Error('CHANNEL_UNAVAILABLE')
    }
    const claimed = pairing.take(pairingId, access.generation)
    const current = consumer.policy()
    if (!current.policy.enabled || current.revision !== claimed.policyRevision) throw new Error('REVISION_CONFLICT')
    const rule = {
      id: `pair:${pairingId}`,
      ...claimed.account,
      conversationId: claimed.candidate.conversationId,
      action: 'command' as const,
      effect: 'allow' as const,
      kinds: ['direct' as const],
      userIds: [claimed.candidate.userId],
      commands: ADMIN_COMMANDS,
    }
    const result = await consumer.policySet(
      { ...current.policy, rules: [...current.policy.rules, rule] },
      current.revision,
    )
    return {
      status: 'ok',
      state: 'paired',
      account: claimed.account,
      candidate: claimed.candidate,
      revision: result.revision,
    }
  } catch (error) {
    return {
      status: 'rejected',
      code: error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message) ? error.message : 'PAIRING_FAILED',
    }
  }
}
