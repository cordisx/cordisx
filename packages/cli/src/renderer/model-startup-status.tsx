import type { StartupProjectionV1 } from '@cordisx/protocol/startup/v1'
import type { ModelStartupState } from './model-startup-store.js'
import { managerCopy } from './ui-copy.js'

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

export function ModelStartupStatus({ entry, state, locale }: {
  readonly entry: StartupProjectionV1
  readonly state?: ModelStartupState | undefined
  readonly locale: string
}) {
  const connection = state?.connection
  return (
    <small className="cxmp-startup-status" role="status" data-startup-state={entry.state}>
      {modelStartupLabel(entry, locale)}
      {connection && connection !== 'connected'
        ? ` · ${
          managerCopy(
            locale,
            connection === 'reconnecting' ? 'catalog.startup.reconnecting' : 'catalog.startup.disconnected',
          )
        }`
        : null}
    </small>
  )
}
