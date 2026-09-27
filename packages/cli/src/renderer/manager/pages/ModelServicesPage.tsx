import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Checkbox } from 'tdesign-react'
import { inferModelBrand } from '../../../model-selector-branding.js'
import type { ModelProviderRegistry, ModelProviderSnapshot } from '../../model-providers.js'
import { ModelServicesIllustration } from '../../host-ui/ModelServicesIllustration.js'
import { EmptyState } from '../../host-ui/EmptyState.js'
import { HostBrandIcon } from '../../host-ui/HostBrandIcon.js'
import { ModelBrandIcon } from '../../host-ui/ModelBrandIcon.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { HostMenuSurface } from '../../host-ui/HostMenu.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import { SearchToolbar } from '../../host-ui/SearchToolbar.js'
import { ProviderAction } from '../../model-provider-actions.js'
import { modelProviderCopy } from '../../model-provider-copy.js'
import css from '../../model-providers.css?inline'
import pageCss from './model-services.css?inline'
import catalogCss from './model-catalog/model-catalog.css?inline'
import {
  CatalogBinding,
  catalogBindingMatches,
  type CatalogFilter,
  catalogMatchingRows,
  catalogQuery,
} from './model-catalog/CatalogBinding.js'
import { managerCopy } from '../../ui-copy.js'
import type { CatalogClientState } from '../../model-catalog-client.js'
import { useProgressiveModelRows } from './model-catalog/model-service-list.js'
import { useModelTransfer } from './model-catalog/useModelTransfer.js'
import {
  type ModelServicesSecondaryPage,
  modelServicesSecondaryPage,
  ModelTransferPage,
} from './model-catalog/ModelTransferPages.js'

const empty: ModelProviderSnapshot = { providers: [], entries: [], loading: false }
const noop = () => () => {}
const emptyCatalog: CatalogClientState = { epoch: '', sequence: 0, views: [], connected: false, loading: false }

