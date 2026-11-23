import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelAgentAccess } from './channel-agent-access.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import {
  channelCommandScope,
  channelExact,
  channelPolicyAllows,
  channelPolicyDenied,
  channelRecord,
  channelSameScope,
  channelText,
} from './channel-conversation-policy.js'

/** Host-owned task admission only; it is not a command, send or identity grant. */
export interface ChannelGroupTaskAccess {
  readonly adapterId: string
  readonly accountId: string
  readonly tenantId: string
  readonly conversationId: string
  readonly fromSequence: number
}

export function parseChannelGroupTaskAccess(value: unknown): readonly ChannelGroupTaskAccess[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1024) throw new Error('INVALID_GROUP_ACCESS')
  const result = value.map(raw => {
    const item = channelRecord(raw)
    channelExact(item, ['adapterId', 'accountId', 'tenantId', 'conversationId', 'fromSequence'])
    if (!Number.isSafeInteger(item.fromSequence) || Number(item.fromSequence) < 1) {
      throw new Error('INVALID_GROUP_ACCESS')
    }
    return {
      adapterId: channelText(item.adapterId),
      accountId: channelText(item.accountId),
      tenantId: channelText(item.tenantId),
      conversationId: channelText(item.conversationId),
      fromSequence: Number(item.fromSequence),
    }
  })
  if (result.some((item, index) => result.slice(0, index).some(prior => channelSameScope(prior, item)))) {
    throw new Error('INVALID_GROUP_ACCESS')
  }
  return result
}

function verifiedActor(event: ChannelEventRef): boolean {
  return !!event.actor?.userId && event.actor.adapterId === event.adapterId
    && event.actor.accountId === event.accountId && event.actor.tenantId === event.tenantId
}

export function channelGroupSourceRecord(state: ChannelConversationState, event: ChannelEventRef) {
  const records = Object.values(state.inputs).filter(record => isDeepStrictEqual(record.input.source.event, event))
  return records.length === 1 ? records[0] : undefined
}

/** Recheck the original authenticated input at dispatch, steer and subsequent authorization boundaries. */
export function channelDispatchAllowed(state: ChannelConversationState, event: ChannelEventRef): boolean {
  if (channelPolicyAllows(state.policy, 'dispatch', event)) return true
  if (event.kind !== 'group' || !verifiedActor(event) || channelPolicyDenied(state.policy, 'dispatch', event)) {
    return false
  }
  const grant = state.groupTaskAccess?.find(item => channelSameScope(item, event))
  const record = grant && channelGroupSourceRecord(state, event)
  return !!grant && !!record?.mentionedBot && record.sequence >= grant.fromSequence
}

