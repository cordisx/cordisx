import type { SchemaFormOptionsV1 } from '@cordisx/protocol/schema-form/v1'
import Schema from '@deepseek-ai/schemastery'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'tdesign-react'
import type { CordisXConfigFormIcon } from '../../../../contracts.js'
import type {
  ModelServiceInput,
  ModelServiceProtocol,
  ModelServicesReadResult,
  ModelServiceView,
} from '../../../../model-service-contracts.js'
import { HostSchemaFormPage, schemaFormSnapshot } from '../../../host-ui/SchemaForm.js'
import type { ModelCatalogClient } from '../../../model-catalog-client.js'
import { managerCopy } from '../../../ui-copy.js'

/**
 * The top-level `model-service` declarations in the CordisX home config: one
 * list for both apps. CordisX writes them into Codex and Claude when it starts
 * them, so a change applies on the next launch.
 */

interface Draft extends Record<string, unknown> {
  id: string
  displayName: string
  baseUrl: string
  forCodex: boolean
  forClaude: boolean
  codexModels: string
  claudeModels: string
  apiKey: string
  enabled: boolean
}

const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const VISIBLE_TEXT = /^[^\u0000-\u001f\u007f]*\S[^\u0000-\u001f\u007f]*$/u

function draftOf(service: ModelServiceView | undefined): Draft {
  return {
    id: service?.id ?? '',
    displayName: service?.displayName ?? '',
    baseUrl: service?.baseUrl ?? '',
    forCodex: service?.protocols.includes('openai-responses') ?? true,
    forClaude: service?.protocols.includes('anthropic-messages') ?? true,
    codexModels: service?.codexModels.join(', ') ?? '',
    claudeModels: service?.claudeModels.join(', ') ?? '',
    apiKey: '',
    enabled: service?.enabled ?? true,
  }
}

const ids = (value: string): string[] => value.split(/[,\n]/u).map(item => item.trim()).filter(Boolean)

function inputOf(service: ModelServiceView): ModelServiceInput {
  return {
    id: service.id,
    displayName: service.displayName,
    baseUrl: service.baseUrl,
    protocols: [...service.protocols],
    codexModels: [...service.codexModels],
    claudeModels: [...service.claudeModels],
    enabled: service.enabled,
  }
}

function inputFromDraft(draft: Draft): ModelServiceInput {
  const protocols: ModelServiceProtocol[] = []
  if (draft.forCodex) protocols.push('openai-responses')
  if (draft.forClaude) protocols.push('anthropic-messages')
  return {
    id: draft.id.trim(),
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
    protocols,
    codexModels: draft.forCodex ? ids(draft.codexModels) : [],
    claudeModels: draft.forClaude ? ids(draft.claudeModels) : [],
    enabled: draft.enabled,
    ...(draft.apiKey.trim() === '' ? {} : { apiKey: draft.apiKey.trim() }),
  }
}

function validDraft(draft: Draft): boolean {
  let https = false
  try {
    const url = new URL(draft.baseUrl.trim())
    https = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch { /* An incomplete URL is ordinary form state. */ }
  return SERVICE_ID.test(draft.id.trim()) && VISIBLE_TEXT.test(draft.displayName) && https
    && (draft.forCodex || draft.forClaude)
}

function serviceSchema(locale: string, draft: Draft, creating: boolean) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const field = (text: string, icon: CordisXConfigFormIcon, description?: string) => ({
    label: text,
    ...(description === undefined ? {} : { description }),
    cordisxForm: { icon },
  })
  return Schema.object({
    ...(creating
      ? {
        id: Schema.string().required().min(1).max(96).pattern(SERVICE_ID)
          .extra('extra', field(t('catalog.sharedServiceId'), 'host:key')),
      }
      : {}),
    displayName: Schema.string().required().min(1).max(200).pattern(VISIBLE_TEXT)
      .extra('extra', field(t('catalog.title'), 'host:tags')),
    baseUrl: Schema.string().required().min(1).max(2048).role('url')
      .extra('extra', field(t('catalog.endpoint'), 'host:info')),
    forCodex: Schema.boolean().role('switch').extra(
      'extra',
      field(t('catalog.sharedServiceForCodex'), 'host:settings'),
    ),
    ...(draft.forCodex
      ? {
        codexModels: Schema.string().max(16_384).default('')
          .extra(
            'extra',
            field(t('catalog.sharedServiceCodexModels'), 'host:files', t('catalog.sharedServiceModelsHint')),
          ),
      }
      : {}),
    forClaude: Schema.boolean().role('switch')
      .extra('extra', field(t('catalog.sharedServiceForClaude'), 'host:settings')),
    ...(draft.forClaude
      ? {
        claudeModels: Schema.string().max(16_384).default('')
          .extra(
            'extra',
            field(t('catalog.sharedServiceClaudeModels'), 'host:files', t('catalog.sharedServiceModelsHint')),
          ),
      }
      : {}),
    apiKey: Schema.string().max(16_384).default('').role('secret')
      .extra(
        'extra',
        field(t('catalog.sharedServiceKey'), 'host:key', creating ? undefined : t('catalog.sharedServiceKeyKeep')),
      ),
    enabled: Schema.boolean().role('switch').extra('extra', field(t('catalog.sharedServiceEnabled'), 'host:save')),
  }) as unknown as SchemaFormOptionsV1['schema']
}

