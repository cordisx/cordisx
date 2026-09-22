import { useState } from 'react'
import { Button, Checkbox } from 'tdesign-react'
import { CatalogInput } from './CatalogInput.js'
import type {
  CatalogEditableModel,
  CatalogManagementResult,
  CatalogManagementView,
} from '../../../../model-catalog-management.js'
import { IconButton } from '../../../host-ui/IconButton.js'
import { managerCopy } from '../../../ui-copy.js'

export function validModels(models: readonly CatalogEditableModel[]): boolean {
  return models.length <= 10_000 && new Set(models.map(model => model.id)).size === models.length
    && models.every(model =>
      model.id.trim().length > 0 && model.id.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(model.id)
      && (model.label === undefined || model.label.trim().length > 0 && model.label.length <= 256
          && !/[\u0000-\u001f\u007f]/u.test(model.label))
      && (model.protocolCapabilities === undefined
        || typeof model.protocolCapabilities.responses === 'boolean')
    )
}

export function ModelEditor({ view, locale, mode, save, close }: {
  readonly view: CatalogManagementView
  readonly locale: string
  readonly mode: 'manual' | 'supplement'
  readonly save: (models: readonly CatalogEditableModel[], revision: string) => Promise<CatalogManagementResult>
  readonly close: () => void
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const live = mode === 'supplement' ? view.supplement : view.rows.filter(row => row.present)
  const [draft, setDraft] = useState(() =>
    live.map((model, key) => ({
      key,
      id: model.id,
      label: model.label === model.id ? '' : model.label ?? '',
      ...(model.protocolCapabilities ? { protocolCapabilities: model.protocolCapabilities } : {}),
    }))
  )
  const [nextKey, setNextKey] = useState(draft.length)
  const [revision, setRevision] = useState(view.revision)
  const [scope] = useState(view.scopeRevision)
  const [emptyConfirmed, setEmptyConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const changed = revision !== view.revision
  const scopeChanged = scope !== view.scopeRevision
  const models = draft.map(item => ({
    id: item.id,
    ...(item.label === '' ? {} : { label: item.label }),
    ...(item.protocolCapabilities ? { protocolCapabilities: item.protocolCapabilities } : {}),
  }))
  const valid = validModels(models)
  const update = (key: number, field: 'id' | 'label', value: string) => {
    setDraft(draft.map(item => item.key === key ? { ...item, [field]: value } : item))
    setEmptyConfirmed(false)
  }
  const submit = async () => {
    if (busy || !valid || scopeChanged || changed || models.length === 0 && !emptyConfirmed) return
    setBusy(true)
    setFailed(false)
    const result = await save(models, revision)
    setBusy(false)
    if (result.status === 'applied') close()
    else setFailed(true)
  }
  return (
    <section
      className="cxmc-editor"
      aria-label={t(mode === 'manual' ? 'catalog.editManual' : 'catalog.editSupplement')}
    >
      <h3>{t(mode === 'manual' ? 'catalog.editManual' : 'catalog.editSupplement')}</h3>
      <div className="cxmc-editor-models">
        {draft.map((model, index) => (
          <div className="cxmc-editor-row" key={model.key}>
            <CatalogInput
              label={`${t('catalog.id')} ${index + 1}`}
              value={model.id}
              maxlength={512}
              onChange={value => update(model.key, 'id', value)}
            />
            <CatalogInput
              label={`${t('catalog.label')} ${index + 1}`}
              value={model.label}
              maxlength={256}
              onChange={value => update(model.key, 'label', value)}
            />
            <IconButton
              tag="button"
              icon="delete"
              label={`${t('catalog.removeModel')}: ${model.id || index + 1}`}
              disabled={busy}
              onClick={() => {
                setDraft(draft.filter(item => item.key !== model.key))
                setEmptyConfirmed(false)
              }}
            />
          </div>
        ))}
      </div>
      <IconButton
        tag="button"
        icon="add"
        label={t('catalog.addModel')}
        disabled={busy || draft.length >= 10_000}
        onClick={() => {
          setDraft([...draft, { key: nextKey, id: '', label: '' }])
          setNextKey(nextKey + 1)
        }}
      />
      {models.length === 0
        ? <Checkbox checked={emptyConfirmed} onChange={setEmptyConfirmed}>{t('catalog.emptyConfirm')}</Checkbox>
        : null}
      {!valid ? <p role="status">{t('catalog.invalid')}</p> : null}
      {scopeChanged
        ? <p role="status">{t('catalog.scopeChanged')}</p>
        : changed
        ? (
          <div className="cxmc-conflict" role="status">
            <p>{t('catalog.conflict')}</p>
            <details>
              <summary>{t('catalog.latest')}</summary>
              <ul>
                {live.map(model => (
                  <li key={model.id}>
                    <code>{model.id}</code>
                  </li>
                ))}
              </ul>
            </details>
            <Button
              tag="button"
              variant="outline"
              onClick={() => {
                setRevision(view.revision)
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
        <Button tag="button" variant="outline" onClick={close} disabled={busy}>{t('catalog.cancel')}</Button>
        <Button
          tag="button"
          theme="primary"
          onClick={() => void submit()}
          loading={busy}
          disabled={!valid || changed || scopeChanged || models.length === 0 && !emptyConfirmed}
        >
          {t('catalog.save')}
        </Button>
      </footer>
    </section>
  )
}
