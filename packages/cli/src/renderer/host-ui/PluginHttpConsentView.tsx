import { type FormEvent, useLayoutEffect, useRef } from 'react'
import { Button, ConfigProvider, Input, type InputRef } from 'tdesign-react'
import { PERMISSION_AUTHORIZATION_STYLES } from '../permission-authorization-styles.js'
import { PLUGIN_HTTP_CONSENT_STYLES } from '../plugin-http-consent-styles.js'
import { HostIcon } from './HostIcon.js'
import { HOST_TDESIGN_REACT_STYLES } from './tdesign-styles.js'

export interface PluginHttpConsentCopy {
  readonly heading: string
  readonly description: string
  readonly pluginLabel: string
  readonly serverLabel: string
  readonly tokenLabel: string
  readonly tokenHint: string
  readonly cancel: string
  readonly allow: string
}

export function PluginHttpConsentView({
  overlay,
  headingId,
  descriptionId,
  pluginId,
  origin,
  credential,
  copy,
  finish,
}: {
  readonly overlay: HTMLElement
  readonly headingId: string
  readonly descriptionId: string
  readonly pluginId: string
  readonly origin: string
  readonly credential: 'none' | 'bearer'
  readonly copy: PluginHttpConsentCopy
  readonly finish: (
    result: { readonly approved: false } | { readonly approved: true; readonly secret?: string },
  ) => void
}) {
  const secretInput = useRef<InputRef>(null)
  useLayoutEffect(() => {
    const input = secretInput.current?.inputElement
    input?.setAttribute('maxlength', '16384')
    if (credential === 'bearer') input?.setAttribute('required', '')
  }, [credential])
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const secret = secretInput.current?.inputElement.value ?? ''
    if (credential === 'bearer' && secret.length === 0) return
    finish(credential === 'bearer' ? { approved: true, secret } : { approved: true })
  }
  return (
    <ConfigProvider globalConfig={{ attach: () => overlay }}>
      <style data-plugin-http-consent-components="true">{HOST_TDESIGN_REACT_STYLES}</style>
      <style data-plugin-http-consent-style="true">
        {PERMISSION_AUTHORIZATION_STYLES}
        {PLUGIN_HTTP_CONSENT_STYLES}
      </style>
      <form
        className="cxp-dialog cxp-http-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onSubmit={submit}
      >
        <header className="cxp-header">
          <span className="cxp-icon">
            <HostIcon token="permissions" />
          </span>
          <div className="cxp-header-copy">
            <h2 className="cxp-title" id={headingId}>{copy.heading}</h2>
            <p className="cxp-plugin-name">{pluginId}</p>
          </div>
        </header>
        <p className="cxp-http-description" id={descriptionId}>{copy.description}</p>
        <dl className="cxp-http-details">
          <dt>{copy.pluginLabel}</dt>
          <dd>{pluginId}</dd>
          <dt>{copy.serverLabel}</dt>
          <dd>{origin}</dd>
        </dl>
        {credential === 'bearer'
          ? (
            <>
              <label className="cxp-http-credential">
                <span>{copy.tokenLabel}</span>
                <Input
                  ref={secretInput}
                  type="password"
                  autocomplete="off"
                  maxlength={16_384}
                  data-plugin-http-secret="true"
                />
              </label>
              <p className="cxp-http-credential-hint">{copy.tokenHint}</p>
            </>
          )
          : null}
        <footer className="cxp-actions">
          <Button
            tag="button"
            type="button"
            theme="default"
            variant="outline"
            className="cxp-button cxp-manage"
            data-plugin-http-action="cancel"
            onClick={() => finish({ approved: false })}
          >
            {copy.cancel}
          </Button>
          <Button
            tag="button"
            type="submit"
            theme="primary"
            className="cxp-button"
            data-plugin-http-action="allow"
            data-primary="true"
          >
            {copy.allow}
          </Button>
        </footer>
      </form>
    </ConfigProvider>
  )
}
