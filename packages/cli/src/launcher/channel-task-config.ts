import type { ChannelEventRef } from '@cordisx/channel-runtime'
import {
  type ChannelConversationPolicy,
  channelExact,
  type ChannelPolicyScope,
  channelRecord,
  channelText,
} from './channel-conversation-policy.js'
import { parseChatExecutionSettings } from '../chat-execution-settings.js'

export interface ChannelTaskPatch {
  readonly providerId?: string
  readonly model?: string
  readonly effort?: string
}
export interface ChannelTaskScope extends ChannelPolicyScope {
  readonly kinds?: readonly ('direct' | 'group')[]
  readonly userIds?: readonly string[]
  readonly userGroupIds?: readonly string[]
}
export interface ChannelTaskDefault extends ChannelTaskScope {
  readonly id: string
  readonly settings: ChannelTaskPatch
}
export interface ChannelTaskPermission extends ChannelTaskScope {
  readonly id: string
  readonly effect: 'allow' | 'deny'
  readonly fields?: readonly (keyof ChannelTaskPatch)[]
  readonly providerIds?: readonly string[]
  readonly models?: readonly { readonly providerId: string; readonly model: string }[]
  readonly efforts?: readonly string[]
}
export interface ChannelTaskConfig {
  readonly defaults: ChannelTaskPatch
  readonly scopes: readonly ChannelTaskDefault[]
  readonly permissions: readonly ChannelTaskPermission[]
}
export const CHANNEL_TASK_CONFIG_INITIAL: ChannelTaskConfig = { defaults: {}, scopes: [], permissions: [] }
const scopeFields = ['adapterId', 'accountId', 'tenantId', 'conversationId'] as const
const fields = ['providerId', 'model', 'effort'] as const
export function parseChannelTaskPatch(value: unknown): ChannelTaskPatch {
  const patch = channelRecord(value)
  channelExact(patch, fields)
  const output: Record<string, string> = {}
  for (const field of fields) {
    if (patch[field] !== undefined) output[field] = channelText(patch[field], field === 'providerId' ? 128 : 512)
  }
  if (output.effort) parseChatExecutionSettings({ effort: output.effort })
  return output
}
function strings(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length) throw new Error('INVALID_TASK_CONFIGURATION')
  const values = value.map(item => channelText(item))
  if (new Set(values).size !== values.length) throw new Error('INVALID_TASK_CONFIGURATION')
  return values
}
function scope(row: Record<string, unknown>): ChannelTaskScope {
  const kinds = strings(row.kinds)
  if (kinds?.some(kind => !['direct', 'group'].includes(kind))) throw new Error('INVALID_TASK_CONFIGURATION')
  return {
    ...Object.fromEntries(
      scopeFields.flatMap(field => row[field] === undefined ? [] : [[field, channelText(row[field])]]),
    ),
    ...(kinds ? { kinds: kinds as readonly ('direct' | 'group')[] } : {}),
    ...(row.userIds === undefined ? {} : { userIds: strings(row.userIds)! }),
    ...(row.userGroupIds === undefined ? {} : { userGroupIds: strings(row.userGroupIds)! }),
  }
}
export function parseChannelTaskConfig(value: unknown): ChannelTaskConfig {
  const row = channelRecord(value)
  channelExact(row, ['defaults', 'scopes', 'permissions'])
  const rows = (value: unknown): Record<string, unknown>[] => {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error('INVALID_TASK_CONFIGURATION')
    return value.map(channelRecord)
  }
  const scopes = rows(row.scopes).map(item => {
    channelExact(item, ['id', ...scopeFields, 'kinds', 'userIds', 'userGroupIds', 'settings'])
    return { ...scope(item), id: channelText(item.id), settings: parseChannelTaskPatch(item.settings) }
  })
  const permissions = rows(row.permissions).map(item => {
    channelExact(item, [
      'id',
      ...scopeFields,
      'kinds',
      'userIds',
      'userGroupIds',
      'effect',
      'fields',
      'providerIds',
      'models',
      'efforts',
    ])
    if (!['allow', 'deny'].includes(String(item.effect))) throw new Error('INVALID_TASK_CONFIGURATION')
    const selectedFields = strings(item.fields)
    if (selectedFields?.some(field => !(fields as readonly string[]).includes(field))) {
      throw new Error('INVALID_TASK_CONFIGURATION')
    }
    const models = item.models === undefined ? undefined : rows(item.models).map(model => {
      channelExact(model, ['providerId', 'model'])
      return { providerId: channelText(model.providerId, 128), model: channelText(model.model) }
    })
    if (models && new Set(models.map(model => JSON.stringify(model))).size !== models.length) {
      throw new Error('INVALID_TASK_CONFIGURATION')
    }
    if (models && !models.length) throw new Error('INVALID_TASK_CONFIGURATION')
    const providerIds = strings(item.providerIds), efforts = strings(item.efforts)
    for (const providerId of providerIds ?? []) channelText(providerId, 128)
    for (const model of models ?? []) channelText(model.model, 512)
    for (const effort of efforts ?? []) parseChatExecutionSettings({ effort })
    return {
      ...scope(item),
      id: channelText(item.id),
      effect: item.effect as 'allow' | 'deny',
      ...(selectedFields ? { fields: selectedFields as readonly (keyof ChannelTaskPatch)[] } : {}),
      ...(providerIds ? { providerIds } : {}),
      ...(models ? { models } : {}),
      ...(efforts ? { efforts } : {}),
    }
  })
  for (const entries of [scopes, permissions]) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('INVALID_TASK_CONFIGURATION')
  }
  return { defaults: parseChannelTaskPatch(row.defaults ?? {}), scopes, permissions }
}
const accountScope = (scope: ChannelTaskScope, event: ChannelEventRef) =>
  scopeFields.every(field => scope[field] === undefined || scope[field] === event[field])
