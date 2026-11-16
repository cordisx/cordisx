import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Schema from '@deepseek-ai/schemastery'
import { Button } from 'tdesign-react'
import type { ChatExecutionReadbackV1, ChatExecutionSettingsV1 } from '@cordisx/protocol/chat-execution-settings/v1'
import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import type { SchemaFormSourceV1 } from '@cordisx/protocol/schema-form/v1'
import { parseChatExecutionSettings } from '../chat-execution-settings.js'
import { HostSchemaFormPage } from './host-ui/SchemaForm.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { ChannelSettingsDraft } from './channel-settings-draft.js'

const fieldIcons = {
  execution: 'content.key',
  approval: 'control.check',
  workMode: 'agent.turn-control',
  effort: 'agent.reasoning',
  network: 'navigation.routes',
} as const

function schema(zh: boolean): SchemaFormSourceV1 {
  const choice = (value: string, en: string, cn: string) => Schema.const(value).extra('extra', { label: zh ? cn : en })
  const result = Schema.object({
    execution: Schema.union([
      choice('inherit', 'Inherit', '继承'),
      choice('read-only', 'Read only', '只读'),
      choice('workspace-write', 'Workspace write', '工作区可写'),
      choice('full-access', 'Full access', '完整访问'),
    ]).role('radio').extra('extra', { label: zh ? '执行权限' : 'Execution permissions' }),
    approval: Schema.union([
      choice('inherit', 'Inherit', '继承'),
      choice('untrusted', 'Ask for untrusted commands', '不可信命令时询问'),
      choice('on-request', 'Ask when needed', '需要时询问'),
      choice('never', 'Never ask', '不询问'),
    ]).description(
      zh
        ? '审批策略与执行范围分别设置；不询问不会扩大执行权限。'
        : 'Approval is separate from execution scope. Never ask does not grant full access.',
    ).role('radio').extra('extra', { label: zh ? '审批策略' : 'Approval policy' }),
    workMode: Schema.union([
      choice('inherit', 'Inherit', '继承'),
      choice('default', 'Execute', '执行'),
      choice('plan', 'Plan', '规划'),
    ]).role('radio').extra('extra', { label: zh ? '工作模式' : 'Work mode' }),
    effort: Schema.string().pattern(/^[a-z][a-z0-9-]{0,31}$/u).description(
      zh
        ? 'inherit 或当前模型支持的强度，如 low、medium、high、max。'
        : 'inherit or an effort supported by the current model, such as low, medium, high or max.',
    ).extra('extra', { label: zh ? '思考强度' : 'Reasoning effort' }),
    network: Schema.union([
      choice('inherit', 'Inherit', '继承'),
      choice('allow', 'Allow', '允许'),
      choice('deny', 'Deny', '禁止'),
    ]).role('radio').extra('extra', { label: zh ? '网络访问' : 'Network access' }),
  })
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
              ...(issue.path === undefined ? {} : { path: issue.path }),
            })),
          }
          : { value: value.value }
      },
    },
  }
}
const formValue = (settings: ChatExecutionSettingsV1): Record<string, unknown> => ({
  execution: settings.execution ?? 'inherit',
  approval: settings.approval ?? 'inherit',
  workMode: settings.workMode ?? 'inherit',
  effort: settings.effort ?? 'inherit',
  network: settings.networkAccess === undefined ? 'inherit' : settings.networkAccess ? 'allow' : 'deny',
})
const toSettings = (value: Record<string, unknown>) =>
  parseChatExecutionSettings({
    execution: value.execution,
    approval: value.approval,
    workMode: value.workMode,
    effort: value.effort,
    ...(value.network === 'inherit' ? {} : { networkAccess: value.network === 'allow' }),
  })