function ServiceEditor({ service, locale, save, close }: {
  readonly service: ModelServiceView | undefined
  readonly locale: string
  readonly save: (input: ModelServiceInput) => Promise<string | undefined>
  readonly close: () => void
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const creating = service === undefined
  const [draft, setDraft] = useState<Draft>(() => draftOf(service))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const schema = useMemo(() => serviceSchema(locale, draft, creating), [
    locale,
    creating,
    draft.forCodex,
    draft.forClaude,
  ])
  const valid = schemaFormSnapshot(schema, draft, locale).valid && validDraft(draft)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])
  const submit = async () => {
    if (busy || !valid) return
    setBusy(true)
    setFailure(undefined)
    const error = await save(inputFromDraft(draft))
    if (!mounted.current) return
    setBusy(false)
    if (error === undefined) close()
    else setFailure(error)
  }
  return (
    <section
      className="cxmc-editor"
      aria-label={t(creating ? 'catalog.sharedServiceAdd' : 'catalog.sharedServiceEdit')}
    >
      <h3>{t(creating ? 'catalog.sharedServiceAdd' : 'catalog.sharedServiceEdit')}</h3>
      <HostSchemaFormPage
        form={{
          identity: `shared-model-service:${service?.id ?? 'new'}`,
          schema,
          value: draft,
          locale,
          disabled: busy,
          onChange: ({ value }) => setDraft(value as Draft),
        }}
        footer={
          <div className="cxf-form-action-buttons cxmc-editor-actions">
            <Button tag="button" variant="outline" disabled={busy} onClick={close}>{t('catalog.cancel')}</Button>
            <Button tag="button" theme="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
              {t('catalog.save')}
            </Button>
          </div>
        }
      >
        {!valid && (draft.id !== '' || draft.baseUrl !== '')
          ? <p role="status">{t('catalog.sharedServiceInvalid')}</p>
          : null}
        {failure === undefined ? null : <p role="status">{failure}</p>}
      </HostSchemaFormPage>
    </section>
  )
}

export function SharedModelServices({ client, locale }: {
  readonly client: ModelCatalogClient | undefined
  readonly locale: string
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const [state, setState] = useState<ModelServicesReadResult | undefined>()
  const [editing, setEditing] = useState<{ readonly id?: string } | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const available = client?.modelServicesAvailable === true
  const reload = useCallback(async () => {
    if (!client || !available) return
    setState(await client.modelServicesRead())
  }, [client, available])
  useEffect(() => {
    void reload()
  }, [reload])
  if (!available || state === undefined || state.status !== 'ok') return null
  const services = state.services

  const write = async (next: readonly ModelServiceInput[]): Promise<string | undefined> => {
    const result = await client!.modelServicesSave({ expectedRevision: state.revision, services: next })
    await reload()
    if (result.status === 'applied') {
      setNotice(t('catalog.sharedServiceSaved'))
      return undefined
    }
    return result.code === 'conflict'
      ? t('catalog.sharedServiceConflict')
      : result.code === 'invalid'
      ? result.message ?? t('catalog.sharedServiceInvalid')
      : t('catalog.failed')
  }
  const saveOne = async (input: ModelServiceInput) => {
    const others = services.filter(service => service.id !== (editing?.id ?? input.id)).map(inputOf)
    const position = services.findIndex(service => service.id === editing?.id)
    const next = [...others]
    next.splice(position < 0 ? next.length : position, 0, input)
    return await write(next)
  }
  const editingService = editing?.id === undefined ? undefined : services.find(service => service.id === editing.id)

  return (
    <section className="cxms-shared" aria-label={t('catalog.sharedServices')} data-shared-model-services="true">
      <header className="cxms-shared-header">
        <div>
          <h3>{t('catalog.sharedServices')}</h3>
          <p>{t('catalog.sharedServicesDescription')}</p>
        </div>
        {editing === undefined
          ? (
            <Button tag="button" variant="outline" onClick={() => setEditing({})}>
              {t('catalog.sharedServiceAdd')}
            </Button>
          )
          : null}
      </header>
      {notice === undefined ? null : <p role="status" className="cxms-shared-notice">{notice}</p>}
      {editing === undefined
        ? null
        : (
          <ServiceEditor
            key={editing.id ?? 'new'}
            service={editingService}
            locale={locale}
            save={saveOne}
            close={() => setEditing(undefined)}
          />
        )}
      {services.length === 0
        ? <p className="cxms-shared-empty">{t('catalog.sharedServicesEmpty')}</p>
        : (
          <ul className="cxms-shared-list">
            {services.map(service => (
              <li key={service.id} data-shared-model-service={service.id} data-enabled={service.enabled}>
                <div className="cxms-shared-main">
                  <strong>{service.displayName}</strong>
                  <code>{service.id}</code>
                  <span className="cxms-shared-endpoint">{service.baseUrl}</span>
                </div>
                <div className="cxms-shared-tags">
                  {service.protocols.includes('openai-responses')
                    ? <span>Codex · {service.codexModels.length}</span>
                    : null}
                  {service.protocols.includes('anthropic-messages')
                    ? <span>Claude · {service.claudeModels.length}</span>
                    : null}
                  <span data-key={service.keyConfigured ? 'set' : 'missing'}>
                    {t(service.keyConfigured ? 'catalog.sharedServiceKeySet' : 'catalog.sharedServiceKeyMissing')}
                  </span>
                  {service.enabled ? null : <span>{t('catalog.sharedServiceDisabled')}</span>}
                </div>
                <div className="cxms-shared-actions">
                  <Button
                    tag="button"
                    variant="text"
                    onClick={() =>
                      setEditing({ id: service.id })}
                  >
                    {t('catalog.sharedServiceEdit')}
                  </Button>
                  <Button
                    tag="button"
                    variant="text"
                    theme="danger"
                    onClick={() =>
                      void write(
                        services.filter(item =>
                          item.id !== service.id
                        ).map(inputOf),
                      )}
                  >
                    {t('catalog.sharedServiceDelete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
