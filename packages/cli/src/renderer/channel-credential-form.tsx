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
import {
  channelCredentialFailure,
  channelCredentialFields,
  validateChannelCredentialValues,
} from './channel-credential-fields.js'

/** Inline Host fields. Stored secret bytes never enter this form. */
export function ChannelCredentialForm(props: {
  readonly account: ChannelCredentialRef
  readonly locale: string
  readonly signal: AbortSignal
  readonly apply: (secret: string) => Promise<ChannelManagerFormOutcomeV1>
  readonly onResult: (result: ChannelManagerFormOutcomeV1) => void
}) {
  const zh = props.locale.startsWith('zh')
  const values = useRef({ appId: props.account.accountId, tenantId: props.account.tenantId, secret: '' })
  const container = useRef<HTMLDivElement>(null)
  const submitting = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [reset, setReset] = useState(0)
  useEffect(() => {
    const theme = new HostThemeProjection(document)
    const detach = container.current ? theme.attach(container.current) : () => {}
    const clear = () => {
      values.current.secret = ''
    }
    props.signal.addEventListener('abort', clear, { once: true })
    return () => {
      clear()
      props.signal.removeEventListener('abort', clear)
      detach()
      theme.dispose()
    }
  }, [props.signal])
  const clear = () => {
    values.current.secret = ''
    setReset(value => value + 1)
    setDirty(false)
    setErrors(new Map())
  }
  const save = async () => {
    if (submitting.current || props.signal.aborted) return
    const errors = validateChannelCredentialValues(values.current, zh)
    setErrors(errors)
    if (errors.size) return
    submitting.current = true
    setBusy(true)
    try {
      const result = await props.apply(values.current.secret)
      if (props.signal.aborted) return
      if (result.status === 'applied') clear()
      else {
        const failure = channelCredentialFailure(result.code, zh)
        setErrors(new Map([[failure.id, failure.message]]))
      }
      props.onResult(result)
    } catch {
      if (!props.signal.aborted) props.onResult({ status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' })
    } finally {
      submitting.current = false
      if (!props.signal.aborted) setBusy(false)
    }
  }
  const definitions = channelCredentialFields({
    account: props.account,
    values: values.current,
    zh,
    busy,
    change: (id, value) => {
      values.current[id] = value
      setDirty(values.current.secret.length > 0)
      setErrors(current => {
        const next = new Map(current)
        next.delete(`channel-${id}`)
        return next
      })
    },
  })
  return (
    <ConfigProvider notSet globalConfig={{ attach: () => container.current ?? document.body }}>
      <div ref={container} className="cxh-tdesign-root cxf-react-form" data-channel-credential-form="inline">
        <style>{HOST_TDESIGN_REACT_STYLES + HOST_FORM_REACT_STYLES}</style>
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
                  <span className="cxf-status">{zh ? '填写新的密钥后保存' : 'Enter a new secret to save'}</span>
                  <div className="cxf-form-action-buttons">
                    <Button
                      type="button"
                      variant="outline"
                      icon={<HostIcon token="action.reset" />}
                      disabled={!dirty || busy}
                      onClick={clear}
                    >
                      {zh ? '撤销修改' : 'Undo changes'}
                    </Button>
                    <Button
                      type="submit"
                      theme="primary"
                      icon={<HostIcon token="action.save" />}
                      loading={busy}
                      disabled={!dirty || busy}
                    >
                      {zh ? '保存凭据' : 'Save credentials'}
                    </Button>
                  </div>
                </div>
              }
            >
              <HostDraftFields
                definitions={definitions}
                locale={props.locale}
                errors={errors}
                resetVersions={new Map([['channel-secret', reset]])}
              />
            </HostFormPage>
          </HostFormPageStack>
        </form>
      </div>
    </ConfigProvider>
  )
}
