import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Schema from '@deepseek-ai/schemastery'
import { Button } from 'tdesign-react'
import type { SchemaFormSourceV1 } from '@cordisx/protocol/schema-form/v1'
import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import { HostSchemaFormPage } from './host-ui/SchemaForm.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { ChannelSettingsDraft } from './channel-settings-draft.js'
import {
  type ChannelTaskConfig,
  type ChannelTaskPatch,
  parseChannelTaskConfig,
  parseChannelTaskPatch,
} from '../launcher/channel-task-config.js'

export interface ChannelTaskFormReadback {
  revision: number
  config?: ChannelTaskConfig
  settings?: ChannelTaskPatch
  providers: readonly {
    providerId: string
    title: string
    models: readonly { id: string; label?: string; reasoningCapabilities?: { efforts: readonly string[] } }[]
  }[]
}
function taskSchema(
  readback: ChannelTaskFormReadback,
  zh: boolean,
  value: Readonly<Record<string, unknown>>,
): SchemaFormSourceV1 {
  const label = (schema: Schema, cn: string, en: string) => schema.extra('extra', { label: zh ? cn : en })
  const choice = (value: string, name: string) => Schema.const(value).extra('extra', { label: name })
  const providers = readback.providers
  const effortValues = [
    'inherit',
    ...new Set(
      providers.flatMap(provider => provider.models.flatMap(model => model.reasoningCapabilities?.efforts ?? [])),
    ),
  ]
  const effortLabel = (effort: string) =>
    zh
      ? ({
        inherit: '继承',
        none: '关闭',
        minimal: '最低',
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '更高',
        max: '最高',
        ultra: '极高',
      } as Record<string, string>)[effort] ?? effort
      : effort
  const modelFields = (selection: Record<string, unknown>, inherited: boolean) => {
    const provider = providers.find(provider => provider.providerId === selection.providerId)
    const models = provider?.models ?? []
    const selected = models.find(model => model.id === selection.model)
    const efforts = selected?.reasoningCapabilities?.efforts ?? (inherited && !selected ? effortValues.slice(1) : [])
    const union = (choices: Schema[]) =>
      Schema.union(choices.length ? choices : [choice('', zh ? '无可用项' : 'Unavailable')])
    return {
      providerId: label(
        union([
          ...(inherited ? [choice('', zh ? '继承' : 'Inherit')] : []),
          ...providers.map(provider => choice(provider.providerId, provider.title)),
        ]),
        '服务商',
        'Provider',
      ),
      model: label(
        union([
          ...(inherited ? [choice('', zh ? '继承' : 'Inherit')] : []),
          ...models.map(model => choice(model.id, model.label ?? model.id)),
        ]),
        '模型',
        'Model',
      ),
      effort: label(
        union([
          choice('inherit', zh ? '继承' : 'Inherit'),
          ...efforts.map(effort =>
            choice(
              effort,
              effortLabel(effort),
            )
          ),
        ]).role('radio'),
        '思考强度',
        'Effort',
      ),
    }
  }
  const selector = {
    adapterId: label(Schema.string(), '平台', 'Platform'),
    accountId: label(Schema.string(), '账号', 'Account'),
    tenantId: label(Schema.string(), '企业', 'Tenant'),
    conversationId: label(Schema.string(), '频道对话', 'Conversation'),
    userIds: label(Schema.array(Schema.string()), '用户名单', 'Users'),
    userGroupIds: label(Schema.array(Schema.string()), '用户组', 'User groups'),
    kinds: label(
      Schema.array(
        Schema.union([choice('direct', zh ? '私聊' : 'Direct'), choice('group', zh ? '群聊' : 'Group')]).role('radio'),
      ),
      '对话类型',
      'Chat types',
    ),
  }
  const result = Schema.object(
    readback.config
      ? {
        defaults: label(
          Schema.object(modelFields((value.defaults ?? {}) as Record<string, unknown>, true)),
          '新建默认',
          'Creation defaults',
        ),
        scopes: label(
          Schema.array(
            Schema.object({
              id: label(Schema.string().required(), '规则名称', 'Rule name'),
              ...selector,
              settings: label(
                Schema.object({
                  providerId: label(
                    Schema.union([
                      choice('', zh ? '继承' : 'Inherit'),
                      ...providers.map(provider => choice(provider.providerId, provider.title)),
                    ]),
                    '服务商',
                    'Provider',
                  ),
                  model: label(
                    Schema.union([
                      choice('', zh ? '继承' : 'Inherit'),
                      ...[
                        ...new Map(
                          providers.flatMap(provider =>
                            provider.models.map(model => [model.id, choice(model.id, model.label ?? model.id)] as const)
                          ),
                        ).values(),
                      ],
                    ]),
                    '模型',
                    'Model',
                  ),
                  effort: label(
                    Schema.union(effortValues.map(effort => choice(effort, effortLabel(effort)))).role('radio'),
                    '思考强度',
                    'Effort',
                  ),
                }),
                '任务参数',
                'Task settings',
              ),
            }),
          ),
          '群与用户默认',
          'Scoped defaults',
        ),
        permissions: label(
          Schema.array(
            Schema.object({
              id: label(Schema.string().required(), '规则名称', 'Rule name'),
              ...selector,
              effect: label(
                Schema.union([choice('allow', zh ? '允许' : 'Allow'), choice('deny', zh ? '禁止' : 'Deny')]).role(
                  'radio',
                ),
                '处理方式',
                'Effect',
              ),
              fields: label(
                Schema.array(
                  Schema.union([
                    choice('providerId', zh ? '服务商' : 'Provider'),
                    choice('model', zh ? '模型' : 'Model'),
                    choice('effort', zh ? '强度' : 'Effort'),
                  ]),
                ),
                '可改字段',
                'Fields',
              ),
              providerIds: label(Schema.array(Schema.string()), '服务商范围', 'Providers'),
              models: label(
                Schema.array(
                  Schema.object({
                    providerId: label(Schema.string().required(), '服务商', 'Provider'),
                    model: label(Schema.string().required(), '模型', 'Model'),
                  }),
                ),
                '模型范围',
                'Qualified models',
              ),
              efforts: label(
                Schema.array(
                  Schema.union(
                    ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort =>
                      choice(effort, effortLabel(effort))
                    ),
                  ).role('radio'),
                ),
                '强度范围',
                'Efforts',
              ),
            }),
          ).description(
            zh
              ? '查询默认可用；修改必须命中允许规则。禁止优先，平台、用户组、字段和模型约束取交集。空列表表示该维度不限。'
              : 'Reads are available; writes require an allow rule. Deny wins and scope, actor, field and value constraints intersect. Empty selectors mean unrestricted.',
          ),
          '模型权限',
          'Model permissions',
        ),
      }
      : modelFields(value as Record<string, unknown>, false),
  )
  const validation = result['~standard']
  return {
    ...result,
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate: input => {
        const value = validation.validate(input)
        if (value instanceof Promise) throw new Error('ASYNC_SCHEMA_UNSUPPORTED')
        return value.issues
          ? {
            issues: value.issues.map(issue => ({
              message: issue.message,
              ...(issue.path ? { path: issue.path } : {}),
            })),
          }
          : { value: value.value }
      },
    },
  }
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean)
  if (!value || typeof value !== 'object') return value === '' ? undefined : value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, value]) =>
      clean(value) === undefined || Array.isArray(value) && !value.length && !['scopes', 'permissions'].includes(key)
        ? []
        : [[key, clean(value)]]
    ),
  )
}
const formValue = (value: ChannelTaskFormReadback) =>
  ({ ...(value.config ?? value.settings ?? {}) }) as Record<string, unknown>
