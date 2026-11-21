import { useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider } from 'tdesign-react'
import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import { HostDraftFields } from './host-ui/HostDraftFields.js'
import { HostFormPage, HostFormPageStack } from './host-ui/HostFormPages.js'
import { HOST_FORM_REACT_STYLES } from './host-ui/HostForm.js'
import { HOST_TDESIGN_REACT_STYLES } from './host-ui/tdesign-styles.js'
import { HostThemeProjection } from './host-theme.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { useStandaloneDraftWarning } from './host-ui/HostFormRevision.js'
import { channelCredentialFailure } from './channel-credential-fields.js'
import {
  channelConnectionFormFields,
  type ChannelConnectionFormValues,
  channelGroupMode,
  channelReceiveSelectors,
  validateChannelConnectionForm,
} from './channel-connection-form-fields.js'

export interface ChannelConnectionFormSnapshot {
  readonly displayName: string
  readonly selectors: readonly string[]
  readonly revision: number
  readonly serviceRevision: number
  readonly writable: boolean
  readonly credentialWritable: boolean
}

/** One Host-owned field shell, transient key and revision-fenced save/reset. */
export function ChannelConnectionForm(props: {
  readonly account: ChannelCredentialRef
  readonly initial: ChannelConnectionFormSnapshot
  readonly credentialsAvailable: boolean
  readonly externalStyles?: boolean
  readonly locale: string
  readonly signal: AbortSignal
  readonly read: () => Promise<ChannelConnectionFormSnapshot>
  readonly subscribe: (listener: () => void) => () => void
  readonly apply: (
    values: ChannelConnectionFormValues,
    baseline: ChannelConnectionFormSnapshot,
  ) => Promise<ChannelManagerFormOutcomeV1>
  readonly resolveTenant: (
    tenantId: string,
    baseline: ChannelConnectionFormSnapshot,
  ) => Promise<ChannelManagerFormOutcomeV1>
  readonly onResult: (result: ChannelManagerFormOutcomeV1) => void
}) {
  const zh = props.locale.startsWith('zh')
  const formValues = (snapshot: ChannelConnectionFormSnapshot): ChannelConnectionFormValues => ({
    appId: props.account.accountId,
    tenantId: props.account.tenantId,
    secret: '',
    displayName: snapshot.displayName,
    groupMode: channelGroupMode(snapshot.selectors),
  })
  const baseline = useRef(props.initial), baselineValues = useRef(formValues(props.initial))
  const values = useRef({ ...baselineValues.current }), submitting = useRef(false)
  const container = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [reset, setReset] = useState(0)
  const [reviewRequired, setReviewRequired] = useState(false)
  const [secretReset, setSecretReset] = useState(0)
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  useStandaloneDraftWarning(container, dirty)
  const updateDirty = () =>
    setDirty(
      values.current.tenantId !== baselineValues.current.tenantId
        || values.current.secret.length > 0
        || values.current.displayName !== baselineValues.current.displayName
        || values.current.groupMode !== baselineValues.current.groupMode,
    )
  const adopt = (snapshot: ChannelConnectionFormSnapshot, retain: boolean) => {
    const next = formValues(snapshot), prior = baselineValues.current
    const nameEdited = retain && values.current.displayName !== prior.displayName
    const modeEdited = retain && values.current.groupMode !== prior.groupMode
    const tenantEdited = retain && !props.account.tenantId && values.current.tenantId !== prior.tenantId
    const secret = retain && snapshot.credentialWritable ? values.current.secret : ''
    if (
      retain && (nameEdited || modeEdited || tenantEdited || values.current.secret.length > 0)
      && snapshot.serviceRevision !== baseline.current.serviceRevision
    ) setReviewRequired(true)
    if (!retain) setReviewRequired(false)
    values.current = {
      ...next,
      secret,
      ...(tenantEdited ? { tenantId: values.current.tenantId } : {}),
      ...(nameEdited ? { displayName: values.current.displayName } : {}),
      ...(modeEdited ? { groupMode: values.current.groupMode } : {}),
    }
    // Field initialValue is also its reset input; preserve edited controls during refresh.
    baseline.current = snapshot
    baselineValues.current = next
    setReset(n => n + 1)
    if (!retain || !snapshot.credentialWritable) setSecretReset(n => n + 1)
    updateDirty()
  }
  useEffect(() => {
    const theme = new HostThemeProjection(document),
      detach = container.current ? theme.attach(container.current) : () => {}
    let sequence = 0, disposed = false
    const clear = () => {
      values.current.secret = ''
    }
    const remove = props.subscribe(() => {
      if (disposed || submitting.current || props.signal.aborted) return
      const current = ++sequence
      void props.read().then(snapshot => {
        if (!disposed && !submitting.current && !props.signal.aborted && current === sequence) adopt(snapshot, true)
      }).catch(() => {})
    })
    props.signal.addEventListener('abort', clear, { once: true })
    return () => {
      disposed = true
      sequence += 1
      remove()
      clear()
      props.signal.removeEventListener('abort', clear)
      detach()
      theme.dispose()
    }
  }, [props.signal])
  const save = async () => {
    if (!dirty || reviewRequired || submitting.current || props.signal.aborted) return
    const invalid = validateChannelConnectionForm(values.current, zh)
    setErrors(invalid)
    if (invalid.size) return
    submitting.current = true
    setBusy(true)
    try {
      const result = await props.apply({ ...values.current }, baseline.current)
      if (props.signal.aborted) return
      if (result.status === 'applied') {
        if (!props.account.tenantId) {
          props.onResult(result)
          return
        }
        values.current.secret = ''
        // Only clear the draft after the entire transaction applied.
        const committed = {
          ...baseline.current,
          displayName: values.current.displayName.trim(),
          selectors: channelReceiveSelectors(values.current.groupMode),
        }
        adopt(committed, false)
        try {
          const snapshot = await props.read()
          if (!props.signal.aborted) adopt(snapshot, false)
        } catch { /* Applied remains a real receipt even if refresh is unavailable. */ }
      } else if (result.status === 'conflict') {
        setReviewRequired(true)
        try {
          const snapshot = await props.read()
          if (!props.signal.aborted) adopt(snapshot, true)
        } catch { /* Retain the form and fence until a supported read succeeds. */ }
      } else if (values.current.secret || !props.account.tenantId) {
        const failure = channelCredentialFailure(result.code, zh)
        setErrors(new Map([[!props.account.tenantId ? 'channel-tenantId' : failure.id, failure.message]]))
      }
      if (!props.signal.aborted) props.onResult(result)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'CONNECTION_CONFIGURATION_FAILED' })
    } finally {
      submitting.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const review = async () => {
    if (submitting.current || props.signal.aborted) return
    submitting.current = true
    setBusy(true)
    try {
      const snapshot = await props.read()
      if (props.signal.aborted) return
      adopt(snapshot, true)
      setReviewRequired(false)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'CONNECTION_CONFIGURATION_FAILED' })
    } finally {
      submitting.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const retryTenant = async () => {
    if (reviewRequired || submitting.current || props.signal.aborted) return
    submitting.current = true
    setBusy(true)
    try {
      const result = await props.resolveTenant('', baseline.current)
      if (props.signal.aborted) return
      if (result.status !== 'applied') {
        const failure = channelCredentialFailure(result.code, zh)
        setErrors(new Map([['channel-tenantId', failure.message]]))
      }
      props.onResult(result)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'TENANT_DISCOVERY_FAILED' })
    } finally {
      submitting.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const definitions = channelConnectionFormFields({
    account: props.account,
    values: values.current,
    baseline: baselineValues.current,
    credentialsAvailable: props.credentialsAvailable,
    zh,
    busy,
    writable: baseline.current.writable,
    credentialWritable: baseline.current.credentialWritable,
    change: (id, value) => {
      if (busy || submitting.current || props.signal.aborted) return
      if (id === 'groupMode') values.current.groupMode = value as ChannelConnectionFormValues['groupMode']
      else values.current[id] = value
      updateDirty()
      setErrors(current => {
        const next = new Map(current)
        next.delete(`channel-${id}`)
        return next
      })
    },
  }).filter(field => props.account.tenantId !== '' || ['channel-appId', 'channel-tenantId'].includes(field.id))
  return (
    <ConfigProvider notSet globalConfig={{ attach: () => container.current ?? document.body }}>
      <div ref={container} className="cxh-tdesign-root cxf-react-form" data-channel-connection-form="inline">
        {props.externalStyles ? null : <style>{HOST_TDESIGN_REACT_STYLES + HOST_FORM_REACT_STYLES}</style>}
        <form
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <HostFormPageStack resetKey={props.account.accountId}>
            <HostFormPage
              footer={
                <div className="cxf-form-actions">
                  <span className="cxf-status">
                    {reviewRequired
                      ? (zh
                        ? '配置已更新，草稿已保留。请核对最新配置后继续。'
                        : 'Configuration changed. Your draft was kept; review the latest values before saving.')
                      : !props.account.tenantId
                      ? (zh
                        ? '租户待识别；识别后连接才会启动。'
                        : 'Tenant identification is pending; the connection starts after identification.')
                      : ''}
                  </span>
                  <div className="cxf-form-action-buttons">
                    {reviewRequired && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void review()}
                      >
                        {zh ? '使用最新版本' : 'Use latest version'}
                      </Button>
                    )}
                    {!props.account.tenantId && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy || reviewRequired || !baseline.current.writable}
                        onClick={() => void retryTenant()}
                      >
                        {zh ? '重试自动查询' : 'Retry automatic lookup'}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      icon={<HostIcon token="action.reset" />}
                      disabled={!dirty || busy}
                      onClick={() => {
                        adopt(baseline.current, false)
                        setErrors(new Map())
                      }}
                    >
                      {zh ? '撤销修改' : 'Undo changes'}
                    </Button>
                    <Button
                      type="submit"
                      theme="primary"
                      icon={<HostIcon token="action.save" />}
                      loading={busy}
                      disabled={!dirty || busy || reviewRequired || !baseline.current.writable}
                    >
                      {!props.account.tenantId ? (zh ? '保存租户 ID' : 'Save tenant ID') : (zh ? '保存' : 'Save')}
                    </Button>
                  </div>
                </div>
              }
            >
              {!props.account.tenantId && (
                <p>
                  {zh
                    ? '自动查询需要在应用的权限管理中开通 tenant:tenant:readonly，发布并等待必要的审核。'
                    : 'For automatic lookup, enable tenant:tenant:readonly in application permissions, publish and wait for any required approval. '}
                  {' '}
                  <a
                    href={`https://${
                      props.account.adapterId === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
                    }/app/${encodeURIComponent(props.account.accountId)}/auth?q=tenant%3Atenant%3Areadonly`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {zh ? '打开应用权限管理' : 'Open application permissions'}
                  </a>
                </p>
              )}
              <HostDraftFields
                definitions={definitions}
                locale={props.locale}
                errors={errors}
                resetVersions={new Map(
                  definitions.map(field => [field.id, field.id === 'channel-secret' ? secretReset : reset]),
                )}
              />
            </HostFormPage>
          </HostFormPageStack>
        </form>
      </div>
    </ConfigProvider>
  )
}
