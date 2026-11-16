import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from 'tdesign-react'
import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelConversationPolicyV3 } from '@cordisx/protocol/channel-conversation-policy/v3'
import { HostSchemaFormPage } from './host-ui/SchemaForm.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { channelPolicyFormSchema, normalizeChannelPolicyForm } from './channel-policy-prompt.js'
import type { ChannelSettingsFormSectionV1 } from '@cordisx/protocol/channel-manager/v11'
import { ChannelSettingsDraft } from './channel-settings-draft.js'
import { parseChannelConversationPolicy } from '../launcher/channel-conversation-policy.js'
import {
  channelPolicyFieldIcons,
  channelPolicyFormValue,
  channelPolicySectionFields,
} from './channel-policy-form-model.js'

/** The same schema and normalization as the modal, with a persistent page draft. */
export function ChannelPolicyForm(props: {
  readonly policy: ChannelConversationPolicyV3
  readonly revision?: number
  readonly draft?: ChannelSettingsDraft
  readonly section?: Exclude<ChannelSettingsFormSectionV1, 'new-chats'>
  readonly workflowFields?: boolean
  readonly locale: string
  readonly signal: AbortSignal
  readonly save: (policy: unknown) => Promise<ChannelManagerFormOutcomeV1>
  readonly refresh: () => Promise<
    ChannelConversationPolicyV3 | { readonly policy: ChannelConversationPolicyV3; readonly revision: number }
  >
  readonly onResult: (result: ChannelManagerFormOutcomeV1) => void
}) {
  const zh = props.locale.startsWith('zh')
  const localDraft = useMemo(() => new ChannelSettingsDraft(), [])
  const draft = props.draft ?? localDraft
  draft.initialize(channelPolicyFormValue(props.policy, props.workflowFields === true), props.revision ?? 0)
  const { value, baseline, conflict, formRevision } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [busy, setBusy] = useState(false)
  const [valid, setValid] = useState(true)
  const schema = useMemo(() => channelPolicyFormSchema(zh, true, props.workflowFields === true, props.section), [
    zh,
    props.workflowFields,
    props.section,
  ])
  const submitting = useRef(false)
  const dirty = props.section === undefined
    ? JSON.stringify(value) !== JSON.stringify(baseline)
    : channelPolicySectionFields[props.section].some(key =>
      JSON.stringify(value[key]) !== JSON.stringify(baseline[key])
    )
  const save = async () => {
    if (!valid || !dirty || submitting.current || props.signal.aborted || conflict) return
    submitting.current = true
    setBusy(true)
    try {
      const normalized = normalizeChannelPolicyForm(value)
      const result = await props.save(normalized)
      if (props.signal.aborted) return
      if (result.status === 'applied') {
        if (!props.draft) {
          draft.commit(
            channelPolicyFormValue(parseChannelConversationPolicy(normalized), props.workflowFields === true),
            draft.snapshot().revision + 1,
          )
        }
      } else if (result.code === 'REVISION_CONFLICT') draft.markConflict()
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
      const readback = 'policy' in current ? current : { policy: current, revision: draft.snapshot().revision }
      draft.refresh(channelPolicyFormValue(readback.policy, props.workflowFields === true), readback.revision)
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
          schema,
          baseline,
          fieldIcons: channelPolicyFieldIcons,
          ...(props.section === undefined
            ? {}
            : {
              fieldPaths: channelPolicySectionFields[props.section].filter(field =>
                field !== 'sidebarGroup' || value.sidebarGrouping === 'custom'
              ),
            }),
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
                ? zh
                  ? '其他窗口已修改配置；重新读取后可继续保存本页修改。'
                  : 'Configuration changed in another window. Refresh before saving your retained draft.'
                : dirty
                ? zh ? '有未保存的修改' : 'Unsaved changes'
                : ''}
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
                disabled={!dirty || busy}
                onClick={() => {
                  if (props.section === undefined) draft.reset()
                  else draft.resetFields(channelPolicySectionFields[props.section])
                }}
              >
                {zh ? '撤销修改' : 'Undo changes'}
              </Button>
              <Button
                type="submit"
                theme="primary"
                icon={<HostIcon token="action.save" />}
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