/** Shared Host form for ordinary profile defaults and individual native chats. */
export function ChatExecutionForm(props: {
  readonly initial: ChatExecutionReadbackV1
  readonly draft?: ChannelSettingsDraft
  readonly locale: string
  readonly signal: AbortSignal
  readonly read: () => Promise<ChatExecutionReadbackV1>
  readonly save: (settings: ChatExecutionSettingsV1, revision: number) => Promise<ChatExecutionReadbackV1>
  readonly onResult: (result: ChannelManagerFormOutcomeV1) => void
}) {
  const zh = props.locale.startsWith('zh')
  const localDraft = useMemo(() => new ChannelSettingsDraft(), [])
  const draft = props.draft ?? localDraft
  draft.initialize(formValue(props.initial.settings), props.initial.revision)
  const { value, baseline, revision, conflict, formRevision } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [readback, setReadback] = useState(props.initial)
  const [valid, setValid] = useState(true)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const source = useMemo(() => schema(zh), [zh])
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline)
  const apply = async () => {
    if (lock.current || props.signal.aborted || !valid || !dirty || conflict) return
    lock.current = true
    setBusy(true)
    try {
      const latest = await props.save(toSettings(value), revision)
      if (props.signal.aborted) return
      const next = formValue(latest.settings)
      setReadback(latest)
      draft.commit(next, latest.revision)
      props.onResult({ status: 'applied', code: 'SAVED' })
    } catch (error) {
      if (props.signal.aborted) return
      const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'EXECUTION_SETTINGS_UNAVAILABLE'
      if (code === 'REVISION_CONFLICT') draft.markConflict()
      props.onResult({ status: code === 'REVISION_CONFLICT' ? 'conflict' : 'rejected', code })
    } finally {
      lock.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const refresh = async () => {
    if (lock.current || props.signal.aborted) return
    lock.current = true
    setBusy(true)
    try {
      const latest = await props.read()
      if (props.signal.aborted) return
      setReadback(latest)
      draft.refresh(formValue(latest.settings), latest.revision)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'EXECUTION_SETTINGS_UNAVAILABLE' })
    } finally {
      lock.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  return (
    <form
      className="cxr-channel-execution-form"
      data-chat-execution-form={props.initial.scope}
      onSubmit={event => {
        event.preventDefault()
        void apply()
      }}
    >
      <HostSchemaFormPage
        form={{
          identity: `chat-execution-${formRevision}`,
          schema: source,
          baseline,
          fieldIcons,
          value,
          locale: props.locale,
          disabled: busy,
          onChange: next => {
            draft.change(next.value)
            setValid(next.valid)
          },
          onValidationChange: next => setValid(next.valid),
        }}
        footer={
          <div className="cxf-form-actions">
            <span className="cxf-status" role="status">
              {conflict
                ? zh ? '配置已变化；重新读取后保留本页修改。' : 'Settings changed. Refresh to retain this draft.'
                : dirty
                ? zh ? '有未保存的修改' : 'Unsaved changes'
                : readback.scope === 'creation-defaults'
                ? zh ? '只对新创建的对话生效。' : 'Applies to newly created chats.'
                : readback.application === 'applied'
                ? zh ? '原生已确认配置。' : 'Native settings confirmed.'
                : zh
                ? '下一 turn 应用；当前待审批请求单独处理。'
                : 'Applies on the next turn; pending approvals are separate.'}
            </span>
            <div className="cxf-form-action-buttons">
              <Button
                type="button"
                variant="outline"
                icon={<HostIcon token="action.refresh" />}
                disabled={busy}
                onClick={() => void refresh()}
              >
                {zh ? '重新读取' : 'Refresh'}
              </Button>
              <Button
                type="button"
                variant="outline"
                icon={<HostIcon token="action.reset" />}
                disabled={busy || !dirty}
                onClick={() => {
                  draft.reset()
                }}
              >
                {zh ? '撤销修改' : 'Undo changes'}
              </Button>
              <Button
                type="submit"
                theme="primary"
                icon={<HostIcon token="action.save" />}
                loading={busy}
                disabled={busy || !valid || !dirty || conflict}
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
