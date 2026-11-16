import { useRef, useState } from 'react'
import { Button } from 'tdesign-react'
import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelConversationPolicyV3 } from '@cordisx/protocol/channel-conversation-policy/v3'
import { HostSchemaFormPage } from './host-ui/SchemaForm.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { channelPolicyFormSchema, normalizeChannelPolicyForm } from './channel-policy-prompt.js'

/** The same schema and normalization as the modal, with a persistent page draft. */
export function ChannelPolicyForm(props: {
  readonly policy: ChannelConversationPolicyV3
  readonly workflowFields?: boolean
  readonly locale: string
  readonly signal: AbortSignal
  readonly save: (policy: unknown) => Promise<ChannelManagerFormOutcomeV1>
  readonly refresh: () => Promise<ChannelConversationPolicyV3>
  readonly onResult: (result: ChannelManagerFormOutcomeV1) => void
}) {
  const zh = props.locale.startsWith('zh')
  const [value, setValue] = useState(() => structuredClone(props.policy) as unknown as Record<string, unknown>)
  const [baseline, setBaseline] = useState(value)
  const [busy, setBusy] = useState(false)
  const [valid, setValid] = useState(true)
  const [formRevision, setFormRevision] = useState(0)
  const [conflict, setConflict] = useState(false)
  const schema = useRef(channelPolicyFormSchema(zh, true, props.workflowFields === true))
  const submitting = useRef(false)
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline)
  const save = async () => {
    if (!valid || !dirty || submitting.current || props.signal.aborted || conflict) return
    submitting.current = true
    setBusy(true)
    try {
      const normalized = normalizeChannelPolicyForm(value)
      const result = await props.save(normalized)
      if (props.signal.aborted) return
      if (result.status === 'applied') {
        setValue(normalized)
        setBaseline(normalized)
        setFormRevision(n => n + 1)
      } else if (result.code === 'REVISION_CONFLICT') setConflict(true)
      props.onResult(result)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'CHANNEL_POLICY_UNAVAILABLE' })
    } finally {
      submitting.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const refresh = async () => {
    if (submitting.current || props.signal.aborted) return
    submitting.current = true
    setBusy(true)
    try {
      const current = await props.refresh()
      if (props.signal.aborted) return
      const latest = structuredClone(current) as unknown as Record<string, unknown>
      const retained = structuredClone(latest)
      for (const key of new Set([...Object.keys(baseline), ...Object.keys(value)])) {
        if (JSON.stringify(value[key]) === JSON.stringify(baseline[key])) continue
        if (value[key] === undefined) delete retained[key]
        else retained[key] = structuredClone(value[key])
      }
      setValue(retained)
      setBaseline(latest)
      setConflict(false)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'CHANNEL_POLICY_UNAVAILABLE' })
    } finally {
      submitting.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  return (
    <form
      className="cxr-channel-policy-page"
      data-channel-policy-form="inline"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <HostSchemaFormPage
        form={{
          identity: `channel-conversation-policy-${formRevision}`,
          schema: schema.current,
          value,
          locale: props.locale,
          disabled: busy,
          onChange: next => {
            setValue(next.value)
            setValid(next.valid)
          },
          onValidationChange: next => setValid(next.valid),
        }}
        footer={
          <div className="cxf-form-actions">
            <span className="cxf-status" role="status">
              {conflict
                ? zh
                  ? '其他窗口已修改配置；重新读取后可继续保存本页修改。'
                  : 'Configuration changed in another window. Refresh before saving your retained draft.'
                : dirty
                ? zh ? '有未保存的修改' : 'Unsaved changes'
                : ''}
            </span>
            <div className="cxf-form-action-buttons">
              {conflict
                ? (
                  <Button
                    type="button"
                    variant="outline"
                    icon={<HostIcon token="refresh" />}
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    {zh ? '重新读取' : 'Refresh'}
                  </Button>
                )
                : null}
              <Button
                type="button"
                variant="outline"
                icon={<HostIcon token="reset" />}
                disabled={!dirty || busy}
                onClick={() => {
                  setValue(structuredClone(baseline))
                  setFormRevision(n => n + 1)
                }}
              >
                {zh ? '撤销修改' : 'Undo changes'}
              </Button>
              <Button
                type="submit"
                theme="primary"
                icon={<HostIcon token="save" />}
                loading={busy}
                disabled={!valid || !dirty || busy || conflict}
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
