import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Schema from '@deepseek-ai/schemastery'
import { Button, Tooltip } from 'tdesign-react'
import type { SchemaFormSourceV1 } from '@cordisx/protocol/schema-form/v1'
import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import { HostSchemaFormPage } from './host-ui/SchemaForm.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { ChannelSettingsDraft } from './channel-settings-draft.js'

export interface ContinuationDefaults {
  readonly revision: number
  readonly policy: { readonly enabled: boolean; readonly thresholdRatio: number }
}
const formValue = (value: ContinuationDefaults) => ({
  enabled: value.policy.enabled ? 'on' : 'off',
  percent: value.policy.thresholdRatio * 100,
})
function schema(zh: boolean): SchemaFormSourceV1 {
  const label = (value: Schema, text: string) => value.extra('extra', { label: text })
  const source = Schema.object({
    enabled: label(
      Schema.union([
        Schema.const('off').extra('extra', { label: zh ? '关闭' : 'Off' }),
        Schema.const('on').extra('extra', { label: zh ? '开启' : 'On' }),
      ]).role('radio'),
      zh ? '自动续接' : 'Automatic continuation',
    ),
    percent: label(
      Schema.number().min(Number.MIN_VALUE).max(95).required().description(
        zh
          ? '原生自动压缩预算的百分比；预算未知时不会触发。'
          : 'Percentage of the effective native compaction budget; no trigger when the budget is unknown.',
      ),
      zh ? '触发比例 (%)' : 'Threshold (%)',
    ),
  })
  const validation = source['~standard']
  return {
    ...source,
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate: input => {
        const result = validation.validate(input)
        if (result instanceof Promise) throw new Error('ASYNC_SCHEMA_UNSUPPORTED')
        return result.issues
          ? {
            issues: result.issues.map(issue => ({
              message: issue.message,
              ...(issue.path ? { path: issue.path } : {}),
            })),
          }
          : { value: result.value }
      },
    },
  }
}
export function ChannelContinuationDefaultsForm(props: {
  initial: ContinuationDefaults
  locale: string
  signal: AbortSignal
  read(): Promise<ContinuationDefaults>
  save(policy: ContinuationDefaults['policy'], revision: number): Promise<ContinuationDefaults>
  onResult(result: ChannelManagerFormOutcomeV1): void
}) {
  const zh = props.locale.startsWith('zh'), draft = useMemo(() => new ChannelSettingsDraft(), [])
  draft.initialize(formValue(props.initial), props.initial.revision)
  const { value, baseline, revision, conflict, formRevision } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [busy, setBusy] = useState(false), [valid, setValid] = useState(true)
  const lock = useRef(false), dirty = JSON.stringify(value) !== JSON.stringify(baseline)
  const source = useMemo(() => schema(zh), [zh])
  const run = async (save: boolean) => {
    const percent = value.percent
    const ratio = typeof percent === 'number' ? percent / 100 : NaN
    if (
      lock.current || props.signal.aborted
      || save
        && (!dirty || conflict || !valid || !Number.isFinite(ratio) || ratio <= 0 || ratio > .95)
    ) return
    lock.current = true
    setBusy(true)
    try {
      const latest = save
        ? await props.save({ enabled: value.enabled === 'on', thresholdRatio: ratio }, revision)
        : await props.read()
      if (props.signal.aborted) return
      if (save) {
        draft.commit(formValue(latest), latest.revision)
        props.onResult({ status: 'applied', code: 'SAVED' })
      } else draft.refresh(formValue(latest), latest.revision)
    } catch (error) {
      if (props.signal.aborted) return
      const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'CONTINUATION_DEFAULTS_UNAVAILABLE'
      if (code === 'REVISION_CONFLICT') draft.markConflict()
      props.onResult({ status: code === 'REVISION_CONFLICT' ? 'conflict' : 'rejected', code })
    } finally {
      lock.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const action = (
    label: string,
    icon: 'action.refresh' | 'action.reset' | 'action.save',
    disabled: boolean,
    click: () => void,
  ) => (
    <Tooltip content={label}>
      <Button
        type="button"
        shape="square"
        variant="text"
        aria-label={label}
        icon={<HostIcon token={icon} />}
        disabled={disabled}
        onClick={click}
      />
    </Tooltip>
  )
  return (
    <form
      data-channel-continuation-defaults="true"
      onSubmit={event => {
        event.preventDefault()
        void run(true)
      }}
    >
      <HostSchemaFormPage
        form={{
          identity: `channel-continuation-${formRevision}`,
          schema: source,
          value,
          baseline,
          locale: props.locale,
          disabled: busy,
          fieldIcons: { enabled: 'action.follow', percent: 'agent.reasoning' },
          choiceIcons: { enabled: { off: 'action.disable', on: 'action.enable' } },
          onChange: next => {
            draft.change(next.value)
            setValid(next.valid)
          },
          onValidationChange: next => setValid(next.valid),
        }}
        toolbar={
          <div className="cxf-form-actions">
            <span className="cxf-status" role="status">
              {conflict
                ? (zh ? '配置已变化，请重新读取。' : 'Settings changed. Refresh.')
                : dirty
                ? (zh ? '有未保存修改' : 'Unsaved changes')
                : ''}
            </span>
            <div className="cxf-form-action-buttons">
              {action(zh ? '读取' : 'Refresh', 'action.refresh', busy, () => void run(false))}
              {action(zh ? '撤销' : 'Undo', 'action.reset', busy || !dirty, () => draft.reset())}
              {action(zh ? '保存' : 'Save', 'action.save', busy || !dirty || !valid || conflict, () => void run(true))}
            </div>
          </div>
        }
        footer={null}
      />
    </form>
  )
}
