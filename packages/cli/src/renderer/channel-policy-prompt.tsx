import Schema from '@deepseek-ai/schemastery'
import type { SchemaFormSourceV1 } from '@cordisx/protocol/schema-form/v1'
import type { ChannelConversationPolicyV2 } from '@cordisx/protocol/channel-conversation-policy/v2'
import { createRoot } from 'react-dom/client'
import { dialogCenterForDocument } from './dialogs/host.js'
import { SchemaForm } from './host-ui/SchemaForm.js'

export function channelPolicyFormSchema(zh: boolean, replyFields = true, workflowFields = false): SchemaFormSourceV1 {
  const label = (en: string, cn: string) => ({ label: zh ? cn : en })
  const text = (en: string, cn: string) => Schema.string().extra('extra', label(en, cn))
  const scope = () => ({
    adapterId: text('Platform ID', '平台 ID'),
    accountId: text('Account ID', '账号 ID'),
    tenantId: text('Tenant ID', '租户 ID'),
    conversationId: text('Conversation ID', '频道会话 ID'),
  })
  const userIds = () => Schema.array(Schema.string()).extra('extra', label('User IDs', '用户 ID'))
  const replyMode = (agent: boolean) =>
    Schema.union([
      ...(agent ? [Schema.const('agent').extra('extra', label('Let Agent choose', '由 Agent 选择'))] : []),
      Schema.const('conversation').extra('extra', label('Conversation main stream', '会话主消息流')),
      Schema.const('reply').extra('extra', label('Quote the source message', '引用原消息回复')),
      Schema.const('thread').extra('extra', label('Reply in a topic', '在话题中回复')),
      Schema.const('none').extra('extra', label('Do not deliver', '不发送')),
    ])
  const result = Schema.object({
    enabled: Schema.boolean().role('switch').extra(
      'extra',
      label('Deliver addressed messages to Codex', '将定向消息交给 Codex'),
    ),
    autoCreate: Schema.boolean().role('switch').extra('extra', label('Create a chat when unbound', '未绑定时创建聊天')),
    autoReply: Schema.boolean().role('switch').default(false).description(
      zh
        ? '关闭时，Codex 对话内容留在本地，通过 Channel CLI 明确发送。开启后，最终回复按配置转发到绑定会话。'
        : 'When off, Codex conversation text stays local and messages require an explicit Channel CLI send. When on, final replies are forwarded to eligible bindings.',
    ).extra('extra', label('Automatically forward final replies (off by default)', '自动转发最终回复（默认关闭）')),
    ...(replyFields
      ? {
        replyMode: replyMode(true).required().extra('extra', label('Default reply mode', '默认回复方式')),
        replyFallbackMode: replyMode(false).required().extra(
          'extra',
          label('Fallback when Agent does not choose', 'Agent 未选择时的回复方式'),
        ),
        replyModes: Schema.array(Schema.object({
          ...scope(),
          kinds: Schema.array(Schema.union(['direct', 'group'])).extra(
            'extra',
            label('Conversation types', '会话类型'),
          ),
          mode: replyMode(true).required().extra('extra', label('Reply mode', '回复方式')),
          fallbackMode: replyMode(false).extra('extra', label('Fallback mode', '未选择时的回复方式')),
        })).extra('extra', label('Reply defaults by scope', '分范围回复方式')),
      }
      : {}),
    ...(workflowFields
      ? {
        sidebarGroup: Schema.union([
          Schema.const(null).extra('extra', label('Do not group automatically', '不自动分组')),
          Schema.string().extra('extra', label('Group name', '分组名称')),
        ]).description(
          zh
            ? '新建的频道对话分组；留空使用外部连接。'
            : 'Group for new Channel chats; leave empty for External connections.',
        ).extra('extra', label('Chat sidebar group', '对话侧栏分组')),
      }
      : {}),
    groupReception: Schema.union([
      Schema.const('mentions').extra('extra', label('Mentions only', '仅接收 @ 机器人')),
      Schema.const('all').extra('extra', label('Receive all; reply only when addressed', '接收全部；仅定向消息回复')),
    ])
      .extra('extra', label('Group reception', '群消息接收模式')),
    groups: Schema.array(
      Schema.object({
        id: text('Group ID', '用户组 ID').required(),
        name: text('Name', '名称').required(),
        members: Schema.array(Schema.object({ ...scope(), userId: text('User ID', '用户 ID').required() }))
          .extra('extra', label('Members', '成员')),
      }),
    ).extra('extra', label('User groups', '用户组')),
    rules: Schema.array(
      Schema.object({
        id: text('Rule ID', '规则 ID').required(),
        ...scope(),
        action: Schema.union(['dispatch', 'command', 'send']).required().extra('extra', label('Action', '操作')),
        effect: Schema.union(['allow', 'deny']).required().extra('extra', label('Allow / deny', '允许／拒绝')),
        kinds: Schema.array(Schema.union(['direct', 'group'])).extra('extra', label('Conversation types', '会话类型')),
        userIds: userIds(),
        userGroupIds: Schema.array(Schema.string()).extra('extra', label('User group IDs', '用户组 ID')),
        commands: Schema.array(Schema.string()).extra('extra', label('Commands', '指令')),
      }),
    ).extra('extra', label('Permission and message rules', '权限及消息规则')),
    wakePrefixes: Schema.array(
      Schema.object({
        ...scope(),
        prefixes: Schema.array(Schema.string()).required().extra('extra', label('Wake prefixes', '唤醒前缀')),
      }),
    ).extra('extra', label('Wake prefixes by scope', '分范围唤醒前缀')),
  })
  const validation = result['~standard']
  return {
    ...result,
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate: input => {
        const checked = validation.validate(input)
        if (checked instanceof Promise) throw new Error('ASYNC_SCHEMA_UNSUPPORTED')
        return checked.issues
          ? {
            issues: checked.issues.map(issue => ({
              message: issue.message,
              ...(issue.path ? { path: issue.path } : {}),
            })),
          }
          : { value: checked.value }
      },
    },
  }
}

