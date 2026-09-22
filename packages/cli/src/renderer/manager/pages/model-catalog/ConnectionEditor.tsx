import { useState } from 'react'
import { Button, Checkbox, Switch, Textarea } from 'tdesign-react'
import { CatalogInput } from './CatalogInput.js'
import type {
  CatalogConnectionSettings,
  CatalogManagementResult,
  CatalogManagementView,
} from '../../../../model-catalog-management.js'
import { SelectField } from '../../../host-ui/SelectField.js'
import { managerCopy } from '../../../ui-copy.js'
import { validModels } from './ModelEditor.js'

export function ConnectionEditor({ view, locale, save, close }: {
  readonly view?: CatalogManagementView | undefined
  readonly locale: string
  readonly save: (settings: CatalogConnectionSettings, revision?: string) => Promise<CatalogManagementResult>
  readonly close: () => void
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const initial = view?.connection
  const [title, setTitle] = useState(initial?.title ?? '')
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '')
  const [protocol, setProtocol] = useState<CatalogConnectionSettings['protocol']>(
    initial?.protocol ?? 'responses',
  )
  const [source, setSource] = useState(initial?.strategy.kind === 'auto' ? initial.strategy.mode : 'manual')
  const [discoveryEnabled, setDiscoveryEnabled] = useState(initial?.discoveryEnabled ?? false)
  const [ids, setIds] = useState(initial?.strategy.kind === 'manual' ? initial.strategy.ids.join('\n') : '')
  const [emptyConfirmed, setEmptyConfirmed] = useState(false)
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
  const valid = title.trim().length > 0 && title.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(title)
    && endpoint.length <= 2048 && validEndpoint && (source !== 'manual' || validModels(modelIds.map(id => ({ id }))))
  const submit = async () => {
    if (busy || !valid || changed || scopeChanged || source === 'manual' && modelIds.length === 0 && !emptyConfirmed) {
      return
    }
    setBusy(true)
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
    setBusy(false)
    if (result.status === 'applied') close()
    else setFailed(true)
  }
  return (
    <section className="cxmc-editor" aria-label={t(view ? 'catalog.editConnection' : 'catalog.addConnection')}>
      <h3>{t(view ? 'catalog.editConnection' : 'catalog.addConnection')}</h3>
      <div className="cxmc-connection-fields">
        <label>
          <span>{t('catalog.title')}</span>
          <CatalogInput value={title} label={t('catalog.title')} maxlength={128} onChange={setTitle} />
        </label>
        <label>
          <span>{t('catalog.endpoint')}</span>
          <CatalogInput value={endpoint} label={t('catalog.endpoint')} maxlength={2048} onChange={setEndpoint} />
        </label>
        <label>
          <span>{t('catalog.protocol')}</span>
          <SelectField
            icon="configuration"
            label={t('catalog.protocol')}
            value={protocol}
            options={[{ value: 'chat-completions', label: 'Chat Completions' }, {
              value: 'responses',
              label: 'Responses',
            }]}
            onChange={value => setProtocol(value as CatalogConnectionSettings['protocol'])}
          />
        </label>
        <label>
          <span>{t('catalog.source')}</span>
          <SelectField
            icon="models-read"
            label={t('catalog.source')}
            value={source}
            options={[{ value: 'manual', label: t('catalog.manualReplace') }, {
              value: 'only',
              label: t('catalog.autoOnly'),
            }, { value: 'augment', label: t('catalog.autoAugment') }]}
            onChange={setSource}
          />
        </label>
        {source === 'manual'
          ? (
            <label>
              <span>{t('catalog.id')}</span>
              <Textarea
                value={ids}
                placeholder=""
                aria-label={t('catalog.id')}
                autosize={{ minRows: 3, maxRows: 8 }}
                onChange={value => {
                  setIds(value)
                  setEmptyConfirmed(false)
                }}
              />
            </label>
          )
          : (
            <label>
              <span>{t('catalog.discoveryGrant')}</span>
              <Switch
                value={discoveryEnabled}
                aria-label={t('catalog.discoveryGrant')}
                onChange={setDiscoveryEnabled}
              />
            </label>
          )}
      </div>
      {source === 'manual' && modelIds.length === 0
        ? <Checkbox checked={emptyConfirmed} onChange={setEmptyConfirmed}>{t('catalog.emptyConfirm')}</Checkbox>
        : null}
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
          disabled={!valid || changed || scopeChanged
            || source === 'manual' && modelIds.length === 0 && !emptyConfirmed}
          onClick={() => void submit()}
        >
          {t('catalog.save')}
        </Button>
      </footer>
    </section>
  )
}
