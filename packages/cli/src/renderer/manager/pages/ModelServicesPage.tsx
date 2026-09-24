import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ModelProviderRegistry, ModelProviderSnapshot } from '../../model-providers.js'
import { HostBrandIcon } from '../../host-ui/HostBrandIcon.js'
import { ModelBrandIcon } from '../../host-ui/ModelBrandIcon.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { ProviderAction } from '../../model-provider-actions.js'
import { modelProviderCopy } from '../../model-provider-copy.js'
import css from '../../model-providers.css?inline'
import pageCss from './model-services.css?inline'
import catalogCss from './model-catalog/model-catalog.css?inline'
import { CatalogBinding, type CatalogFilter, catalogQuery } from './model-catalog/CatalogBinding.js'
import { ConnectionEditor } from './model-catalog/ConnectionEditor.js'
import { SelectField } from '../../host-ui/SelectField.js'
import { managerCopy } from '../../ui-copy.js'
import type { CatalogClientState } from '../../model-catalog-client.js'

const empty: ModelProviderSnapshot = { providers: [], entries: [], loading: false }
const noop = () => () => {}
const emptyCatalog: CatalogClientState = { epoch: '', sequence: 0, views: [], connected: false, loading: false }

export function ModelServicesPage({ registry, locale }: {
  readonly registry: ModelProviderRegistry | undefined
  readonly locale: string
}) {
  const state = useSyncExternalStore(registry?.subscribe ?? noop, registry?.snapshot ?? (() => empty))
  const client = registry?.management
  const catalog = useSyncExternalStore(client?.subscribe ?? noop, client?.snapshot ?? (() => emptyCatalog))
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const [creating, setCreating] = useState(false)
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
    if (managedIds.has(provider.providerId) || filter === 'blocked' || filter === 'removed') return []
    const matchesProvider = catalogQuery(`${provider.providerId} ${provider.title}`).includes(normalized)
    const models = provider.models.filter(model =>
      matchesProvider || catalogQuery(`${model.id} ${model.label}`).includes(normalized)
    )
    return matchesProvider || models.length > 0 ? [{ ...provider, models }] : []
  })
  const views = catalog.views.filter(view =>
    catalogQuery(
      `${view.title} ${view.providerId} ${view.scopeLabel ?? ''} ${
        view.rows.map(row => `${row.id} ${row.label}`).join(' ')
      }`,
    )
      .includes(normalized)
  )
  return (
    <section className="cxr-page cxmp-management" data-catalog-management={managementState}>
      <style>{`${css}\n${pageCss}\n${catalogCss}`}</style>
      <div className="cxmp-toolbar">
        <SearchField
          className="cxr-search"
          value={query}
          onChange={setQuery}
          aria-label={copy.search}
          placeholder={copy.search}
        />
        <SelectField
          label={t('catalog.filter')}
          icon="models-read"
          value={filter}
          disabled={!client}
          options={(['all', 'selectable', 'blocked', 'removed'] as const).map(value => ({
            value,
            label: t(`catalog.${value}`),
          }))}
          onChange={value => setFilter(value as CatalogFilter)}
        />
        {catalog.canCreateConnection && client
          ? (
            <IconButton
              tag="button"
              icon="add"
              label={t('catalog.addConnection')}
              disabled={!catalog.connected}
              onClick={() => setCreating(true)}
            />
          )
          : null}
        <IconButton
          tag="button"
          icon="reload-plugin"
          label={copy.refresh}
          disabled={!registry || state.loading}
          onClick={() => {
            void registry?.refresh()
            void client?.refresh()
          }}
        />
      </div>
      <div className="cxmp-results" aria-busy={state.loading}>
        {creating && client
          ? (
            <ConnectionEditor
              locale={locale}
              close={() => setCreating(false)}
              save={settings => client.command({ operation: 'createConnection', settings })}
            />
          )
          : null}
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
        {state.error || !registry ? <p role="alert">{copy.unavailable}</p> : null}
        {registry && managementState !== 'loading' && !catalog.connected && catalog.views.length === 0
          ? <p role="status">{t('catalog.managementUnavailable')}</p>
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
              filter={filter}
              connected={catalog.connected}
            />
          ))
          : null}
        {providers.map(provider => (
          <details
            className="cxmp-provider-detail cxms-provider"
            key={provider.providerId}
            data-catalog-binding={catalog.connected ? 'unbound' : managementState}
            open
          >
            <summary>
              {provider.selectorBrand
                ? <ModelBrandIcon brand={provider.selectorBrand} kind="provider" />
                : <HostBrandIcon icon={provider.icon} />}
              <span className="cxms-provider-identity">
                <strong>{provider.title}</strong>
                {provider.title.toLocaleLowerCase() === provider.providerId.toLocaleLowerCase()
                  ? null
                  : <code>{provider.providerId}</code>}
              </span>
              <span className="cxms-model-count">{copy.models}: {provider.models.length}</span>
            </summary>
            {catalog.connected ? <p className="cxmc-muted">{t('catalog.readOnly')}</p> : null}
            <ul aria-label={`${provider.title} · ${copy.models}`}>
              {provider.models.map(model => (
                <li key={model.id}>
                  <span className="cxms-model-identity">
                    <strong>{model.label}</strong>
                    {model.label.toLocaleLowerCase() === model.id.toLocaleLowerCase() ? null : <code>{model.id}</code>}
                  </span>
                  {model.group ? <small>{model.group}</small> : null}
                </li>
              ))}
            </ul>
          </details>
        ))}
        {providers.length === 0 && views.length === 0 && !state.error
          ? <p className="cxr-empty">{copy.empty}</p>
          : null}
      </div>
    </section>
  )
}