/** Empty optional controls express an absent predicate; required prefix/user fields stay validated. */
export function normalizeChannelPolicyForm(value: Record<string, unknown>): Record<string, unknown> {
  const scope = (input: unknown): Record<string, unknown> => {
    const row = { ...(input as Record<string, unknown>) }
    for (const key of ['adapterId', 'accountId', 'tenantId', 'conversationId']) {
      if (row[key] === '') delete row[key]
    }
    return row
  }
  return {
    ...value,
    ...(value.sidebarGroup === '' ? { sidebarGroup: undefined } : {}),
    groups: (value.groups as unknown[] ?? []).map(input => {
      const row = scope(input)
      return { ...row, members: (row.members as unknown[] ?? []).map(scope) }
    }),
    rules: (value.rules as unknown[] ?? []).map(input => {
      const row = scope(input)
      for (const key of ['kinds', 'userIds', 'userGroupIds', 'commands']) {
        if (Array.isArray(row[key]) && !(row[key] as unknown[]).length) delete row[key]
      }
      return row
    }),
    wakePrefixes: (value.wakePrefixes as unknown[] ?? []).map(scope),
    replyModes: (value.replyModes as unknown[] ?? []).map(input => {
      const row = scope(input)
      if (Array.isArray(row.kinds) && !row.kinds.length) delete row.kinds
      if (row.fallbackMode === '') delete row.fallbackMode
      return row
    }),
  }
}

/** Uses the shared Host form, including its object-array item editor and modal chrome. */
export async function configureChannelPolicyPrompt(input: {
  readonly document: Document
  readonly owner: string
  readonly policy: ChannelConversationPolicyV2
  readonly replyFields?: boolean
  readonly signal: AbortSignal
  readonly save: (policy: unknown) => Promise<{ status: string; code: string }>
}): Promise<{ status: 'applied' | 'cancelled' | 'conflict' | 'rejected' | 'unavailable'; code: string }> {
  const center = dialogCenterForDocument(input.document)
  if (!center || input.signal.aborted) return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
  const zh = input.document.documentElement.lang.startsWith('zh')
  let value: Record<string, unknown> = structuredClone(input.policy) as unknown as Record<string, unknown>
  let valid = true, applied = false
  let final: { status: 'applied' | 'cancelled' | 'conflict' | 'rejected' | 'unavailable'; code: string } = {
    status: 'cancelled',
    code: 'CANCELLED',
  }
  const binding = center.bind({
    key: `host/channel-policy/${input.owner}`,
    name: () => 'CordisX',
    active: () => !input.signal.aborted,
    report: () => {},
  })
  const formSchema = channelPolicyFormSchema(zh, input.replyFields)
  const handle = binding.openBody({
    kind: 'channel.policy.configure',
    title: zh ? '频道消息与指令' : 'Channel messages and commands',
    closeOnBackdrop: false,
    description: zh
      ? '空范围应用于全部。全局与会话规则取交集；拒绝优先。接收全部群消息不会自动回复闲聊。'
      : 'Empty scopes apply globally. Global and conversation rules intersect; denies win. Receiving all group messages does not reply to unrelated chatter.',
  }, ({ container, dialog }) => {
    const seat = input.document.createElement('div')
    container.append(seat)
    const root = createRoot(seat)
    const render = () =>
      root.render(
        <SchemaForm
          identity="channel-conversation-policy"
          schema={formSchema}
          value={value}
          locale={zh ? 'zh-CN' : 'en'}
          onChange={next => {
            value = { ...value, ...next.value }
            valid = next.valid
          }}
          onValidationChange={next => {
            valid = next.valid
          }}
        />,
      )
    dialog.update({
      title: zh ? '频道消息与指令' : 'Channel messages and commands',
      footer: {
        secondaryActions: [{
          id: 'cancel',
          label: zh ? '取消' : 'Cancel',
          onAction: async () => {
            await dialog.close('cancel')
          },
        }],
        primaryAction: {
          id: 'save',
          label: zh ? '保存' : 'Save',
          onAction: async signal => {
            if (!valid || input.signal.aborted || signal.aborted) return
            const result = await input.save(normalizeChannelPolicyForm(value))
            if (result.status === 'applied') {
              applied = true
              final = { status: 'applied', code: result.code }
              await dialog.close('programmatic')
            } else if (['conflict', 'rejected', 'unavailable'].includes(result.status)) {
              final = { status: result.status as 'conflict' | 'rejected' | 'unavailable', code: result.code }
              await dialog.close('programmatic')
            }
          },
        },
      },
    })
    render()
    return () => {
      root.unmount()
      seat.remove()
    }
  })
  const abort = () => binding.dispose()
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    await handle.result
    return applied ? { status: 'applied', code: final.code } : final
  } finally {
    input.signal.removeEventListener('abort', abort)
    binding.dispose()
  }
}
