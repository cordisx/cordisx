import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { CHANNEL_COMMAND_NAMES } from '../channel-command-registry.js'
import {
  type ChannelAutoReplyMode,
  type ChannelReplyMode,
  channelReplyMode,
  type ChannelReplyRule,
  channelReplyRulesOverlap,
} from './channel-reply-routing.js'

export type ChannelPolicyAction = 'dispatch' | 'command' | 'send'
export interface ChannelPolicyScope {
  readonly adapterId?: string
  readonly accountId?: string
  readonly tenantId?: string
  readonly conversationId?: string
}
export const channelSameScope = (left: ChannelPolicyScope, right: ChannelPolicyScope): boolean =>
  ['adapterId', 'accountId', 'tenantId', 'conversationId'].every(field =>
    left[field as keyof ChannelPolicyScope] === right[field as keyof ChannelPolicyScope]
  )
export const channelCommandScope = (event: ChannelEventRef, global: boolean): ChannelPolicyScope =>
  global ? {} : {
    adapterId: event.adapterId,
    accountId: event.accountId,
    tenantId: event.tenantId,
    conversationId: event.conversationId,
  }
export interface ChannelUserGroup {
  readonly id: string
  readonly name: string
  readonly members: readonly (ChannelPolicyScope & { readonly userId: string })[]
}
export interface ChannelPolicyRule extends ChannelPolicyScope {
  readonly id: string
  readonly action: ChannelPolicyAction
  readonly effect: 'allow' | 'deny'
  readonly kinds?: readonly ('direct' | 'group')[]
  readonly userIds?: readonly string[]
  readonly userGroupIds?: readonly string[]
  readonly commands?: readonly string[]
}
export interface ChannelConversationPolicy {
  readonly enabled: boolean
  readonly autoCreate: boolean
  readonly autoReply: boolean
  readonly replyMode: ChannelAutoReplyMode
  readonly replyFallbackMode: ChannelReplyMode
  readonly replyModes: readonly ChannelReplyRule[]
  readonly groupReception: 'all' | 'mentions'
  readonly groups: readonly ChannelUserGroup[]
  readonly rules: readonly ChannelPolicyRule[]
  readonly wakePrefixes: readonly (ChannelPolicyScope & { readonly prefixes: readonly string[] })[]
  readonly sidebarGroup?: string | null
}
export const CHANNEL_CONVERSATION_POLICY_INITIAL: ChannelConversationPolicy = Object.freeze({
  enabled: false,
  autoCreate: true,
  autoReply: false,
  replyMode: 'agent',
  replyFallbackMode: 'conversation',
  replyModes: [],
  groupReception: 'mentions',
  groups: [],
  rules: [],
  wakePrefixes: [],
})
export const CHANNEL_COMMANDS = CHANNEL_COMMAND_NAMES
const LEGACY_COMMANDS = new Set([
  'bind',
  'unbind',
  'bind-status',
  'messages-on',
  'messages-off',
  'messages-status',
  'allow-user',
  'deny-user',
  'reset-user',
  'wake',
])

/** Successor commands do not widen frozen v1/v2 command documents. */
export function channelConversationPolicyV2(policy: ChannelConversationPolicy) {
  const { sidebarGroup: _group, ...prior } = policy
  return {
    ...prior,
    rules: prior.rules.map(rule => ({
      ...rule,
      ...(rule.commands
        ? { commands: rule.commands.filter(command => LEGACY_COMMANDS.has(command)) }
        : {}),
    })).filter(rule => !rule.commands || rule.commands.length > 0),
  }
}

/** Frozen Manager v4/v5 readback must not acquire successor fields. */
export function channelConversationPolicyV1(policy: ChannelConversationPolicy) {
  const { replyMode: _mode, replyFallbackMode: _fallback, replyModes: _scopes, sidebarGroup: _group, ...legacy } =
    policy
  return {
    ...legacy,
    rules: legacy.rules.map(rule => ({
      ...rule,
      ...(rule.commands
        ? { commands: rule.commands.filter(command => LEGACY_COMMANDS.has(command)) }
        : {}),
    })).filter(rule => !rule.commands || rule.commands.length > 0),
  }
}

/** Preserve commands an older form cannot display, including their original scope and deny/allow semantics. */
export function mergeLegacyChannelPolicy(
  latest: ChannelConversationPolicy,
  edited: ChannelConversationPolicy,
): ChannelConversationPolicy {
  const rules = edited.rules.map(rule => ({ ...rule }))
  const used = new Set(rules.map(rule => rule.id))
  for (const prior of latest.rules) {
    const commands = prior.commands?.filter(command => !LEGACY_COMMANDS.has(command))
    if (!commands?.length) continue
    const index = rules.findIndex(rule => rule.id === prior.id)
    const candidate = rules[index]
    const withoutCommands = (rule: ChannelPolicyRule) => {
      const { commands: _commands, ...scope } = rule
      return scope
    }
    if (
      candidate && candidate.commands
      && JSON.stringify(withoutCommands(candidate)) === JSON.stringify(withoutCommands(prior))
    ) {
      rules[index] = { ...candidate, commands: [...candidate.commands, ...commands] }
      continue
    }
    let id = prior.id
    for (let suffix = 1; used.has(id); suffix++) id = `${prior.id}:workflow:${suffix}`
    used.add(id)
    rules.push({ ...prior, id, commands })
  }
  return {
    ...latest,
    ...edited,
    groups: [
      ...edited.groups,
      ...latest.groups.filter(group =>
        !edited.groups.some(item => item.id === group.id)
        && rules.some(rule =>
          rule.commands?.some(command => !LEGACY_COMMANDS.has(command))
          && rule.userGroupIds?.includes(group.id)
        )
      ),
    ],
    ...(latest.sidebarGroup === undefined ? {} : { sidebarGroup: latest.sidebarGroup }),
    rules,
  }
}

