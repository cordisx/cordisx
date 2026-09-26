import { useEffect, useMemo, useRef, useState } from 'react'
import Schema from '@deepseek-ai/schemastery'
import type { SchemaFormOptionsV1 } from '@cordisx/protocol/schema-form/v1'
import { Button } from 'tdesign-react'
import type { PluginManagementSnapshot } from '../../../management/contracts.js'
import { normalizeMarketplaceSource } from '../../marketplace.js'
import { HostSchemaFormPage, schemaFormSnapshot } from '../../host-ui/SchemaForm.js'
import { MARKETPLACE_SOURCE_COPY } from '../components/MarketplaceSourceManager.js'
import type { ManagerPluginManagementBinding } from '../model/plugin-management.js'
import { usePluginManagementActions } from '../model/use-plugin-management-actions.js'

export function MarketplaceSourceEditPage({ locale, currentUrl, pluginManagement, managementSnapshot, close }: {
  readonly locale: string
  readonly currentUrl?: string | undefined
  readonly pluginManagement?: ManagerPluginManagementBinding | undefined
  readonly managementSnapshot?: PluginManagementSnapshot | undefined
  readonly close: () => void
}) {
  const copy = MARKETPLACE_SOURCE_COPY[locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en']
  const source = managementSnapshot?.sources.find(source => source.url === currentUrl)
  const actions = usePluginManagementActions(pluginManagement, managementSnapshot, locale)
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({
    url: source?.url ?? '',
    name: source?.local?.name ?? '',
    description: source?.local?.description ?? '',
    trusted: source?.trusted ?? true,
  }))
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const schema = useMemo(() =>
    Schema.object({
      url: Schema.string().required().min(1).role('url').extra('extra', {
        label: copy.url,
        cordisxForm: { icon: 'host:info' },
      }),
      name: Schema.string().max(80).default('').extra('extra', {
        label: copy.name,
        cordisxForm: { icon: 'host:tags' },
      }),
      description: Schema.string().max(280).default('').role('textarea').extra('extra', {
        label: copy.description,
        cordisxForm: { icon: 'host:files' },
      }),
      trusted: Schema.boolean().role('switch').default(true).description(copy.trustedDescription).extra('extra', {
        label: copy.trusted,
        cordisxForm: { icon: 'host:key' },
      }),
    }) as unknown as SchemaFormOptionsV1['schema'], [locale])
  let validUrl = false
  try {
    normalizeMarketplaceSource(String(draft.url).trim())
    validUrl = true
  } catch { /* incomplete draft */ }
  const available = pluginManagement !== undefined && managementSnapshot !== undefined && (!currentUrl || !!source)
  const valid = validUrl && schemaFormSnapshot(schema, draft, locale).valid
  const save = async () => {
    if (!available || !valid || busy) return
    setBusy(true)
    setError(undefined)
    const name = String(draft.name).trim()
    const description = String(draft.description).trim()
    const input = {
      url: normalizeMarketplaceSource(String(draft.url).trim()),
      enabled: source?.enabled ?? true,
      trusted: draft.trusted === true,
      ...(name || description ? { local: { ...(name ? { name } : {}), ...(description ? { description } : {}) } } : {}),
    }
    try {
      await actions.mutate(
        currentUrl ?? input.url,
        currentUrl
          ? { kind: 'source-edit', url: currentUrl, source: input }
          : { kind: 'source-add', source: input },
        false,
      )
      if (mounted.current) close()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="cxr-page cxf-form-surface" data-marketplace-source-editor="true">
      <HostSchemaFormPage
        form={{
          identity: currentUrl ?? 'new-marketplace-source',
          schema,
          value: draft,
          locale,
          disabled: busy || !available,
          onChange: ({ value }) => setDraft(value),
        }}
        footer={
          <div className="cxf-form-action-buttons">
            <Button tag="button" variant="outline" disabled={busy} onClick={close}>{copy.cancel}</Button>
            <Button
              tag="button"
              theme="primary"
              disabled={!available || !valid}
              loading={busy}
              onClick={() => void save()}
            >
              {copy.save}
            </Button>
          </div>
        }
      >
        {error ? <p className="cxf-error" role="alert" data-marketplace-source-error="true">{error}</p> : null}
      </HostSchemaFormPage>
    </section>
  )
}