/** Accept direct requests and common explanatory suffixes, never a quoted, negated or other-group instruction. */
export function channelGroupAccessIntent(request: string | undefined, enabled: boolean): boolean {
  if (!request || request.length > 2048 || /["“”「」『』`\n\r]/u.test(request)) return false
  const text = request.trim().replace(/[。.!！?？]+$/u, '').trim()
  const parts = text.split(/[，,；;]/u).map(part => part.trim())
  if (parts.length > 2) return false
  const suffix = parts[1]
  if (
    suffix && !(enabled
      ? /^(?:(?:让|这样|在)?(?:这个群|本群|群里|这个群里|当前群里)(?:的)?(?:所有)?(?:人|成员|用户|同事)?(?:都)?(?:能|可以)(?:和(?:他|你|机器人)(?:说话|对话|聊天)|发起任务|使用机器人))$/u
      : /^(?:恢复原有权限|恢复原来的权限|停止群成员发起任务)$/u).test(suffix)
  ) return false
  const direct = parts[0]!.replace(/(?:吧|一下|就行|就好)$/u, '').trim()
  return enabled
    ? /^(?:(?:请|麻烦)?(?:帮我)?)(?:给|把|将)?(?:这个群|当前群|本群|这群)(?:群聊)?(?:开白|加白|加入白名单|添加到白名单|开放(?:对话|任务权限))$/u
      .test(direct)
      || /^(?:please )?(?:whitelist|allow tasks in|enable tasks in) (?:this|the current) (?:group|group chat)$/iu
        .test(text)
    : /^(?:(?:请|麻烦)?(?:帮我)?)(?:给|把|将)?(?:这个群|当前群|本群|这群)(?:群聊)?(?:关白|取消开白|撤销开白|移出白名单|移除白名单|关闭(?:对话|任务权限))$/u
      .test(direct)
      || /^(?:please )?(?:unwhitelist|revoke tasks in|disable tasks in) (?:this|the current) (?:group|group chat)$/iu
        .test(text)
}

export async function channelGroupAccessOperation(input: {
  readonly operation: string
  readonly value: unknown
  readonly metadata: unknown
  readonly store: ChannelConversationStore
  readonly agent: ChannelAgentAccess
  readonly access: () => ChannelConversationAccess | undefined
  readonly signal: AbortSignal
}) {
  const args = channelRecord(input.value), write = input.operation === 'group-access-set'
  channelExact(args, write ? ['enabled', 'expectedRevision'] : [])
  if (
    write && (typeof args.enabled !== 'boolean' || !Number.isSafeInteger(args.expectedRevision)
      || Number(args.expectedRevision) < 0)
  ) throw new Error('INVALID_REQUEST')
  const caller = input.agent.caller(input.metadata), event = caller?.source, access = input.access()
  if (!event || !verifiedActor(event)) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  if (event.kind !== 'group') throw new Error('CHANNEL_GROUP_REQUIRED')
  const generation = access?.generation
  const live = () =>
    !input.signal.aborted && generation !== undefined && input.access()?.generation === generation
    && input.access()?.accounts().some(account =>
      channelSameScope(account.ref, {
        adapterId: event.adapterId,
        accountId: event.accountId,
        tenantId: event.tenantId,
      }) && account.state === 'ready'
    )
    && isDeepStrictEqual(input.agent.caller(input.metadata)?.source, event)
  if (!live()) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  const scope = channelCommandScope(event, false)
  const read = (state: ChannelConversationState) => ({
    revision: state.policyRevision,
    scope,
    enabled: state.groupTaskAccess?.some(item => channelSameScope(item, event)) ?? false,
    reception: 'mentions' as const,
    canEnable: state.policy.enabled && channelPolicyAllows(state.policy, 'command', event, 'allow-user'),
    canRevoke: state.policy.enabled && channelPolicyAllows(state.policy, 'command', event, 'reset-user'),
  })
  if (!write) return { status: 'ok', ...read(input.store.snapshot()) }
  await input.store.mutate(state => {
    if (!live()) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
    if (
      !state.policy.enabled
      || !channelPolicyAllows(state.policy, 'command', event, args.enabled ? 'allow-user' : 'reset-user')
    ) {
      throw new Error('CHANNEL_PERMISSION_DENIED')
    }
    const record = channelGroupSourceRecord(state, event)
    if (!record?.accepted || !record.routed || !record.mentionedBot) throw new Error('CHANNEL_GROUP_MENTION_REQUIRED')
    if (!channelGroupAccessIntent(input.agent.requestText(input.metadata), args.enabled as boolean)) {
      throw new Error('CHANNEL_GROUP_REQUEST_REQUIRED')
    }
    if (state.policyRevision !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
    const prior = state.groupTaskAccess ?? []
    const exists = prior.some(item => channelSameScope(item, event))
    if (exists === args.enabled) return
    state.groupTaskAccess = parseChannelGroupTaskAccess([
      ...prior.filter(item => !channelSameScope(item, event)),
      ...(args.enabled ? [{ ...scope, fromSequence: state.nextSequence }] : []),
    ])
    state.policyRevision += 1
  })
  return { status: 'ok', ...read(input.store.snapshot()) }
}
