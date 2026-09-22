import { useLayoutEffect, useRef, useState } from 'react'
import { Button, Switch } from 'tdesign-react'
import type {
  CatalogManagementCommand,
  CatalogManagementOperation,
  CatalogManagementView,
} from '../../../../model-catalog-management.js'
import type { ModelCatalogClient } from '../../../model-catalog-client.js'
import type { HostModelProvider } from '../../../model-providers.js'
import { HostBrandIcon } from '../../../host-ui/HostBrandIcon.js'
import { ModelBrandIcon } from '../../../host-ui/ModelBrandIcon.js'
import { IconButton } from '../../../host-ui/IconButton.js'
import { MoreMenu, type MoreMenuItem } from '../../../host-ui/MoreMenu.js'
import { managerCopy } from '../../../ui-copy.js'
import { ModelEditor } from './ModelEditor.js'
import { ConnectionEditor } from './ConnectionEditor.js'
import { ScriptEditor } from './ScriptEditor.js'

type Intent = Exclude<CatalogManagementCommand, { operation: 'createConnection' }> extends infer C
  ? C extends CatalogManagementCommand ? Omit<C, 'bindingRef' | 'scopeRevision' | 'expectedRevision'> : never
  : never
export type CatalogFilter = 'all' | 'selectable' | 'blocked' | 'removed'
export const catalogQuery = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
export const catalogTime = (value: number | undefined, locale: string): string =>
  value === undefined
    ? managerCopy(locale, 'catalog.never')
    : new Date(value).toLocaleString(locale)

