import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelProviderRegistry, ModelProviderSnapshot } from '../../model-providers.js'
import { ModelServicesIllustration } from '../../host-ui/ModelServicesIllustration.js'
import { EmptyState } from '../../host-ui/EmptyState.js'
import { HostBrandIcon } from '../../host-ui/HostBrandIcon.js'
import { ModelBrandIcon } from '../../host-ui/ModelBrandIcon.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { HostMenuSurface } from '../../host-ui/HostMenu.js'
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

const empty: ModelProviderSnapshot = { providers: [], entries: [], loading: false }
const noop = () => () => {}
const emptyCatalog: CatalogClientState = { epoch: '', sequence: 0, views: [], connected: false, loading: false }

export function ModelServicesPage({ registry, locale, onCreate }: {
  readonly registry: ModelProviderRegistry | undefined
  readonly locale: string
  readonly onCreate?: (() => void) | undefined
}) {
  const state = useSyncExternalStore(registry?.subscribe ?? noop, registry?.snapshot ?? (() => empty))
  const client = registry?.management
  const catalog = useSyncExternalStore(client?.subscribe ?? noop, client?.snapshot ?? (() => emptyCatalog))
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ReadonlySet<CatalogFilter>>(() => new Set(['selectable']))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
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
  const views = catalog.views
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
    <section className="cxr-page cxmp-management" data-catalog-management={managementState}>
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
            <IconButton
              tag="button"
              icon="reload-plugin"
              label={copy.refresh}
              disabled={!registry || refreshing}
              aria-busy={refreshing}
              onClick={() => {
                void registry?.refresh()
                void client?.refresh()
              }}
            />
          </>
        }
      />
      <div
        className="cxmp-results"
        aria-busy={refreshing}
        data-empty-layout={noConnections && !failed && !unavailable ? 'hero' : undefined}
      >
        {state.entries.length === 0 ? null : (
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
            />
          ))
          : null}
        {providers.map(({ provider, sourceModelCount }) => (
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
        {(noConnections && (loading || !failed && !unavailable)
            || (noMatches || noFilterMatches) && !loading && !failed)
          ? (
            <EmptyState
              icon="models-read"
              state={loading ? 'loading' : noMatches || noFilterMatches ? 'search' : 'empty'}
              title={t(
                loading ? 'empty.modelsLoading' : noMatches || noFilterMatches ? 'empty.modelMatches' : 'empty.models',
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
