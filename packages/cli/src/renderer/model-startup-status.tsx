import type { StartupProjectionV1 } from '@cordisx/protocol/startup/v1'
import type { ModelStartupState } from './model-startup-store.js'
import { managerCopy } from './ui-copy.js'
import type { ReactNode } from 'react'
import { HoverCard } from './host-ui/HoverCard.js'

export function ModelStartupIcon({ children, entry, state, locale }: {
  readonly children: ReactNode
  readonly entry: StartupProjectionV1
  readonly state?: ModelStartupState | undefined
  readonly locale: string
}) {
  return (
    <HoverCard
      content={modelStartupDescription(entry, state, locale)}
      trigger={
        <span className="cxmp-startup-icon" tabIndex={-1}>
          {children}
          <ModelStartupStatus entry={entry} state={state} locale={locale} dot />
        </span>
      }
    />
  )
}

function modelStartupDescription(
  entry: StartupProjectionV1,
  state: ModelStartupState | undefined,
  locale: string,
): string {
  const connection = state?.connection
  const connectionLabel = connection && connection !== 'connected'
    ? managerCopy(
      locale,
      connection === 'closed'
        ? 'catalog.startup.observationClosed'
        : connection === 'reconnecting'
        ? 'catalog.startup.reconnecting'
        : 'catalog.startup.disconnected',
    )
    : undefined
  return [modelStartupLabel(entry, locale), connectionLabel].filter(Boolean).join(' · ')
}

export function modelStartupLabel(entry: StartupProjectionV1, locale: string): string {
  const reason = entry.actions.execute.available ? undefined : entry.actions.execute.reason
  const key = reason === 'permission-denied'
    ? 'catalog.startup.permission'
    : entry.authentication === 'expired'
    ? 'catalog.startup.expired'
    : entry.state === 'auth-required'
    ? 'catalog.startup.authRequired'
    : entry.state === 'failed'
    ? 'catalog.startup.failed'
    : entry.catalog.state === 'failed'
    ? 'catalog.startup.catalogFailed'
    : entry.authentication === 'failed'
    ? 'catalog.startup.authFailed'
    : entry.authentication === 'authenticating'
    ? 'catalog.startup.authenticating'
    : entry.authentication === 'logged-out' || entry.authentication === 'missing'
    ? 'catalog.startup.authRequired'
    : entry.state === 'stopped'
    ? 'catalog.startup.stopped'
    : entry.state === 'revoked'
    ? 'catalog.startup.revoked'
    : entry.state === 'unknown'
    ? 'catalog.startup.unknown'
    : entry.catalog.state === 'known' && entry.catalog.modelIds.length === 0
    ? 'catalog.noModels'
    : entry.catalog.state === 'pending' || entry.state === 'catalog-pending'
    ? 'catalog.startup.catalogPending'
    : entry.state === 'ready'
    ? 'catalog.startup.ready'
    : 'catalog.startup.pending'
  return managerCopy(locale, key)
}

export function ModelStartupStatus({ entry, state, locale, dot = false }: {
  readonly entry: StartupProjectionV1
  readonly state?: ModelStartupState | undefined
  readonly locale: string
  readonly dot?: boolean
}) {
  const connection = state?.connection
  // Dots describe provider objects; polling them must not create a live message.
  return (
    <small
      className={dot ? 'cxmp-startup-dot' : 'cxmp-startup-status'}
      role={dot ? undefined : 'status'}
      data-startup-state={entry.state}
      data-startup-connection={connection}
    >
      <span className={dot ? 'cxmp-startup-dot-label' : undefined}>
        {modelStartupLabel(entry, locale)}
        {connection && connection !== 'connected'
          ? ` · ${
            managerCopy(
              locale,
              connection === 'closed'
                ? 'catalog.startup.observationClosed'
                : connection === 'reconnecting'
                ? 'catalog.startup.reconnecting'
                : 'catalog.startup.disconnected',
            )
          }`
          : null}
      </span>
    </small>
  )
}