export function CatalogBinding({ view, client, provider, locale, query, filter, connected }: {
  readonly view: CatalogManagementView
  readonly client: ModelCatalogClient
  readonly provider?: HostModelProvider | undefined
  readonly locale: string
  readonly query: string
  readonly filter: CatalogFilter
  readonly connected: boolean
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const root = useRef<HTMLElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'conflict' | 'scopeChanged' | 'failed'>()
  const [editor, setEditor] = useState<'manual' | 'supplement' | 'connection' | 'script'>()
  const [confirmation, setConfirmation] = useState<
    { intent: Intent; copy: Parameters<typeof managerCopy>[1]; revision: string; scope: string }
  >()
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [limit, setLimit] = useState(100)
  const allowed = (operation: CatalogManagementOperation) => connected && !busy && view.capabilities.includes(operation)
  const scriptRunning = view.capabilities.includes('cancelScript')
  const scope = { bindingRef: view.bindingRef, scopeRevision: view.scopeRevision, expectedRevision: view.revision }
  const run = async (intent: Intent, expectedRevision = view.revision) => {
    setBusy(true)
    setError(undefined)
    const result = await client.command({ ...scope, ...intent, expectedRevision } as CatalogManagementCommand)
    setBusy(false)
    if (result.status !== 'applied' && result.status !== 'queued') {
      setError(result.code === 'scope-changed' ? 'scopeChanged' : result.status === 'conflict' ? 'conflict' : 'failed')
    }
    return result
  }
  const confirm = (intent: Intent, copy: Parameters<typeof managerCopy>[1]) => {
    setConfirmation({ intent, copy, revision: view.revision, scope: view.scopeRevision })
    setEditor(undefined)
    setError(undefined)
  }
  const items: MoreMenuItem[] = []
  const openEditor = (next: NonNullable<typeof editor>) => {
    setConfirmation(undefined)
    setEditor(next)
    setError(undefined)
  }
  const action = (
    id: CatalogManagementOperation,
    label: Parameters<typeof managerCopy>[1],
    icon: MoreMenuItem['icon'],
    select: () => void,
  ) => {
    if (view.capabilities.includes(id)) {
      items.push({ id, label: t(label), icon, disabled: !allowed(id), onSelect: select })
    }
  }
  action('editManual', 'catalog.editManual', 'edit', () => openEditor('manual'))
  action('editSupplement', 'catalog.editSupplement', 'edit', () => openEditor('supplement'))
  action('configureScript', 'catalog.configureScript', 'configuration', () => openEditor('script'))
  action(
    'convertToManual',
    'catalog.convert',
    'copy',
    () => confirm({ operation: 'convertToManual' }, 'catalog.convertConfirm'),
  )
  action(
    'setSource',
    'catalog.useAuto',
    'reload-plugin',
    () => confirm({ operation: 'setSource', source: 'auto' }, 'catalog.useAutoConfirm'),
  )
  action(
    'setMode',
    view.mode === 'augment' ? 'catalog.disableSupplement' : 'catalog.enableSupplement',
    'add',
    () => confirm({ operation: 'setMode', mode: view.mode === 'augment' ? 'only' : 'augment' }, 'catalog.modeConfirm'),
  )
  action(
    'resetOrder',
    'catalog.resetOrder',
    'reset-configuration',
    () => confirm({ operation: 'resetOrder' }, 'catalog.resetOrderConfirm'),
  )
  action(
    'restoreBlocked',
    'catalog.restoreBlocked',
    'enable-plugin',
    () => confirm({ operation: 'restoreBlocked' }, 'catalog.restoreBlockedConfirm'),
  )
  action('updateConnection', 'catalog.editConnection', 'configuration', () => openEditor('connection'))
  action(
    'requestCredentialReplacement',
    'catalog.replaceCredential',
    'permissions',
    () => confirm({ operation: 'requestCredentialReplacement' }, 'catalog.replaceConfirm'),
  )
  const matchesProvider = catalogQuery(`${view.title} ${view.providerId} ${view.scopeLabel ?? ''}`).includes(query)
  const rows = view.rows.filter(row =>
    (matchesProvider || catalogQuery(`${row.id} ${row.label}`).includes(query))
    && (filter === 'all' || filter === 'selectable' && row.selectable || filter === 'blocked' && row.blocked
      || filter === 'removed' && !row.present)
  )
  useLayoutEffect(() => {
    const previous = focused.current
    const document = root.current?.ownerDocument
    if (previous && !previous.isConnected && document && document.activeElement === document.body) {
      root.current?.querySelector<HTMLElement>('[data-catalog-list]')?.focus({ preventScroll: true })
      focused.current = null
    }
  })
  const status = view.outcome === 'error'
    ? 'catalog.error'
    : view.activity !== 'idle'
    ? 'catalog.refreshing'
    : `catalog.${view.freshness}` as const
  const sameConfirmation = confirmation?.revision === view.revision && confirmation.scope === view.scopeRevision
  const credentialBlocked = confirmation?.intent.operation === 'requestCredentialReplacement'
    && view.supplement.length > 0
  return (
    <section
      ref={root}
      className="cxmc-binding"
      data-binding-ref={view.bindingRef}
      onFocusCapture={event => {
        focused.current = event.target as HTMLElement
      }}
    >
      <header className="cxmc-binding-header">
        {provider?.selectorBrand
          ? <ModelBrandIcon brand={provider.selectorBrand} kind="provider" />
          : <HostBrandIcon icon={provider?.icon ?? 'host:settings'} />}
        <div className="cxms-provider-identity">
          <strong>{view.title}</strong>
          <code>{view.scopeLabel ?? view.providerId}</code>
        </div>
        <div className="cxmc-binding-actions">
          {view.sourceKind === 'auto'
            ? (
              <Switch
                value={!view.autoPaused}
                disabled={!allowed('setAutoPaused')}
                aria-label={t(view.autoPaused ? 'catalog.resume' : 'catalog.pause')}
                onChange={enabled => void run({ operation: 'setAutoPaused', paused: !enabled })}
              />
            )
            : null}
          {view.sourceKind === 'script' || view.scriptState
            ? (
              <IconButton
                tag="button"
                icon={scriptRunning ? 'console-pause' : 'console-resume'}
                label={t(scriptRunning ? 'catalog.cancelScript' : 'catalog.runScript')}
                disabled={!allowed(scriptRunning ? 'cancelScript' : 'runScript')}
                onClick={() => void run({ operation: scriptRunning ? 'cancelScript' : 'runScript' })}
              />
            )
            : null}
          {view.sourceKind !== 'script'
            ? (
              <IconButton
                tag="button"
                icon="reload-plugin"
                label={`${t('catalog.refresh')}: ${view.title}`}
                disabled={!allowed('refresh') || view.activity !== 'idle'}
                aria-busy={view.activity !== 'idle'}
                onClick={() => void run({ operation: 'refresh' })}
              />
            )
            : null}
          <IconButton
            tag="button"
            icon="point-info"
            label={`${t('catalog.diagnostics')}: ${view.title}`}
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
          />
          {items.length > 0 ? <MoreMenu label={`${t('catalog.more')}: ${view.title}`} items={items} /> : null}
        </div>
      </header>
      <div className="cxmc-status" data-freshness={view.freshness} data-outcome={view.outcome}>
        <span>{t(`catalog.${view.sourceKind}`)}</span>
        <span>{t(status)}</span>
        {view.diagnostics.targetState === 'pending-restart'
          ? <span>{t('catalog.pending-restart')}</span>
          : view.diagnostics.targetState === 'conflict'
          ? <span>{t('catalog.targetConflict')}</span>
          : null}
        {view.scriptState ? <span>{t('catalog.sessionOnly')}</span> : null}
        {view.autoPaused && view.sourceKind === 'auto' ? <span>{t('catalog.paused')}</span> : null}
        <span>{t('catalog.sourceCount')}: {view.sourceCount}</span>
        <span>{t('catalog.selectable')}: {view.selectableCount}</span>
        <span>
          {t('catalog.lastSuccess')}: <time>{catalogTime(view.diagnostics.lastSuccessAt, locale)}</time>
        </span>
      </div>
      {view.sourceKind === 'script' && !view.capabilities.includes('runScript') && !scriptRunning
        ? <p className="cxmc-muted">{t('catalog.scriptUnavailable')}</p>
        : null}
      {!connected
        ? <p role="status">{t('catalog.unavailable')}</p>
        : error
        ? <p role="status">{t(`catalog.${error}`)}</p>
        : null}
      {diagnosticsOpen
        ? (
          <dl className="cxmc-diagnostics">
            <dt>{t('catalog.diagnostics')}</dt>
            <dd>
              <code>{view.diagnostics.code ?? view.outcome}</code>
            </dd>
            <dt>{t('catalog.scope')}</dt>
            <dd>{t(view.diagnostics.scopeConfirmed ? 'catalog.scope' : 'catalog.unconfirmed')}</dd>
            <dt>{t('catalog.source')}</dt>
            <dd>
              {t(
                view.diagnostics.targetState === 'conflict'
                  ? 'catalog.targetConflict'
                  : `catalog.${view.diagnostics.targetState}`,
              )}
            </dd>
            <dt>{t('catalog.lastAttempt')}</dt>
            <dd>{catalogTime(view.diagnostics.lastAttemptAt, locale)}</dd>
            <dt>{t('catalog.retryAt')}</dt>
            <dd>{catalogTime(view.diagnostics.retryAt, locale)}</dd>
          </dl>
        )
        : null}
      {confirmation
        ? (
          <div className="cxmc-confirm" role="group" aria-label={t(confirmation.copy)}>
            <p>{t(confirmation.copy)}</p>
            {confirmation.intent.operation === 'convertToManual'
              ? (
                <details>
                  <summary>{t('catalog.latest')}</summary>
                  <ul>
                    {view.rows.filter(row => row.present).map(row => (
                      <li key={row.id}>
                        <code>{row.id}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )
              : null}
            {credentialBlocked ? <p role="status">{t('catalog.clearSupplementFirst')}</p> : null}
            {!sameConfirmation ? <p role="status">{t('catalog.conflict')}</p> : null}
            <div className="cxmc-editor-actions">
              <Button tag="button" variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>
                {t('catalog.cancel')}
              </Button>
              <Button
                tag="button"
                theme="primary"
                disabled={busy || !sameConfirmation || credentialBlocked || !connected}
                onClick={async () => {
                  const result = await run(confirmation.intent, confirmation.revision)
                  if (result.status === 'applied' || result.status === 'queued') setConfirmation(undefined)
                }}
              >
                {t('catalog.confirm')}
              </Button>
            </div>
          </div>
        )
        : null}
      {editor === 'script'
        ? (
          <ScriptEditor
            view={view}
            locale={locale}
            close={() => setEditor(undefined)}
            save={(config, mode, revision) => run({ operation: 'configureScript', config, mode }, revision)}
          />
        )
        : editor === 'connection'
        ? (
          <ConnectionEditor
            view={view}
            locale={locale}
            close={() => setEditor(undefined)}
            save={(settings, revision) => run({ operation: 'updateConnection', settings }, revision)}
          />
        )
        : editor
        ? (
          <ModelEditor
            key={editor}
            view={view}
            locale={locale}
            mode={editor}
            close={() => setEditor(undefined)}
            save={(models, revision) =>
              run({ operation: editor === 'manual' ? 'editManual' : 'editSupplement', models }, revision)}
          />
        )
        : null}
      <ul className="cxmc-models" data-catalog-list="true" tabIndex={-1} aria-label={view.title}>
        {rows.slice(0, limit).map(row => (
          <li key={row.id} data-model-id={row.id} data-present={row.present}>
            <div className="cxms-model-identity">
              <strong>{row.label}</strong>
              {row.id !== row.label ? <code>{row.id}</code> : null}
              <small>
                {row.provenance.map(source =>
                  t(
                    source === 'manual-supplement'
                      ? 'catalog.supplement'
                      : source === 'script-supplement'
                      ? 'catalog.scriptSupplement'
                      : `catalog.${source}`,
                  )
                ).join(' + ')}
              </small>
              {row.notListed ? <small>{t('catalog.notListed')}</small> : null}
            </div>
            <div className="cxmc-row-state">
              {row.blocked ? <span>{t('catalog.blocked')}</span> : null}
              {!row.present ? <span>{t('catalog.removed')}</span> : null}
              {row.present && !row.selectable && !row.blocked ? <span>{t('catalog.unavailable')}</span> : null}
            </div>
            <div className="cxmc-row-actions">
              <IconButton
                tag="button"
                icon={row.pinned ? 'favorite-active' : 'favorite'}
                label={`${t(row.pinned ? 'catalog.unpin' : 'catalog.pin')}: ${row.id}`}
                aria-pressed={row.pinned}
                disabled={!allowed('setOverlay')}
                onClick={() => void run({ operation: 'setOverlay', modelId: row.id, pinned: !row.pinned })}
              />
              <IconButton
                tag="button"
                icon={row.blocked ? 'enable-plugin' : 'disable-plugin'}
                label={`${t(row.blocked ? 'catalog.unblock' : 'catalog.block')}: ${row.id}`}
                aria-pressed={row.blocked}
                disabled={!allowed('setOverlay')}
                onClick={() => void run({ operation: 'setOverlay', modelId: row.id, blocked: !row.blocked })}
              />
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 0 ? <p className="cxmc-muted">{t('catalog.noModels')}</p> : null}
      {rows.length > limit
        ? <Button tag="button" variant="text" onClick={() => setLimit(limit + 100)}>{t('catalog.showMore')}</Button>
        : null}
    </section>
  )
}