export function channelTaskScopeMatches(
  scope: ChannelTaskScope,
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
): boolean {
  return accountScope(scope, event) && (!scope.kinds || scope.kinds.includes(event.kind as 'direct' | 'group'))
    && (!scope.userIds || !!event.actor && scope.userIds.includes(event.actor.userId))
    && (!scope.userGroupIds
      || !!event.actor && scope.userGroupIds.some(id =>
          policy.groups.some(group =>
            group.id === id
            && group.members.some(member => member.userId === event.actor!.userId && accountScope(member, event))
          )
        ))
}
export function channelTaskDefaults(
  config: ChannelTaskConfig,
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
): ChannelTaskPatch {
  const value: Record<string, string> = { ...config.defaults }
  const ranked = config.scopes.filter(rule => channelTaskScopeMatches(rule, policy, event)).map(rule => ({
    rule,
    rank: scopeFields.filter(field => rule[field] !== undefined).length * 4 + (rule.kinds ? 1 : 0)
      + (rule.userGroupIds ? 100 : 0) + (rule.userIds ? 200 : 0),
  })).sort((a, b) => a.rank - b.rank)
  const ranks = new Map<string, number>()
  for (const { rule, rank } of ranked) {
    for (const [field, choice] of Object.entries(rule.settings)) {
      if (ranks.get(field) === rank && value[field] !== choice) throw new Error('AMBIGUOUS_TASK_DEFAULTS')
      value[field] = choice
      ranks.set(field, rank)
    }
  }
  return value
}
/** Field/value constraints share account and actor scopes; denies win and allow buckets intersect. */
export function channelTaskChangeAllowed(
  config: ChannelTaskConfig,
  policy: ChannelConversationPolicy,
  event: ChannelEventRef,
  patch: ChannelTaskPatch,
  selection: ChannelTaskPatch,
): boolean {
  if (!event.actor?.userId) return false
  return Object.keys(patch).every(field => {
    const relevant = config.permissions.filter(rule =>
      (!rule.fields || rule.fields.includes(field as keyof ChannelTaskPatch))
      && accountScope(rule, event) && (!rule.kinds || rule.kinds.includes(event.kind as 'direct' | 'group'))
    )
    const valueMatches = (rule: ChannelTaskPermission) =>
      (!rule.providerIds || !!selection.providerId && rule.providerIds.includes(selection.providerId))
      && (!rule.models
        || rule.models.some(model => model.providerId === selection.providerId && model.model === selection.model))
      && (!rule.efforts || !!selection.effort && rule.efforts.includes(selection.effort))
    if (
      relevant.some(rule =>
        rule.effect === 'deny' && channelTaskScopeMatches(rule, policy, event) && valueMatches(rule)
      )
    ) return false
    const buckets = new Map<string, ChannelTaskPermission[]>()
    for (const rule of relevant.filter(rule => rule.effect === 'allow')) {
      const key = JSON.stringify(scopeFields.map(field => rule[field] ?? null))
      buckets.set(key, [...buckets.get(key) ?? [], rule])
    }
    return buckets.size > 0
      && [...buckets.values()].every(bucket =>
        bucket.some(rule => channelTaskScopeMatches(rule, policy, event) && valueMatches(rule))
      )
  })
}

/** Model authority may still use a legacy command deny, but never a coarse allow as a field grant. */
export function channelTaskFields(patch: ChannelTaskPatch): readonly string[] {
  return Object.keys(patch).map(field =>
    field === 'providerId' ? 'provider' : field === 'model' ? 'model' : 'work-mode'
  )
}