export function ChannelTaskSettingsForm(props: {
  initial: ChannelTaskFormReadback
  locale: string
  draft?: ChannelSettingsDraft
  signal: AbortSignal
  read(): Promise<ChannelTaskFormReadback>
  save(value: ChannelTaskConfig | ChannelTaskPatch, revision: number): Promise<ChannelTaskFormReadback>
  onResult(result: ChannelManagerFormOutcomeV1): void
}) {
  const zh = props.locale.startsWith('zh'),
    draft = useMemo(() => props.draft ?? new ChannelSettingsDraft(), [props.draft])
  draft.initialize(formValue(props.initial), props.initial.revision)
  const { value, baseline, revision, conflict, formRevision } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [readback, setReadback] = useState(props.initial),
    [busy, setBusy] = useState(false),
    [valid, setValid] = useState(true)
  const lock = useRef(false), dirty = JSON.stringify(value) !== JSON.stringify(baseline)
  const source = useMemo(() => taskSchema(readback, zh, value), [readback, zh, value])
  const run = async (save: boolean) => {
    if (lock.current || props.signal.aborted || save && (!valid || !dirty || conflict)) return
    lock.current = true
    setBusy(true)
    try {
      const normalized = clean(value)
      const payload = save
        ? props.initial.config ? parseChannelTaskConfig(normalized) : parseChannelTaskPatch(normalized)
        : undefined
      const latest = save ? await props.save(payload!, revision) : await props.read()
      if (props.signal.aborted) return
      setReadback(latest)
      if (save) {
        draft.commit(formValue(latest), latest.revision)
        props.onResult({ status: 'applied', code: 'SAVED' })
      } else draft.refresh(formValue(latest), latest.revision)
    } catch (error) {
      if (props.signal.aborted) return
      const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'TASK_SETTINGS_UNAVAILABLE'
      if (code === 'REVISION_CONFLICT') draft.markConflict()
      props.onResult({ status: code === 'REVISION_CONFLICT' ? 'conflict' : 'rejected', code })
    } finally {
      lock.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  return (
    <form
      className="cxr-channel-execution-form"
      data-channel-task-form={props.initial.config ? 'defaults' : 'chat'}
      onSubmit={event => {
        event.preventDefault()
        void run(true)
      }}
    >
      <HostSchemaFormPage
        form={{
          identity: `channel-task-${formRevision}`,
          schema: source,
          baseline,
          value,
          locale: props.locale,
          disabled: busy,
          fieldIcons: {
            defaults: 'action.add',
            providerId: 'navigation.routes',
            model: 'agent.turn-control',
            effort: 'agent.reasoning',
            scopes: 'content.tags',
            permissions: 'content.key',
          },
          choiceIcons: {
            effort: {
              inherit: 'action.follow',
              low: 'status.pending',
              medium: 'agent.reasoning',
              high: 'action.submit',
              max: 'action.enable',
            },
            'permissions.effect': { allow: 'action.enable', deny: 'action.disable' },
          },
          onChange: next => {
            const candidate = structuredClone(next.value) as Record<string, unknown>
            const previous = value as Record<string, unknown>
            const normalizeSelection = (
              selection: Record<string, unknown>,
              before: Record<string, unknown>,
              inherited: boolean,
            ) => {
              const providerChanged = selection.providerId !== before.providerId
              if (!providerChanged && selection.model === before.model) return
              const provider = readback.providers.find(provider => provider.providerId === selection.providerId)
              if (providerChanged && !provider?.models.some(model => model.id === selection.model)) {
                selection.model = inherited ? '' : provider?.models[0]?.id ?? ''
              }
              const model = provider?.models.find(model => model.id === selection.model)
              if (
                selection.effort !== undefined && selection.effort !== 'inherit' && (providerChanged || model)
                && !model?.reasoningCapabilities?.efforts.includes(String(selection.effort))
              ) {
                selection.effort = 'inherit'
              }
            }
            if (readback.config) {
              normalizeSelection(
                (candidate.defaults ?? {}) as Record<string, unknown>,
                (previous.defaults ?? {}) as Record<string, unknown>,
                true,
              )
              const beforeScopes = (previous.scopes ?? []) as { id?: string; settings?: Record<string, unknown> }[]
              for (const row of (candidate.scopes ?? []) as { id?: string; settings?: Record<string, unknown> }[]) {
                if (row.settings) {
                  normalizeSelection(
                    row.settings,
                    beforeScopes.find(before => before.id === row.id)?.settings ?? {},
                    true,
                  )
                }
              }
            } else normalizeSelection(candidate, previous, false)
            draft.change(candidate)
            setValid(next.valid)
          },
          onValidationChange: snapshot => setValid(snapshot.valid),
        }}
        footer={
          <div className="cxf-form-actions">
            <span className="cxf-status" role="status">
              {conflict
                ? zh ? '配置已变化，请重新读取。' : 'Settings changed. Refresh.'
                : dirty
                ? zh ? '有未保存修改' : 'Unsaved changes'
                : zh
                ? '对话空闲后应用。'
                : 'Applies while idle.'}
            </span>
            <div className="cxf-form-action-buttons">
              <Button
                type="button"
                variant="outline"
                icon={<HostIcon token="action.refresh" />}
                disabled={busy}
                onClick={() => void run(false)}
              >
                {zh ? '重新读取' : 'Refresh'}
              </Button>
              <Button
                type="button"
                variant="outline"
                icon={<HostIcon token="action.reset" />}
                disabled={busy || !dirty}
                onClick={() => draft.reset()}
              >
                {zh ? '撤销修改' : 'Undo'}
              </Button>
              <Button
                type="submit"
                theme="primary"
                icon={<HostIcon token="action.save" />}
                loading={busy}
                disabled={busy || !dirty || !valid || conflict}
              >
                {zh ? '保存' : 'Save'}
              </Button>
            </div>
          </div>
        }
      />
    </form>
  )
}