export function ModelServicesPage({ registry, locale, onCreate, onSecondaryPageChange }: {
  readonly registry: ModelProviderRegistry | undefined
  readonly locale: string
  readonly onCreate?: (() => void) | undefined
  readonly onSecondaryPageChange?: (page: ModelServicesSecondaryPage | undefined) => void
}) {
  const state = useSyncExternalStore(registry?.subscribe ?? noop, registry?.snapshot ?? (() => empty))
  const client = registry?.management
  const catalog = useSyncExternalStore(client?.subscribe ?? noop, client?.snapshot ?? (() => emptyCatalog))
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ReadonlySet<CatalogFilter>>(() => new Set(['selectable']))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const transfer = useModelTransfer(client, locale, () => {
    setFilters(new Set())
    void registry?.refresh()
  })
  const secondaryPage = modelServicesSecondaryPage(transfer, locale)
  const secondaryPageRef = useRef(secondaryPage)
  secondaryPageRef.current = secondaryPage
  useEffect(() => {
    onSecondaryPageChange?.(secondaryPageRef.current)
    return () => onSecondaryPageChange?.(undefined)
  }, [onSecondaryPageChange, secondaryPage?.id, secondaryPage?.title])
  const copy = modelProviderCopy(locale)
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  useEffect(() => {
    void registry?.refresh()
  }, [registry])
  const normalized = catalogQuery(query)
  const managementState = !client ? 'no-channel' : catalog.loading && !catalog.epoch
    ? 'loading'
    : catalog.connected
    ? 'ready'
    : 'disconnected'
  const managedIds = new Set(catalog.views.map(view => view.providerId))
  const providers = state.providers.flatMap(provider => {
    if (managedIds.has(provider.providerId)) return []
    const matchesProvider = catalogQuery(`${provider.providerId} ${provider.title}`).includes(normalized)
    const models = filters.size === 0 || filters.has('selectable')
      ? provider.models.filter(model =>
        matchesProvider || catalogQuery(`${model.id} ${model.label}`).includes(normalized)
      )
      : []
    return [{ provider: { ...provider, models }, sourceModelCount: provider.models.length }]
  })
  const transferableModelIds = (view: CatalogClientState['views'][number]) =>
    view.rows.filter(row =>
      row.present && !row.provenance.some(value => value === 'script' || value === 'script-supplement')
    ).map(row => row.id)
  const exportableViews = catalog.views.filter(view =>
    view.sourceKind !== 'plugin' && view.transferAvailable && transferableModelIds(view).length > 0
  )
  const views = transfer.exporting
    ? exportableViews.filter(view =>
      normalized === '' || catalogBindingMatches(view, normalized)
      || catalogMatchingRows(view, normalized, filters).length > 0
    )
    : catalog.views
  const selectedExports = exportableViews.flatMap(view =>
    transfer.selected.has(view.bindingRef)
      ? [{ bindingRef: view.bindingRef, modelIds: transferableModelIds(view) }]
      : []
  )
  const visibleExportRefs = views.map(view => view.bindingRef)
  const visibleSelectedCount = visibleExportRefs.filter(ref => transfer.selected.has(ref)).length
  const allVisibleSelected = visibleExportRefs.length > 0 && visibleSelectedCount === visibleExportRefs.length
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected
  const loading = state.loading || catalog.loading
  const refreshing = loading || state.refreshing === true || catalog.refreshing === true
  const unavailable = !registry || !client
  const failed = Boolean(state.error) || Boolean(client && !catalog.connected && !catalog.loading)
  const canCreate = Boolean(onCreate && client && catalog.connected && catalog.canCreateConnection && !loading)
  const refresh = () => {
    void registry?.refresh()
    void client?.refresh()
  }
  const noConnections = state.providers.length === 0 && catalog.views.length === 0
  const filtering = filters.size !== 1 || !filters.has('selectable')
  const noMatches = normalized.length > 0
    && !providers.some(({ provider }) =>
      catalogQuery(`${provider.providerId} ${provider.title}`).includes(normalized) || provider.models.length > 0
    )
    && !views.some(view =>
      catalogBindingMatches(view, normalized) || catalogMatchingRows(view, normalized, filters).length > 0
    )
  const noFilterMatches = !normalized && filtering && !noConnections
    && providers.every(({ provider }) => provider.models.length === 0)
    && views.every(view => catalogMatchingRows(view, normalized, filters).length === 0)
  const clearSearch = () => {
    setQuery('')
    setFilters(new Set())
  }
  const setProviderExpanded = (key: string, open: boolean) => {
    setExpanded(current => {
      const next = new Set(current)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }
  return (
    <div className="cxms-transfer-page-host">
      <section
        className="cxr-page cxmp-management"
        data-catalog-management={managementState}
        data-exporting={transfer.exporting}
        hidden={secondaryPage !== undefined}
      >
        <style>{`${css}\n${pageCss}\n${catalogCss}`}</style>
        <SearchToolbar
          toolbarLabel={t('catalog.tools')}
          clearLabel={locale.startsWith('zh') ? '清除搜索' : 'Clear search'}
          value={query}
          onChange={setQuery}
          aria-label={copy.search}
          placeholder={copy.search}
          actions={
            <>
              <CatalogFilterMenu
                label={t('catalog.filter')}
                filters={filters}
                disabled={!client}
                copy={value => t(`catalog.${value}`)}
                onChange={setFilters}
              />
              {catalog.canCreateConnection && client && onCreate
                ? (
                  <IconButton
                    tag="button"
                    icon="add"
                    label={t('catalog.addConnection')}
                    disabled={!catalog.connected || refreshing}
                    onClick={() => onCreate?.()}
                  />
                )
                : null}
              <MoreMenu
                label={t('catalog.more')}
                items={[
                  {
                    id: 'refresh',
                    label: copy.refresh,
                    icon: 'reload-plugin',
                    disabled: !registry || refreshing,
                    onSelect: refresh,
                  },
                  {
                    id: 'environment',
                    label: locale.startsWith('zh') ? '环境变量' : 'Environment variables',
                    icon: 'configuration',
                    disabled: !client || !catalog.connected || transfer.busy || transfer.exporting,
                    onSelect: () => void transfer.openEnvironment(),
                  },
                  {
                    id: 'import',
                    label: locale.startsWith('zh') ? '从剪贴板导入' : 'Import from clipboard',
                    icon: 'add',
                    disabled: !client || !catalog.connected || transfer.busy || transfer.exporting,
                    onSelect: () => void transfer.importClipboard(),
                  },
                  {
                    id: 'export',
                    label: locale.startsWith('zh') ? '导出模型配置' : 'Export model configuration',
                    icon: 'copy',
                    disabled: !client || !catalog.connected || transfer.busy || transfer.exporting
                      || exportableViews.length === 0,
                    onSelect: transfer.begin,
                  },
                ]}
              />
            </>
          }
        />
        {transfer.exporting
          ? (
            <div
              className="cxms-export-toolbar"
              role="group"
              aria-label={locale.startsWith('zh') ? '导出模型' : 'Export models'}
            >
              <Checkbox
                className="cxms-export-select-all"
                aria-label={locale.startsWith('zh') ? '选择全部可见模型服务' : 'Select all visible model services'}
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                disabled={visibleExportRefs.length === 0 || transfer.busy}
                onChange={() => transfer.setProviders(visibleExportRefs, !allVisibleSelected)}
              />
              <span className="cxms-export-count">
                {locale.startsWith('zh')
                  ? `已选 ${transfer.selectedCount} 个模型服务`
                  : `${transfer.selectedCount} model services selected`}
              </span>
              <IconButton
                tag="button"
                icon="copy"
                label={locale.startsWith('zh') ? '复制所选模型服务配置' : 'Copy selected model service configuration'}
                disabled={!transfer.selectedCount || transfer.busy}
                loading={transfer.busy}
                onClick={() => void transfer.finish(selectedExports)}
              />
              <IconButton
                tag="button"
                icon="close"
                label={locale.startsWith('zh') ? '退出导出选择' : 'Exit export selection'}
                disabled={transfer.busy}
                onClick={transfer.cancel}
              />
            </div>
          )
          : null}
        <div
          className="cxmp-results"
          aria-busy={refreshing}
          data-empty-layout={noConnections && !failed && !unavailable ? 'hero' : undefined}
        >
          {transfer.exporting || state.entries.length === 0
            ? null
            : (
              <section className="cxms-actions" aria-label={copy.providers}>
                {state.entries.map(({ key, entry }) => (
                  <ProviderAction
                    key={key}
                    entry={entry}
                    failed={copy.actionFailed}
                    refresh={() => registry!.refresh()}
                  />
                ))}
              </section>
            )}
          {!loading && (failed || unavailable)
            ? (
              <EmptyState
                icon="models-read"
                state={failed ? 'error' : 'unavailable'}
                title={t(failed ? 'empty.modelsFailed' : 'empty.modelsUnavailable')}
                description={t('empty.retryHelp')}
                action={registry ? { label: copy.refresh, onClick: refresh } : undefined}
              />
            )
            : null}
          {client
            ? views.map(view => (
              <CatalogBinding
                key={view.bindingRef}
                view={view}
                client={client}
                provider={state.providers.find(provider => provider.providerId === view.providerId)}
                locale={locale}
                query={normalized}
                filters={filters}
                connected={catalog.connected}
                expanded={normalized.length > 0 || expanded.has(view.bindingRef)}
                onExpandedChange={open => {
                  if (!normalized) setProviderExpanded(view.bindingRef, open)
                }}
                {...(transfer.exporting
                  ? {
                    exportSelection: {
                      selected: transfer.selected.has(view.bindingRef),
                      disabled: transferableModelIds(view).length === 0,
                      toggle: () => transfer.toggleProvider(view.bindingRef),
                    },
                  }
                  : {
                    onShare: (id: string) => transfer.shareModel(view.bindingRef, id),
                    onShareProvider: () => void transfer.shareProvider(view.bindingRef, transferableModelIds(view)),
                  })}
              />
            ))
            : null}
          {transfer.exporting ? null : providers.map(({ provider, sourceModelCount }) => (
            <LegacyProvider
              key={provider.providerId}
              provider={provider}
              modelsLabel={copy.models}
              {...(catalog.connected ? { readOnly: t('catalog.readOnly') } : {})}
              bindingState={catalog.connected ? 'unbound' : managementState}
              emptyLabel={state.loading
                ? copy.loading
                : state.error
                ? copy.loadFailed
                : sourceModelCount === 0
                ? copy.emptyModels
                : normalized
                ? copy.noMatches
                : filters.has('selectable')
                ? t('catalog.noSelectableModels')
                : copy.noMatches}
              expanded={normalized.length > 0 || expanded.has(provider.providerId)}
              onExpandedChange={open => {
                if (!normalized) setProviderExpanded(provider.providerId, open)
              }}
              resetKey={`${normalized}:${[...filters].sort().join(',')}`}
            />
          ))}
          {transfer.exporting && views.length === 0
            ? <p className="cxr-empty">{locale.startsWith('zh') ? '没有可导出的连接' : 'No exportable connections'}</p>
            : null}
          {!transfer.exporting && (noConnections && (loading || !failed && !unavailable)
              || (noMatches || noFilterMatches) && !loading && !failed)
            ? (
              <EmptyState
                icon="models-read"
                state={loading ? 'loading' : noMatches || noFilterMatches ? 'search' : 'empty'}
                title={t(
                  loading
                    ? 'empty.modelsLoading'
                    : noMatches || noFilterMatches
                    ? 'empty.modelMatches'
                    : 'empty.models',
                )}
                description={t(
                  loading
                    ? 'empty.modelsLoadingHelp'
                    : noMatches || noFilterMatches
                    ? 'empty.searchHelp'
                    : 'empty.modelsHelp',
                )}
                illustration={!unavailable ? <ModelServicesIllustration /> : undefined}
                action={loading ? undefined : noMatches || noFilterMatches
                  ? { label: t(normalized ? 'empty.clearSearch' : 'empty.clearFilters'), onClick: clearSearch }
                  : canCreate
                  ? { label: t('catalog.addConnection'), onClick: onCreate!, disabled: refreshing, variant: 'primary' }
                  : undefined}
              />
            )
            : null}
        </div>
      </section>
      {secondaryPage === undefined ? null : <ModelTransferPage transfer={transfer} locale={locale} />}
    </div>
  )
}

const filterOptions = [
  { value: 'selectable', icon: 'enable-plugin' },
  { value: 'blocked', icon: 'disable-plugin' },
  { value: 'removed', icon: 'delete' },
] as const

function CatalogFilterMenu({ label, filters, disabled, copy, onChange }: {
  readonly label: string
  readonly filters: ReadonlySet<CatalogFilter>
  readonly disabled: boolean
  readonly copy: (value: CatalogFilter | 'all') => string
  readonly onChange: (filters: ReadonlySet<CatalogFilter>) => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLElement>(null)
  const toggle = (filter: CatalogFilter) => {
    const next = new Set(filters)
    if (next.has(filter)) next.delete(filter)
    else next.add(filter)
    onChange(next)
  }
  return (
    <span ref={anchorRef} className="cxmp-filter-menu-anchor">
      <IconButton
        ref={triggerRef}
        tag="button"
        className="cxmp-filter-trigger"
        icon="models-read"
        label={label}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={filters.size > 0}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const focusLast = event.key === 'ArrowUp'
          setOpen(true)
          queueMicrotask(() => {
            const items = document.querySelectorAll<HTMLElement>('.cxmp-filter-menu [role^="menuitem"]')
            ;(focusLast ? items.item(items.length - 1) : items.item(0))?.focus()
          })
        }}
      />
      {filters.size > 0 ? <span className="cxmp-filter-indicator" aria-hidden="true" /> : null}
      <HostMenuSurface
        open={open}
        label={label}
        anchorRef={anchorRef}
        returnFocusRef={triggerRef}
        align="end"
        className="cxmp-filter-menu"
        onClose={() => setOpen(false)}
      >
        <button
          type="button"
          className="cxmp-filter-menu-item"
          role="menuitemcheckbox"
          aria-checked={filters.size === 0}
          data-menu-initial="true"
          onClick={() => onChange(new Set())}
        >
          <HostIcon token="models-read" />
          <span>{copy('all')}</span>
          <span className="cxmp-filter-check" aria-hidden="true">{filters.size === 0 ? '✓' : ''}</span>
        </button>
        {filterOptions.map(option => (
          <button
            key={option.value}
            type="button"
            className="cxmp-filter-menu-item"
            role="menuitemcheckbox"
            aria-checked={filters.has(option.value)}
            onClick={() => toggle(option.value)}
          >
            <HostIcon token={option.icon} />
            <span>{copy(option.value)}</span>
            <span className="cxmp-filter-check" aria-hidden="true">
              {filters.has(option.value) ? '✓' : ''}
            </span>
          </button>
        ))}
      </HostMenuSurface>
    </span>
  )
}

function LegacyProvider({
  provider,
  modelsLabel,
  readOnly,
  bindingState,
  emptyLabel,
  expanded,
  onExpandedChange,
  resetKey,
}: {
  readonly provider: ModelProviderSnapshot['providers'][number]
  readonly modelsLabel: string
  readonly readOnly?: string
  readonly bindingState: string
  readonly emptyLabel: string
  readonly expanded: boolean
  readonly onExpandedChange: (open: boolean) => void
  readonly resetKey: string
}) {
  const canExpand = provider.models.length > 0
  const effectiveExpanded = canExpand && expanded
  const rows = useProgressiveModelRows(provider.models.length, resetKey)
  const contentId = `cxms-provider-${provider.providerId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  return (
    <section
      className="cxmp-provider-detail cxms-provider"
      data-catalog-binding={bindingState}
      data-expanded={effectiveExpanded}
    >
      <header className="cxms-provider-header">
        <button
          type="button"
          className="cxms-provider-toggle"
          aria-expanded={effectiveExpanded}
          aria-controls={contentId}
          disabled={!canExpand}
          onClick={() => onExpandedChange(!effectiveExpanded)}
        >
          <span className="cxms-disclosure-mark" aria-hidden="true" />
          {provider.selectorBrand
            ? <ModelBrandIcon brand={provider.selectorBrand} kind="provider" />
            : <HostBrandIcon icon={provider.icon} />}
          <span className="cxms-provider-identity">
            <strong>{provider.title}</strong>
            {provider.title.toLocaleLowerCase() === provider.providerId.toLocaleLowerCase()
              ? null
              : <code>{provider.providerId}</code>}
          </span>
          <span className="cxms-model-count">
            {canExpand ? `${modelsLabel}: ${provider.models.length}` : emptyLabel}
          </span>
        </button>
      </header>
      <div id={contentId} hidden={!effectiveExpanded}>
        {readOnly ? <p className="cxmc-muted">{readOnly}</p> : null}
        <ul aria-label={`${provider.title} · ${modelsLabel}`}>
          {provider.models.slice(0, rows.limit).map(model => (
            <li key={model.id}>
              <ModelBrandIcon brand={model.selectorBrand ?? inferModelBrand(model.id, model.label)} kind="model" />
              <span className="cxms-model-identity">
                <strong>{model.label}</strong>
                {model.label.toLocaleLowerCase() === model.id.toLocaleLowerCase() ? null : <code>{model.id}</code>}
              </span>
              {model.group ? <small>{model.group}</small> : null}
            </li>
          ))}
          {rows.sentinel ? <li ref={rows.sentinel} className="cxms-list-sentinel" aria-hidden="true" /> : null}
        </ul>
      </div>
    </section>
  )
}
