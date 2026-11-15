import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationPolicy, ChannelPolicyScope } from './channel-conversation-policy.js'

export const CHANNEL_REPLY_MODES = ['conversation', 'reply', 'thread', 'none'] as const
export type ChannelReplyMode = typeof CHANNEL_REPLY_MODES[number]
export type ChannelAutoReplyMode = ChannelReplyMode | 'agent'
export interface ChannelReplyDefaults {
  readonly mode: ChannelAutoReplyMode
  readonly fallbackMode: ChannelReplyMode
}
export interface ChannelReplyCapabilities {
  readonly reply: boolean
  readonly thread: boolean
}
export interface ChannelReplyRule extends ChannelPolicyScope {
  readonly mode: ChannelAutoReplyMode
  readonly fallbackMode?: ChannelReplyMode
  readonly kinds?: readonly ('direct' | 'group')[]
}

export function channelReplyMode(value: unknown, agent = false): ChannelAutoReplyMode {
  if ((CHANNEL_REPLY_MODES as readonly unknown[]).includes(value) || agent && value === 'agent') {
    return value as ChannelAutoReplyMode
  }
  throw new Error('INVALID_REPLY_MODE')
}

const fields = ['adapterId', 'accountId', 'tenantId', 'conversationId'] as const
const specificity = (rule: ChannelReplyRule) =>
  fields.filter(field => rule[field] !== undefined).length + Number(rule.kinds !== undefined)

/** Reject overlapping ties rather than depending on array/registration order. */
export function channelReplyRulesOverlap(left: ChannelReplyRule, right: ChannelReplyRule): boolean {
  return specificity(left) === specificity(right)
    && fields.every(field => left[field] === undefined || right[field] === undefined || left[field] === right[field])
    && (left.kinds === undefined || right.kinds === undefined || left.kinds.some(kind => right.kinds!.includes(kind)))
}

export function channelReplyDefaults(
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  binding?: { readonly replyMode?: ChannelAutoReplyMode; readonly replyFallbackMode?: ChannelReplyMode },
): ChannelReplyDefaults {
  const applicable = policy.replyModes.filter(rule =>
    fields.every(field => rule[field] === undefined || rule[field] === event[field])
    && (rule.kinds === undefined || rule.kinds.includes(event.kind as 'direct' | 'group'))
  ).sort((left, right) => specificity(right) - specificity(left))
  const rule = applicable[0]
  return {
    mode: binding?.replyMode ?? rule?.mode ?? policy.replyMode,
    fallbackMode: binding?.replyFallbackMode ?? rule?.fallbackMode ?? policy.replyFallbackMode,
  }
}

/** Existing thread identity semantics express all three routes; no transport-specific option is persisted. */
export function channelReplyTarget(event: ChannelEventRef, mode: Exclude<ChannelReplyMode, 'none'>): ChannelThreadRef {
  const { adapterId, accountId, tenantId, conversationId, kind } = event
  const anchor = event.messageId ?? (event.semantics === 'conversation' ? undefined : event.threadId)
  if (mode !== 'conversation' && !anchor) throw new Error('REPLY_MESSAGE_REQUIRED')
  return {
    adapterId,
    accountId,
    tenantId,
    conversationId,
    kind,
    threadId: mode === 'conversation' ? conversationId : anchor!,
    semantics: mode === 'conversation' ? 'conversation' : mode === 'reply' ? 'reply-chain' : 'topic',
  }
}

/** Host command results use supported threads independently of the Agent's automatic reply policy. */
export function channelCommandReplyTarget(
  event: ChannelEventRef,
  capabilities?: ChannelReplyCapabilities,
): ChannelThreadRef {
  const anchored = Boolean(event.messageId || event.semantics !== 'conversation' && event.threadId)
  return channelReplyTarget(
    event,
    anchored && capabilities?.thread ? 'thread' : anchored && capabilities?.reply ? 'reply' : 'conversation',
  )
}
