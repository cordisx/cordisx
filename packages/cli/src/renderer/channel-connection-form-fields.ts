import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import type { ChannelManagerSelectorV2 } from '@cordisx/protocol/channel-manager/v2'
import type { HostDraftFieldDefinition } from './host-ui/HostDraftFields.js'
import { channelCredentialFields, validateChannelCredentialValues } from './channel-credential-fields.js'

export interface ChannelConnectionFormValues {
  appId: string
  tenantId: string
  secret: string
  displayName: string
  groupMode: 'none' | 'mentions' | 'all'
}

export const channelGroupMode = (selectors: readonly string[]): ChannelConnectionFormValues['groupMode'] =>
  selectors.includes('group') ? 'all' : selectors.includes('mentions') ? 'mentions' : 'none'

export const channelReceiveSelectors = (
  mode: ChannelConnectionFormValues['groupMode'],
): readonly ChannelManagerSelectorV2[] =>
  mode === 'all' ? ['direct', 'group'] : mode === 'mentions' ? ['direct', 'mentions'] : ['direct']

export function channelConnectionFormFields(input: {
  readonly account: ChannelCredentialRef
  readonly values: ChannelConnectionFormValues
  readonly baseline: ChannelConnectionFormValues
  readonly zh: boolean
  readonly busy: boolean
  readonly writable: boolean
  readonly credentialWritable: boolean
  readonly credentialsAvailable: boolean
  readonly change: (id: keyof ChannelConnectionFormValues, value: string) => void
}): HostDraftFieldDefinition[] {
  const common = { namespace: 'channel', disabled: input.busy || !input.writable, required: true }
  return [
    ...(input.credentialsAvailable
      ? channelCredentialFields({
        account: input.account,
        values: input.values,
        zh: input.zh,
        busy: input.busy || !(input.account.tenantId ? input.credentialWritable : input.writable),
        optionalSecret: true,
        change: input.change,
      })
      : []),
    {
      id: 'channel-displayName',
      controlId: 'channel-connection-displayName',
      initialValue: input.baseline.displayName,
      resetValue: input.values.displayName,
      fieldActions: 'static',
      field: {
        ...common,
        path: ['displayName'],
        type: 'string',
        role: 'text',
        value: input.values.displayName,
        label: input.zh ? '显示名称' : 'Display name',
      },
      onChange: value => input.change('displayName', typeof value === 'string' ? value : ''),
    },
    {
      id: 'channel-groupMode',
      controlId: 'channel-connection-groupMode',
      initialValue: input.baseline.groupMode,
      resetValue: input.values.groupMode,
      fieldActions: 'static',
      field: {
        ...common,
        path: ['groupMode'],
        type: 'union',
        value: input.values.groupMode,
        label: input.zh ? '接收群消息' : 'Group reception',
        description: input.zh
          ? '可保存全部群消息；自动回复仍需 @ 机器人或匹配唤醒词。'
          : 'All group messages can be stored; replies still require a bot mention or a wake prefix.',
        choices: [
          { value: 'none', label: input.zh ? '仅私聊' : 'Direct messages only' },
          { value: 'mentions', label: input.zh ? '私聊与 @ 机器人消息' : 'Direct messages and bot mentions' },
          { value: 'all', label: input.zh ? '私聊和全部群消息' : 'Direct and all group messages' },
        ],
      },
      onChange: value => input.change('groupMode', String(value)),
    },
  ]
}

export function validateChannelConnectionForm(values: ChannelConnectionFormValues, zh: boolean): Map<string, string> {
  const errors = values.secret ? validateChannelCredentialValues(values, zh) : new Map<string, string>()
  if (!values.displayName.trim() || values.displayName.length > 240 || /[\u0000-\u001f]/u.test(values.displayName)) {
    errors.set(
      'channel-displayName',
      zh ? '请输入有效的显示名称（最多 240 个字符）' : 'Enter a valid name (up to 240 characters)',
    )
  }
  if (!['none', 'mentions', 'all'].includes(values.groupMode)) {
    errors.set('channel-groupMode', zh ? '请选择接收范围' : 'Select a reception mode')
  }
  return errors
}