export function channelRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
export function channelText(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
export function channelExact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('INVALID_REQUEST')
}
const SCOPES = ['adapterId', 'accountId', 'tenantId', 'conversationId'] as const
function scope(value: Record<string, unknown>): ChannelPolicyScope {
  return Object.fromEntries(SCOPES.flatMap(key => value[key] === undefined ? [] : [[key, channelText(value[key])]]))
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('INVALID_REQUEST')
  const result = value.map(item => channelText(item))
  if (new Set(result).size !== result.length) throw new Error('INVALID_REQUEST')
  return result
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('INVALID_REQUEST')
  return value
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value.map(channelRecord)
}

/** Host consumer policy is separate from the frozen, transport-only Channel service config. */
export function parseChannelConversationPolicy(value: unknown): ChannelConversationPolicy {
  if (value === undefined) return CHANNEL_CONVERSATION_POLICY_INITIAL
  const input = channelRecord(value)
  channelExact(input, [
    'enabled',
    'autoCreate',
    'autoReply',
    'groupReception',
    'groups',
    'rules',
    'wakePrefixes',
    'replyMode',
    'replyFallbackMode',
    'replyModes',
    'sidebarGroup',
  ])
  const groups = rows(input.groups).map(group => {
    channelExact(group, ['id', 'name', 'members'])
    const members = rows(group.members).map(member => {
      channelExact(member, [...SCOPES, 'userId'])
      return { ...scope(member), userId: channelText(member.userId) }
    })
    return { id: channelText(group.id), name: channelText(group.name ?? group.id), members }
  })
  if (new Set(groups.map(group => group.id)).size !== groups.length) throw new Error('INVALID_REQUEST')
  const rules = rows(input.rules).map(rule => {
    channelExact(rule, [...SCOPES, 'id', 'action', 'effect', 'kinds', 'userIds', 'userGroupIds', 'commands'])
    if (
      !['dispatch', 'command', 'send'].includes(String(rule.action)) || !['allow', 'deny'].includes(String(rule.effect))
    ) {
      throw new Error('INVALID_REQUEST')
    }
    const kinds = rule.kinds === undefined ? undefined : strings(rule.kinds)
    if (kinds?.some(kind => !['direct', 'group'].includes(kind))) throw new Error('INVALID_REQUEST')
    const userGroupIds = rule.userGroupIds === undefined ? undefined : strings(rule.userGroupIds)
    if (userGroupIds?.some(id => !groups.some(group => group.id === id))) throw new Error('INVALID_USER_GROUP')
    const commands = rule.commands === undefined ? undefined : strings(rule.commands)
    if (commands?.some(command => !(CHANNEL_COMMAND_NAMES as readonly string[]).includes(command))) {
      throw new Error('INVALID_COMMAND')
    }
    return {
      ...scope(rule),
      id: channelText(rule.id),
      action: rule.action as ChannelPolicyAction,
      effect: rule.effect as 'allow' | 'deny',
      ...(kinds === undefined ? {} : { kinds: kinds as readonly ('direct' | 'group')[] }),
      ...(rule.userIds === undefined ? {} : { userIds: strings(rule.userIds) }),
      ...(userGroupIds === undefined ? {} : { userGroupIds }),
      ...(commands === undefined ? {} : { commands }),
    }
  })
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('INVALID_REQUEST')
  const wakePrefixes = rows(input.wakePrefixes).map(item => {
    channelExact(item, [...SCOPES, 'prefixes'])
    return { ...scope(item), prefixes: strings(item.prefixes) }
  })
  if (wakePrefixes.some((item, index) => wakePrefixes.slice(0, index).some(prior => channelSameScope(item, prior)))) {
    throw new Error('DUPLICATE_WAKE_SCOPE')
  }
  const groupReception = input.groupReception ?? 'mentions'
  if (groupReception !== 'all' && groupReception !== 'mentions') throw new Error('INVALID_REQUEST')
  const replyModes: ChannelReplyRule[] = rows(input.replyModes).map(item => {
    channelExact(item, [...SCOPES, 'mode', 'fallbackMode', 'kinds'])
    const kinds = item.kinds === undefined ? undefined : strings(item.kinds)
    if (kinds?.some(kind => !['direct', 'group'].includes(kind))) throw new Error('INVALID_REQUEST')
    return {
      ...scope(item),
      mode: channelReplyMode(item.mode, true),
      ...(item.fallbackMode === undefined
        ? {}
        : { fallbackMode: channelReplyMode(item.fallbackMode) as ChannelReplyMode }),
      ...(kinds === undefined ? {} : { kinds: kinds as readonly ('direct' | 'group')[] }),
    }
  })
  if (
    replyModes.some((item, index) => replyModes.slice(0, index).some(prior => channelReplyRulesOverlap(item, prior)))
  ) {
    throw new Error('AMBIGUOUS_REPLY_SCOPE')
  }
  return {
    enabled: boolean(input.enabled, false),
    autoCreate: boolean(input.autoCreate, true),
    autoReply: boolean(input.autoReply, false),
    replyMode: channelReplyMode(input.replyMode ?? 'agent', true),
    replyFallbackMode: channelReplyMode(input.replyFallbackMode ?? 'conversation') as ChannelReplyMode,
    replyModes,
    groupReception,
    groups,
    rules,
    wakePrefixes,
    ...(input.sidebarGroup === undefined
      ? {}
      : { sidebarGroup: input.sidebarGroup === null ? null : channelText(input.sidebarGroup, 80) }),
  }
}

