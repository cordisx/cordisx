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
import { useProgressiveModelRows } from './model-service-list.js'

type Intent = Exclude<CatalogManagementCommand, { operation: 'createConnection' }> extends infer C
  ? C extends CatalogManagementCommand ? Omit<C, 'bindingRef' | 'scopeRevision' | 'expectedRevision'> : never
  : never
export type CatalogFilter = 'selectable' | 'blocked' | 'removed'
export const catalogQuery = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
export const catalogTime = (value: number | undefined, locale: string): string =>
  value === undefined
    ? managerCopy(locale, 'catalog.never')
    : new Date(value).toLocaleString(locale)

export function CatalogBinding(
  { view, client, provider, locale, query, filters, connected, expanded, onExpandedChange }: {
    readonly view: CatalogManagementView
    readonly client: ModelCatalogClient
    readonly provider?: HostModelProvider | undefined
    readonly locale: string
    readonly query: string
    readonly filters: ReadonlySet<CatalogFilter>
    readonly connected: boolean
    readonly expanded?: boolean
    readonly onExpandedChange?: (open: boolean) => void
  },
) {
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
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const capabilityView = view
  const sourceCapabilities = capabilityView.sourceCapabilities ?? view.capabilities
  const preferenceCapabilities = capabilityView.preferenceCapabilities ?? view.capabilities
  const effectiveExpanded = expanded ?? true
  const changeExpanded = onExpandedChange ?? (() => {})
  const sourceAllowed = (operation: CatalogManagementOperation) =>
    connected && !busy && sourceCapabilities.includes(operation)
  const preferenceAllowed = (operation: CatalogManagementOperation) =>
    connected && !busy && preferenceCapabilities.includes(operation)
  const scriptRunning = sourceCapabilities.includes('cancelScript')
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
    const preferenceAction = id === 'resetOrder' || id === 'restoreBlocked'
    const capabilities = preferenceAction ? preferenceCapabilities : sourceCapabilities
    const allowed = preferenceAction ? preferenceAllowed : sourceAllowed
    if (capabilities.includes(id)) {
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
  const supportedRows = view.rows.filter(row =>
    (row as typeof row & { readonly compatibility?: string }).compatibility === 'supported'
  )
  const rows = supportedRows.filter(row =>
    (matchesProvider || catalogQuery(`${row.id} ${row.label}`).includes(query))
    && (filters.size === 0 || filters.has('selectable') && row.selectable || filters.has('blocked') && row.blocked
      || filters.has('removed') && !row.present)
  )
  const canExpand = rows.length > 0
  const listExpanded = canExpand && effectiveExpanded
  const scriptUnavailable = view.sourceKind === 'script' && !sourceCapabilities.includes('runScript') && !scriptRunning
  const detailVisible = listExpanded || diagnosticsOpen || confirmation !== undefined || editor !== undefined
    || error !== undefined || !connected || scriptUnavailable
  const emptyLabel = view.activity !== 'idle'
    ? t('catalog.refreshing')
    : view.outcome === 'error'
    ? t('catalog.error')
    : view.sourceCount === 0
    ? t('catalog.noModels')
    : query !== ''
    ? t('catalog.noMatchingModels')
    : filters.has('selectable')
    ? t('catalog.noSelectableModels')
    : t('catalog.noMatchingModels')
  const progressive = useProgressiveModelRows(rows.length, `${query}:${[...filters].sort().join(',')}`)
  useLayoutEffect(() => {
    const previous = focused.current
    const document = root.current?.ownerDocument
    if (previous && !previous.isConnected && document && document.activeElement === document.body) {
      root.current?.querySelector<HTMLElement>('[data-catalog-list]')?.focus({ preventScroll: true })
      focused.current = null
    }
  })
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
      data-expanded={listExpanded}
    >
      <header className="cxmc-binding-header">
        <button
          type="button"
          className="cxmc-binding-toggle"
          aria-expanded={listExpanded}
          aria-controls={`cxmc-binding-${view.bindingRef.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
          disabled={!canExpand}
          onClick={() => changeExpanded(!listExpanded)}
        >
          <span className="cxms-disclosure-mark" aria-hidden="true" />
          {provider?.selectorBrand
            ? <ModelBrandIcon brand={provider.selectorBrand} kind="provider" />
            : <HostBrandIcon icon={provider?.icon ?? 'host:settings'} />}
          <span className="cxms-provider-identity">
            <strong>{view.title}</strong>
            <code>{view.scopeLabel ?? view.providerId}</code>
          </span>
          <span className="cxms-model-count">
            {canExpand ? `${t('catalog.sourceCount')}: ${view.sourceCount}` : emptyLabel}
          </span>
        </button>
        <div className="cxmc-binding-actions" data-menu-open={actionMenuOpen}>
          {view.sourceKind === 'auto' && sourceCapabilities.includes('setAutoPaused')
            ? (
              <Switch
                value={!view.autoPaused}
                disabled={!sourceAllowed('setAutoPaused')}
                aria-label={t(view.autoPaused ? 'catalog.resume' : 'catalog.pause')}
                onChange={enabled => void run({ operation: 'setAutoPaused', paused: !enabled })}
              />
            )
            : null}
          {sourceCapabilities.includes('runScript') || sourceCapabilities.includes('cancelScript')
            ? (
              <IconButton
                tag="button"
                icon={scriptRunning ? 'console-pause' : 'console-resume'}
                label={t(scriptRunning ? 'catalog.cancelScript' : 'catalog.runScript')}
                disabled={!sourceAllowed(scriptRunning ? 'cancelScript' : 'runScript')}
                onClick={() => void run({ operation: scriptRunning ? 'cancelScript' : 'runScript' })}
              />
            )
            : null}
          {sourceCapabilities.includes('refresh')
            ? (
              <IconButton
                tag="button"
                icon="reload-plugin"
                label={`${t('catalog.refresh')}: ${view.title}`}
                disabled={!sourceAllowed('refresh') || view.activity !== 'idle'}
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
            onClick={() => {
              setDiagnosticsOpen(!diagnosticsOpen)
            }}
          />
          {items.length > 0
            ? (
              <MoreMenu
                label={`${t('catalog.more')}: ${view.title}`}
                items={items}
                onOpenChange={setActionMenuOpen}
              />
            )
            : null}
          {preferenceCapabilities.includes('setProviderFavorite')
            ? (
              <IconButton
                tag="button"
                className="cxmc-provider-favorite"
                icon={capabilityView.providerFavorite ? 'favorite-active' : 'favorite'}
                label={`${
                  t(capabilityView.providerFavorite ? 'catalog.unfavoriteProvider' : 'catalog.favoriteProvider')
                }: ${view.title}`}
                aria-pressed={capabilityView.providerFavorite}
                disabled={!preferenceAllowed('setProviderFavorite')}
                onClick={() =>
                  void run({
                    operation: 'setProviderFavorite',
                    favorite: !capabilityView.providerFavorite,
                  })}
              />
            )
            : null}
        </div>
      </header>
      <div id={`cxmc-binding-${view.bindingRef.replace(/[^a-zA-Z0-9_-]/g, '-')}`} hidden={!detailVisible}>
        {scriptUnavailable
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
        <ul
          className="cxmc-models"
          data-catalog-list="true"
          tabIndex={-1}
          aria-label={view.title}
          hidden={!listExpanded}
        >
          {rows.slice(0, progressive.limit).map(row => (
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
                  disabled={!preferenceAllowed('setOverlay')}
                  onClick={() =>
                    void run({ operation: 'setOverlay', modelId: row.id, pinned: !row.pinned })}
                />
                <IconButton
                  tag="button"
                  icon={row.blocked ? 'enable-plugin' : 'disable-plugin'}
                  label={`${t(row.blocked ? 'catalog.unblock' : 'catalog.block')}: ${row.id}`}
                  aria-pressed={row.blocked}
                  disabled={!preferenceAllowed('setOverlay')}
                  onClick={() =>
                    void run({ operation: 'setOverlay', modelId: row.id, blocked: !row.blocked })}
                />
              </div>
            </li>
          ))}
          {progressive.sentinel
            ? <li ref={progressive.sentinel} className="cxms-list-sentinel" aria-hidden="true" />
            : null}
        </ul>
      </div>
    </section>
  )
}
