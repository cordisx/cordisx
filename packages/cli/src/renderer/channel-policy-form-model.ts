import type { ChannelConversationPolicyV3 } from '@cordisx/protocol/channel-conversation-policy/v3'
import type { ChannelSettingsFormSectionV1 } from '@cordisx/protocol/channel-manager/v11'
import type { SemanticIconKey } from '../icon-theme-contracts.js'

export type ChannelPolicyFormSection = Exclude<ChannelSettingsFormSectionV1, 'new-chats'>
export const channelPolicySectionFields = {
  messages: [
    'enabled',
    'autoCreate',
    'autoReply',
    'replyMode',
    'replyFallbackMode',
    'replyModes',
    'groupReception',
    'wakePrefixes',
  ],
  permissions: ['groups', 'rules'],
  organization: ['sidebarGrouping', 'sidebarGroup'],
} as const
export const channelPolicyFieldIcons = {
  enabled: 'action.submit',
  autoCreate: 'action.add',
  autoReply: 'action.share',
  replyMode: 'navigation.channels',
  replyFallbackMode: 'action.back',
  replyModes: 'content.layers',
  groupReception: 'navigation.overview',
  groups: 'content.panel',
  rules: 'content.key',
  wakePrefixes: 'content.tags',
  sidebarGrouping: 'content.folder',
  sidebarGroup: 'action.edit',
} as const satisfies Readonly<Record<string, SemanticIconKey>>

const replyChoiceIcons = {
  agent: 'agent.reasoning',
  conversation: 'navigation.channels',
  reply: 'action.back',
  thread: 'content.layers',
  none: 'action.disable',
} as const

export const channelPolicyChoiceIcons = {
  replyMode: replyChoiceIcons,
  replyFallbackMode: replyChoiceIcons,
  groupReception: { mentions: 'content.tags', all: 'navigation.overview' },
  sidebarGrouping: { inherit: 'content.folder', custom: 'action.edit', none: 'action.disable' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, SemanticIconKey>>>>

const replyChoiceLabels = {
  agent: '自主选择',
  conversation: '主消息流',
  reply: '引用回复',
  thread: '话题回复',
} as const

export const channelPolicyChoiceLabels = {
  replyMode: replyChoiceLabels,
  replyFallbackMode: replyChoiceLabels,
  groupReception: { mentions: '仅提及', all: '全部接收' },
  sidebarGrouping: { custom: '自定义', none: '不分组' },
  'replyModes.mode': replyChoiceLabels,
  'replyModes.fallbackMode': replyChoiceLabels,
  'rules.action': { dispatch: '交给模型' },
} as const

export function channelPolicyFormValue(
  policy: ChannelConversationPolicyV3,
  workflowFields: boolean,
): Record<string, unknown> {
  const value = structuredClone(policy) as unknown as Record<string, unknown>
  if (!workflowFields) return value
  return {
    ...value,
    sidebarGrouping: value.sidebarGroup === null
      ? 'none'
      : typeof value.sidebarGroup === 'string'
      ? 'custom'
      : 'inherit',
    sidebarGroup: typeof value.sidebarGroup === 'string' ? value.sidebarGroup : '',
  }
}

/** Read the latest complete policy, then update only fields represented by the current tab. */
export function mergeChannelPolicySection(
  latest: ChannelConversationPolicyV3,
  value: Record<string, unknown>,
  section: ChannelPolicyFormSection,
): Record<string, unknown> {
  const merged = structuredClone(latest) as unknown as Record<string, unknown>
  for (const key of channelPolicySectionFields[section]) {
    if (key === 'sidebarGrouping') continue
    if (value[key] === undefined) delete merged[key]
    else merged[key] = structuredClone(value[key])
  }
  return merged
}

export function channelPolicySectionChanged(
  latest: ChannelConversationPolicyV3,
  baseline: Readonly<Record<string, unknown>>,
  section: ChannelPolicyFormSection,
): boolean {
  const current = channelPolicyFormValue(latest, true)
  return channelPolicySectionFields[section].some(key => JSON.stringify(current[key]) !== JSON.stringify(baseline[key]))
}