function scopeMatches(rule: ChannelPolicyScope, event: ChannelEventRef): boolean {
  return SCOPES.every(key => rule[key] === undefined || rule[key] === event[key])
}
function matches(
  rule: ChannelPolicyRule,
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  command?: string,
): boolean {
  return scopeMatches(rule, event)
    && (rule.kinds === undefined || rule.kinds.includes(event.kind as 'direct' | 'group'))
    && (rule.userIds === undefined || !!event.actor && rule.userIds.includes(event.actor.userId))
    && (rule.userGroupIds === undefined
      || !!event.actor
        && rule.userGroupIds.some(id =>
          policy.groups.some(group =>
            group.id === id
            && group.members.some(member => member.userId === event.actor!.userId && scopeMatches(member, event))
          )
        ))
    && (rule.commands === undefined || command !== undefined && rule.commands.includes(command))
}

/** Read-only discovery uses no mutation grant, while explicit command denials still apply. */
export function channelCommandDenied(
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  command: string,
): boolean {
  return policy.rules.some(rule =>
    rule.action === 'command' && rule.effect === 'deny' && matches(rule, policy, event, command)
  )
}

/** Denials win. Allowlists at global and narrower scopes each apply, so their intersection is enforced. */
export function channelPolicyAllows(
  policy: ChannelConversationPolicy,
  action: ChannelPolicyAction,
  event: ChannelEventRef,
  command?: string,
): boolean {
  const rules = policy.rules.filter(rule => rule.action === action)
  if (rules.some(rule => rule.effect === 'deny' && matches(rule, policy, event, command))) return false
  const buckets = new Map<string, ChannelPolicyRule[]>()
  for (
    const rule of rules.filter(rule =>
      rule.effect === 'allow' && scopeMatches(rule, event)
      && (rule.kinds === undefined || rule.kinds.includes(event.kind as 'direct' | 'group'))
      && (rule.commands === undefined || command !== undefined && rule.commands.includes(command))
    )
  ) {
    const key = JSON.stringify(SCOPES.map(field => rule[field] ?? null))
    buckets.set(key, [...buckets.get(key) ?? [], rule])
  }
  if (buckets.size === 0) {
    return action !== 'command'
      || ['bind-status', 'messages-status', 'help', 'approvals', 'models', 'task-requests', 'task-settings'].includes(
        command ?? '',
      )
  }
  return [...buckets.values()].every(bucket => bucket.some(rule => matches(rule, policy, event, command)))
}

/** A global mutation requires a global grant as well as permission at the actual source. */
export function channelGlobalCommandAllowed(
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  command: string,
): boolean {
  if (!channelPolicyAllows(policy, 'command', event, command)) return false
  // An empty scope cannot match a configured exact scope: channelText rejects
  // empty scope values. Thus scoped rules or scoped group memberships alone
  // cannot authorize mutation of the whole profile.
  const globalEvent = { ...event, adapterId: '', accountId: '', tenantId: '', conversationId: '' }
  return policy.rules.some(rule =>
    rule.action === 'command' && rule.effect === 'allow'
    && SCOPES.every(key => rule[key] === undefined) && matches(rule, policy, globalEvent, command)
  ) && channelPolicyAllows(policy, 'command', globalEvent, command)
}

/** The most specific configured prefix set wins; there is no implicit response to unrelated group chatter. */
export function channelWakePrefix(
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  text: string,
): string | undefined {
  const applicable = policy.wakePrefixes.filter(item => scopeMatches(item, event))
  const specificity = (item: ChannelPolicyScope) => SCOPES.filter(key => item[key] !== undefined).length
  const maximum = Math.max(-1, ...applicable.map(specificity))
  return applicable.filter(item => specificity(item) === maximum).flatMap(item => item.prefixes)
    .find(prefix => text === prefix || text.startsWith(prefix + ' ') || text.startsWith(prefix + '\n'))
}
