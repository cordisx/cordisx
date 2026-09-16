import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ModelProviderRegistry, ModelProviderSnapshot } from '../../model-providers.js'
import { HostBrandIcon } from '../../host-ui/HostBrandIcon.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { ProviderAction } from '../../model-provider-actions.js'
import { modelProviderCopy } from '../../model-provider-copy.js'
import css from '../../model-providers.css?inline'
import pageCss from './model-services.css?inline'

const empty: ModelProviderSnapshot = { providers: [], entries: [], loading: false }
const noop = () => () => {}

export function ModelServicesPage({ registry, locale }: {
  readonly registry: ModelProviderRegistry | undefined
  readonly locale: string
}) {
  const state = useSyncExternalStore(registry?.subscribe ?? noop, registry?.snapshot ?? (() => empty))
  const [query, setQuery] = useState('')
  const copy = modelProviderCopy(locale)
  useEffect(() => {
    void registry?.refresh()
  }, [registry])
  const normalized = query.trim().toLocaleLowerCase()
  const providers = state.providers.filter(provider =>
    `${provider.providerId} ${provider.title} ${provider.models.map(model => `${model.id} ${model.label}`).join(' ')}`
      .toLocaleLowerCase().includes(normalized)
  )
  return (
    <section className="cxr-page cxmp-management">
      <style>{`${css}\n${pageCss}`}</style>
      <div className="cxmp-toolbar">
        <SearchField
          className="cxr-search"
          value={query}
          onChange={setQuery}
          aria-label={copy.search}
          placeholder={copy.search}
        />
        <IconButton
          icon="reload-plugin"
          label={copy.refresh}
          disabled={!registry || state.loading}
          onClick={() => {
            void registry?.refresh()
          }}
        />
      </div>
      <div className="cxmp-results" aria-busy={state.loading}>
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
        {providers.map(provider => (
          <details className="cxmp-provider-detail cxms-provider" key={provider.providerId} open>
            <summary>
              <HostBrandIcon icon={provider.icon} />
              <span className="cxms-provider-identity">
                <strong>{provider.title}</strong>
                {provider.title.toLocaleLowerCase() === provider.providerId.toLocaleLowerCase()
                  ? null
                  : <code>{provider.providerId}</code>}
              </span>
              <span className="cxms-model-count">{copy.models}: {provider.models.length}</span>
            </summary>
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
        {providers.length === 0 && !state.error ? <p className="cxr-empty">{copy.empty}</p> : null}
      </div>
    </section>
  )
}
