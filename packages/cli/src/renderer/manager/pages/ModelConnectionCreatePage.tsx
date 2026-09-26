import { useSyncExternalStore } from 'react'
import type { ModelProviderRegistry } from '../../model-providers.js'
import type { CatalogClientState } from '../../model-catalog-client.js'
import { managerCopy } from '../../ui-copy.js'
import { ConnectionEditor } from './model-catalog/ConnectionEditor.js'
import css from './model-catalog/model-catalog.css?inline'

const empty: CatalogClientState = { epoch: '', sequence: 0, views: [], connected: false, loading: false }
const noop = () => () => {}

export function ModelConnectionCreatePage({ registry, locale, close }: {
  readonly registry: ModelProviderRegistry | undefined
  readonly locale: string
  readonly close: () => void
}) {
  const client = registry?.management
  const state = useSyncExternalStore(client?.subscribe ?? noop, client?.snapshot ?? (() => empty))
  const available = !!client && state.connected && state.canCreateConnection === true
  return (
    <section className="cxr-page" data-model-connection-create="true">
      <style>{css}</style>
      {!available ? <p role="status">{managerCopy(locale, 'catalog.managementUnavailable')}</p> : null}
      <ConnectionEditor
        standalone
        locale={locale}
        disabled={!available}
        close={close}
        save={settings =>
          client
            ? client.command({ operation: 'createConnection', settings })
            : Promise.resolve({ status: 'unavailable', code: 'unavailable' })}
      />
    </section>
  )
}
