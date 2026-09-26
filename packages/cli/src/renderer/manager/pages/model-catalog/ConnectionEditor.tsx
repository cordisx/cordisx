import { useEffect, useMemo, useRef, useState } from 'react'
import { HostSchemaFormPage, schemaFormSnapshot } from '../../../host-ui/SchemaForm.js'
import { type ConnectionDraft, connectionSchema } from './connection-schema.js'
import { Button } from 'tdesign-react'
import type {
  CatalogConnectionSettings,
  CatalogManagementResult,
  CatalogManagementView,
} from '../../../../model-catalog-management.js'
import { managerCopy } from '../../../ui-copy.js'
import { validModels } from './ModelEditor.js'

export function ConnectionEditor(
  { view, locale, save, close, standalone = false, disabled = false, responsesOnly = false }: {
    readonly responsesOnly?: boolean
    readonly standalone?: boolean
    readonly disabled?: boolean
    readonly view?: CatalogManagementView | undefined
    readonly locale: string
    readonly save: (settings: CatalogConnectionSettings, revision?: string) => Promise<CatalogManagementResult>
    readonly close: () => void
  },
) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const initial = view?.connection
  // Existing connection edits keep their declared protocol, including legacy values.
  const fixedResponses = responsesOnly && view === undefined
  const [draft, setDraft] = useState<ConnectionDraft>(() => ({
    title: initial?.title ?? '',
    endpoint: initial?.endpoint ?? '',
    protocol: initial?.protocol ?? 'responses',
    source: initial?.strategy.kind === 'auto' ? initial.strategy.mode : 'manual',
    discoveryEnabled: initial?.discoveryEnabled ?? false,
    models: initial?.strategy.kind === 'manual'
      ? [
        ...(initial.models ?? initial.strategy.ids.map(id => {
          const row = view?.rows.find(model => model.id === id)
          return {
            id,
            label: row?.label === id ? '' : row?.label ?? '',
            ...(row?.protocolCapabilities ? { protocolCapabilities: row.protocolCapabilities } : {}),
          }
        })),
      ]
      : [],
    emptyConfirmed: false,
  }))
  const { title, endpoint, protocol, source, discoveryEnabled, models, emptyConfirmed } = draft
  const schema = useMemo(() => connectionSchema(locale, draft, fixedResponses), [
    locale,
    source,
    models.length === 0,
    fixedResponses,
  ])
  const schemaValid = schemaFormSnapshot(schema, draft, locale).valid
  const [revision, setRevision] = useState(view?.revision)
  const [scope] = useState(view?.scopeRevision)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const scopeChanged = view?.scopeRevision !== scope
  const changed = view?.revision !== revision
  const editableModels = models.map(model => ({
    id: model.id,
    ...(model.label ? { label: model.label } : {}),
    ...(model.protocolCapabilities ? { protocolCapabilities: model.protocolCapabilities } : {}),
  }))
  const modelIds = models.map(model => model.id)
  let validEndpoint = false
  try {
    const url = new URL(endpoint)
    validEndpoint = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !/[\\?#\u0000-\u0020\u007f]/u.test(endpoint)
  } catch { /* An incomplete URL is ordinary form state. */ }
  const valid = schemaValid && title.trim().length > 0 && title.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(title)
    && endpoint.length <= 2048 && validEndpoint && (source !== 'manual' || validModels(editableModels))
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
        protocol: fixedResponses ? 'responses' : protocol,
        discoveryEnabled,
        ...(source === 'manual' ? { models: editableModels } : {}),
        strategy: source === 'manual'
          ? { kind: 'manual', ids: modelIds }
          : {
            kind: 'auto',
            adapter: 'detect',
            ttlMs: initial?.strategy.kind === 'auto' ? initial.strategy.ttlMs : 3_600_000,
            mode: source === 'augment' ? 'augment' : 'only',
          },
      }, revision)
      if (!mounted.current) return
      if (result.status === 'applied') close()
      else setFailed(true)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section
      className={standalone ? 'cxf-form-surface' : 'cxmc-editor'}
      aria-label={t(view ? 'catalog.editConnection' : 'catalog.addConnection')}
    >
      {standalone ? null : <h3>{t(view ? 'catalog.editConnection' : 'catalog.addConnection')}</h3>}
      <HostSchemaFormPage
        form={{
          identity: view?.bindingRef ?? 'new-model-connection',
          schema,
          value: draft,
          locale,
          disabled: busy || disabled,
          onChange: ({ value }) => {
            const next = value as ConnectionDraft
            setDraft({
              ...next,
              emptyConfirmed: JSON.stringify(next.models) !== JSON.stringify(models) ? false : next.emptyConfirmed,
            })
          },
        }}
        footer={
          <div className="cxf-form-action-buttons cxmc-editor-actions">
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
          </div>
        }
      >
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
      </HostSchemaFormPage>
    </section>
  )
}
