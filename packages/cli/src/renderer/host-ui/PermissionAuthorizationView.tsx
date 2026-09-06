import type { KeyboardEvent } from 'react'
import { Button, ConfigProvider, Radio } from 'tdesign-react'
import type {
  PermissionAuthorizationDialogProjection,
  PermissionAuthorizationDialogResult,
  PermissionAuthorizationItemProjection,
  PermissionAuthorizationViewModel,
} from '../../permission-authorization-view-model.js'
import type { CordisXPermissionDecisionV2 } from '../../permission-contracts.js'
import { PERMISSION_AUTHORIZATION_STYLES } from '../permission-authorization-styles.js'
import { HostIcon } from './HostIcon.js'
import { HOST_TDESIGN_REACT_STYLES } from './tdesign-styles.js'

function PermissionItem({
  item,
  viewModel,
  onSelectionChange,
}: {
  readonly item: PermissionAuthorizationItemProjection
  readonly viewModel: PermissionAuthorizationViewModel
  readonly onSelectionChange: () => void
}) {
  const risk = viewModel.plan.declarations.find(declaration => declaration.capability === item.capability)!.sensitivity
  const selected = item.authorizationOptions.find(option => option.selected)?.value
  const choose = (value: CordisXPermissionDecisionV2): void => {
    viewModel.select(item.capability, value)
    onSelectionChange()
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const radio = target.closest<HTMLElement>('[data-permission-decision]')
    const index = item.authorizationOptions.findIndex(option => option.value === radio?.dataset.permissionDecision)
    if (index < 0) return
    const movement = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? -1
      : 0
    if (movement === 0 && event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    const next = item.authorizationOptions[
      (index + movement + item.authorizationOptions.length) % item.authorizationOptions.length
    ]!
    choose(next.value)
    event.currentTarget.querySelector<HTMLElement>(`[data-permission-decision="${next.value}"]`)?.focus()
  }
  return (
    <section className="cxp-item" role="listitem" data-permission-capability={item.capability}>
      <div className="cxp-item-heading">
        <h3>{item.name}</h3>
        <span className="cxp-badge">{item.requirement}</span>
        <span className="cxp-badge" data-risk={risk}>{item.sensitivity}</span>
        <span className="cxp-badge" data-permission-review-mode={item.reviewMode}>{item.reviewModeLabel}</span>
      </div>
      <dl className="cxp-facts">
        <dt>{item.descriptionLabel}</dt>
        <dd>{item.description}</dd>
        <dt>{item.limitationLabel}</dt>
        <dd>{item.limitation}</dd>
        <dt>{item.scopeLabel}</dt>
        <dd>{item.scope}</dd>
      </dl>
      <p className="cxp-risk" data-risk={risk}>{item.risk}</p>
      {item.availability === undefined
        ? null
        : <p className="cxp-availability">{item.availability.statusLabel} · {item.availability.reason}</p>}
      {item.rationale === undefined ? null : (
        <section className="cxp-rationale">
          <p className="cxp-rationale-label">{item.rationale.label}</p>
          <p className="cxp-rationale-title">{item.rationale.title}</p>
          <p className="cxp-rationale-description">{item.rationale.description}</p>
          <dl>
            <dt>{item.rationale.featureLabel}</dt>
            <dd>{item.rationale.feature}</dd>
            <dt>{item.rationale.deniedBehaviorLabel}</dt>
            <dd>{item.rationale.deniedBehavior}</dd>
          </dl>
        </section>
      )}
      <fieldset className="cxp-decisions">
        <legend id={`cxp-label-${item.capability}`}>{item.authorizationLabel}</legend>
        <div
          className="cxp-options"
          role="radiogroup"
          aria-labelledby={`cxp-label-${item.capability}`}
          onKeyDown={keyboard}
        >
          {item.authorizationOptions.map(option => (
            <Radio
              key={option.value}
              className="cxp-option"
              name={`cxp-${viewModel.plan.planId}-${item.capability}`}
              value={option.value}
              checked={option.selected}
              {...{ role: 'radio', tabIndex: option.selected ? 0 : -1 }}
              aria-checked={option.selected}
              data-permission-decision={option.value}
              onChange={checked => {
                if (checked) choose(option.value)
              }}
            >
              {option.label}
            </Radio>
          ))}
        </div>
      </fieldset>
      <p className="cxp-denial" hidden={selected?.startsWith('deny') !== true} aria-live="polite">
        {item.denialImpact}
      </p>
      <details className="cxp-technical">
        <summary>{item.technical.label}</summary>
        <dl>
          <dt>{item.technical.capabilityIdLabel}</dt>
          <dd>{item.technical.capabilityId}</dd>
          <dt>{item.technical.providersLabel}</dt>
          <dd>{item.technical.providers.join(', ') || '—'}</dd>
          <dt>{item.technical.runtimeGenerationLabel}</dt>
          <dd>{item.technical.runtimeGeneration}</dd>
          <dt>{item.technical.moduleGenerationLabel}</dt>
          <dd>{item.technical.moduleGeneration ?? '—'}</dd>
          <dt>{item.technical.requestSourceLabel}</dt>
          <dd>{item.technical.requestSource ?? '—'}</dd>
        </dl>
      </details>
    </section>
  )
}

export function PermissionAuthorizationView({
  projection,
  viewModel,
  overlay,
  onSelectionChange,
  finish,
}: {
  readonly projection: PermissionAuthorizationDialogProjection
  readonly viewModel: PermissionAuthorizationViewModel
  readonly overlay: HTMLElement
  readonly onSelectionChange: () => void
  readonly finish: (result: PermissionAuthorizationDialogResult) => void
}) {
  const headingId = `cxp-heading-${viewModel.plan.planId.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`
  return (
    <ConfigProvider globalConfig={{ attach: () => overlay }}>
      <style data-permission-authorization-components="true">{HOST_TDESIGN_REACT_STYLES}</style>
      <style data-permission-authorization-style="true">{PERMISSION_AUTHORIZATION_STYLES}</style>
      <section className="cxp-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header className="cxp-header">
          <span className="cxp-icon">
            <HostIcon
              token={projection.plugin.icon ?? 'host:more'}
              surfaceToken={projection.plugin.icon ?? 'host:more'}
            />
          </span>
          <div className="cxp-header-copy">
            <h2 className="cxp-title" id={headingId}>{projection.heading}</h2>
            <p className="cxp-plugin-name">{projection.plugin.name}</p>
            <dl className="cxp-plugin-meta">
              <dt>{projection.plugin.sourceLabel}</dt>
              <dd>{projection.plugin.source}</dd>
              <dt>{projection.plugin.trustLabel}</dt>
              <dd>{projection.plugin.trust}</dd>
            </dl>
          </div>
        </header>
        <div className="cxp-list" role="list">
          {projection.items.map(item => (
            <PermissionItem
              key={item.capability}
              item={item}
              viewModel={viewModel}
              onSelectionChange={onSelectionChange}
            />
          ))}
        </div>
        <footer className="cxp-actions">
          <Button
            tag="button"
            type="button"
            theme="default"
            variant="outline"
            className="cxp-button cxp-manage"
            data-permission-action="manage"
            onClick={() => finish(viewModel.managePermissions())}
          >
            {projection.actions.manage}
          </Button>
          <Button
            tag="button"
            type="button"
            theme="default"
            variant="outline"
            className="cxp-button"
            data-permission-action="cancel"
            onClick={() => finish(viewModel.cancel())}
          >
            {projection.actions.cancel}
          </Button>
          <Button
            tag="button"
            type="button"
            theme="primary"
            className="cxp-button"
            data-permission-action="confirm"
            data-primary="true"
            onClick={() => finish(viewModel.confirm())}
          >
            {projection.actions.confirm}
          </Button>
        </footer>
      </section>
    </ConfigProvider>
  )
}
