import { useMemo, useState } from 'react'
import { SchemaForm, schemaFormSnapshot } from '../../../host-ui/SchemaForm.js'
import { type ConnectionDraft, connectionSchema } from './connection-schema.js'
import { Button } from 'tdesign-react'
import type {
  CatalogConnectionSettings,
  CatalogManagementResult,
  CatalogManagementView,
} from '../../../../model-catalog-management.js'
import { managerCopy } from '../../../ui-copy.js'
import { validModels } from './ModelEditor.js'

export function ConnectionEditor({ view, locale, save, close, standalone = false, disabled = false }: {
  readonly standalone?: boolean
  readonly disabled?: boolean
  readonly view?: CatalogManagementView | undefined
  readonly locale: string
  readonly save: (settings: CatalogConnectionSettings, revision?: string) => Promise<CatalogManagementResult>
  readonly close: () => void
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const initial = view?.connection
  const [draft, setDraft] = useState<ConnectionDraft>(() => ({
    title: initial?.title ?? '',
    endpoint: initial?.endpoint ?? '',
    protocol: initial?.protocol ?? 'responses',
    source: initial?.strategy.kind === 'auto' ? initial.strategy.mode : 'manual',
    discoveryEnabled: initial?.discoveryEnabled ?? false,
    ids: initial?.strategy.kind === 'manual' ? initial.strategy.ids.join('\n') : '',
    emptyConfirmed: false,
  }))
  const { title, endpoint, protocol, source, discoveryEnabled, ids, emptyConfirmed } = draft
  const schema = useMemo(() => connectionSchema(locale, draft), [locale, source, ids])
  const schemaValid = schemaFormSnapshot(schema, draft, locale).valid
  const [revision, setRevision] = useState(view?.revision)
  const [scope] = useState(view?.scopeRevision)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const scopeChanged = view?.scopeRevision !== scope
  const changed = view?.revision !== revision
  const modelIds = ids === '' ? [] : ids.split('\n')
  let validEndpoint = false
  try {
    const url = new URL(endpoint)
    validEndpoint = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !/[\\?#\u0000-\u0020\u007f]/u.test(endpoint)
  } catch { /* An incomplete URL is ordinary form state. */ }
  const valid = schemaValid && title.trim().length > 0 && title.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(title)
    && endpoint.length <= 2048 && validEndpoint && (source !== 'manual' || validModels(modelIds.map(id => ({ id }))))
  const submit = async () => {
    if (
      disabled || busy || !valid || changed || scopeChanged
      || source === 'manual' && modelIds.length === 0 && !emptyConfirmed
    ) {
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      const result = await save({
        title,
        endpoint,
        protocol,
        discoveryEnabled,
        strategy: source === 'manual'
          ? { kind: 'manual', ids: modelIds }
          : {
            kind: 'auto',
            adapter: 'detect',
            ttlMs: initial?.strategy.kind === 'auto' ? initial.strategy.ttlMs : 3_600_000,
            mode: source === 'augment' ? 'augment' : 'only',
          },
      }, revision)
      if (result.status === 'applied') close()
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className={standalone ? 'cxmc-connection-page' : 'cxmc-editor'}
      aria-label={t(view ? 'catalog.editConnection' : 'catalog.addConnection')}
    >
      {standalone ? null : <h3>{t(view ? 'catalog.editConnection' : 'catalog.addConnection')}</h3>}
      <SchemaForm
        identity={view?.bindingRef ?? 'new-model-connection'}
        schema={schema}
        value={draft}
        locale={locale}
        disabled={busy || disabled}
        onChange={({ value }) => {
          const next = value as ConnectionDraft
          setDraft({ ...next, emptyConfirmed: next.ids !== ids ? false : next.emptyConfirmed })
        }}
      />
      {!valid && (title !== '' || endpoint !== '') ? <p role="status">{t('catalog.connectionInvalid')}</p> : null}
      {scopeChanged ? <p role="status">{t('catalog.scopeChanged')}</p> : changed
        ? (
          <div role="status">
            <p>{t('catalog.conflict')}</p>
            <code>{view?.connection?.endpoint}</code>
            <Button
              tag="button"
              variant="outline"
              onClick={() => {
                setRevision(view?.revision)
                setFailed(false)
              }}
            >
              {t('catalog.reviewed')}
            </Button>
          </div>
        )
        : failed
        ? <p role="status">{t('catalog.failed')}</p>
        : null}
      <footer className="cxmc-editor-actions">
        <Button tag="button" variant="outline" disabled={busy} onClick={close}>{t('catalog.cancel')}</Button>
        <Button
          tag="button"
          theme="primary"
          loading={busy}
          disabled={disabled || !valid || changed || scopeChanged
            || source === 'manual' && modelIds.length === 0 && !emptyConfirmed}
          onClick={() => void submit()}
        >
          {t('catalog.save')}
        </Button>
      </footer>
    </section>
  )
}
