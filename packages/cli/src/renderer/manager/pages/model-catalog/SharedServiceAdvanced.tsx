import type { SchemaFormOptionsV1 } from '@cordisx/protocol/schema-form/v1'
import Schema from '@deepseek-ai/schemastery'
import { useMemo } from 'react'
import { Button } from 'tdesign-react'
import type { ModelServiceInput, ModelServiceView } from '../../../../model-service-contracts.js'
import { fields } from '../../../configuration/form-presentation.js'
import type { SchemaNode } from '../../../configuration/model.js'
import { HostFieldRow } from '../../../host-ui/HostForm.js'
import { schemaFormSnapshot } from '../../../host-ui/SchemaForm.js'
import { managerCopy } from '../../../ui-copy.js'

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u
const HEADER_VALUE = /^[^\u0000-\u001f\u007f]*$/u
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u
const RETRY_MAX = 4_294_967_295

interface FixedHeader extends Record<string, unknown> {
  name: string
  value: string
  replaceWithEmpty?: boolean
}

interface EnvironmentHeader extends Record<string, unknown> {
  name: string
  variable: string
}

export interface SharedServiceAdvancedDraft extends Record<string, unknown> {
  websockets: 'default' | 'on' | 'off'
  requestRetries?: number | undefined
  streamRetries?: number | undefined
  streamIdleTimeout?: number | undefined
  fixedHeaders: FixedHeader[]
  environmentHeaders: EnvironmentHeader[]
}

export function sharedServiceAdvancedDraft(service: ModelServiceView | undefined): SharedServiceAdvancedDraft {
  const codex = service?.runtimeOptions?.codex
  return {
    websockets: codex?.supports_websockets === undefined ? 'default' : codex.supports_websockets ? 'on' : 'off',
    requestRetries: codex?.request_max_retries,
    streamRetries: codex?.stream_max_retries,
    streamIdleTimeout: codex?.stream_idle_timeout_ms,
    fixedHeaders: (service?.httpHeaderNames ?? []).map(name => ({ name, value: '' })),
    environmentHeaders: Object.entries(codex?.env_http_headers ?? {}).map(([name, variable]) => ({ name, variable })),
  }
}

/** Omit unchanged options so full-array CAS writes retain Host-private values. */
export function sharedServiceAdvancedInput(
  draft: SharedServiceAdvancedDraft,
  service: ModelServiceView | undefined,
): Pick<ModelServiceInput, 'runtimeOptions' | 'httpHeadersPatch'> {
  const baseline = sharedServiceAdvancedDraft(service)
  const runtimeChanged = draft.websockets !== baseline.websockets
    || draft.requestRetries !== baseline.requestRetries || draft.streamRetries !== baseline.streamRetries
    || draft.streamIdleTimeout !== baseline.streamIdleTimeout
    || JSON.stringify(draft.environmentHeaders) !== JSON.stringify(baseline.environmentHeaders)
  const currentNames = new Set(draft.fixedHeaders.map(header => header.name.toLowerCase()))
  const savedNames = new Set(baseline.fixedHeaders.map(header => header.name.toLowerCase()))
  const patch: Record<string, string | null> = Object.create(null)
  for (const header of baseline.fixedHeaders) {
    if (!currentNames.has(header.name.toLowerCase())) patch[header.name] = null
  }
  for (const header of draft.fixedHeaders) {
    if (!savedNames.has(header.name.toLowerCase()) || header.value !== '' || header.replaceWithEmpty === true) {
      patch[header.name] = header.value
    }
  }
  return {
    ...(runtimeChanged
      ? {
        runtimeOptions: {
          codex: {
            ...(draft.websockets === 'default' ? {} : { supports_websockets: draft.websockets === 'on' }),
            ...(draft.requestRetries === undefined ? {} : { request_max_retries: draft.requestRetries }),
            ...(draft.streamRetries === undefined ? {} : { stream_max_retries: draft.streamRetries }),
            ...(draft.streamIdleTimeout === undefined ? {} : { stream_idle_timeout_ms: draft.streamIdleTimeout }),
            ...(draft.environmentHeaders.length === 0 ? {} : {
              env_http_headers: Object.fromEntries(
                draft.environmentHeaders.map(header => [header.name, header.variable]),
              ),
            }),
          },
        },
      }
      : {}),
    ...(Object.keys(patch).length === 0 ? {} : { httpHeadersPatch: patch }),
  }
}

export function validSharedServiceAdvanced(draft: SharedServiceAdvancedDraft): boolean {
  const natural = (value: number | undefined, max: number) =>
    value === undefined
    || Number.isSafeInteger(value) && value >= 0 && value <= max
  const names = [...draft.fixedHeaders, ...draft.environmentHeaders].map(header => header.name.toLowerCase())
  return ['default', 'on', 'off'].includes(draft.websockets)
    && natural(draft.requestRetries, RETRY_MAX) && natural(draft.streamRetries, RETRY_MAX)
    && natural(draft.streamIdleTimeout, Number.MAX_SAFE_INTEGER)
    && draft.fixedHeaders.length <= 64 && draft.environmentHeaders.length <= 64
    && new Set(names).size === names.length
    && draft.fixedHeaders.every(header =>
      HEADER_NAME.test(header.name)
      && header.value.length <= 16_384 && HEADER_VALUE.test(header.value)
    )
    && draft.environmentHeaders.every(header => HEADER_NAME.test(header.name) && ENVIRONMENT_NAME.test(header.variable))
}

function advancedSchema(locale: string): SchemaFormOptionsV1['schema'] {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const field = (key: Parameters<typeof managerCopy>[1], description?: Parameters<typeof managerCopy>[1]) => ({
    label: t(key),
    ...(description === undefined ? {} : { description: t(description) }),
    cordisxForm: { icon: 'host:settings' },
  })
  const array = (key: Parameters<typeof managerCopy>[1], hint: Parameters<typeof managerCopy>[1]) => ({
    ...field(key, hint),
    cordisxForm: {
      icon: 'host:files',
      presenter: { version: 1, kind: 'array.object-page', options: { allowReorder: false } },
    },
  })
  return Schema.object({
    websockets: Schema.union([
      Schema.const('default').extra('extra', { label: t('catalog.sharedServiceDefault') }),
      Schema.const('on').extra('extra', { label: t('catalog.sharedServiceOn') }),
      Schema.const('off').extra('extra', { label: t('catalog.sharedServiceOff') }),
    ]).required().extra('extra', {
      ...field('catalog.sharedServiceWebSockets'),
      cordisxForm: { icon: 'host:settings', presenter: { version: 1, kind: 'choice.radio' } },
    }),
    requestRetries: Schema.natural().max(RETRY_MAX).step(1).extra(
      'extra',
      field('catalog.sharedServiceRequestRetries'),
    ),
    streamRetries: Schema.natural().max(RETRY_MAX).step(1).extra('extra', field('catalog.sharedServiceStreamRetries')),
    streamIdleTimeout: Schema.natural().max(Number.MAX_SAFE_INTEGER).step(1)
      .extra('extra', field('catalog.sharedServiceStreamIdle')),
    fixedHeaders: Schema.array(
      Schema.object({
        name: Schema.string().required().max(256).pattern(HEADER_NAME)
          .extra('extra', field('catalog.sharedServiceHeaderName')),
        value: Schema.string().max(16_384).pattern(HEADER_VALUE).role('password').default('')
          .extra('extra', field('catalog.sharedServiceHeaderValue', 'catalog.sharedServiceHeadersHint')),
      }).default({ name: '', value: '' }),
    ).max(64).default([])
      .extra('extra', array('catalog.sharedServiceHeaders', 'catalog.sharedServiceHeadersHint')),
    environmentHeaders: Schema.array(
      Schema.object({
        name: Schema.string().required().max(256).pattern(HEADER_NAME)
          .extra('extra', field('catalog.sharedServiceHeaderName')),
        variable: Schema.string().required().max(128).pattern(ENVIRONMENT_NAME)
          .extra('extra', field('catalog.sharedServiceEnvironmentName')),
      }).default({ name: '', variable: '' }),
    ).max(64).default([])
      .extra('extra', array('catalog.sharedServiceEnvironmentHeaders', 'catalog.sharedServiceEnvironmentHeaderHint')),
  }) as unknown as SchemaFormOptionsV1['schema']
}

export function SharedServiceAdvanced({ draft, service, locale, disabled, onChange }: {
  readonly draft: SharedServiceAdvancedDraft
  readonly service: ModelServiceView | undefined
  readonly locale: string
  readonly disabled: boolean
  readonly onChange: (draft: SharedServiceAdvancedDraft) => void
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const schema = useMemo(() => advancedSchema(locale), [locale])
  const projected = fields(schema as SchemaNode, draft, draft, 'shared-service-advanced', locale)
  const snapshot = schemaFormSnapshot(schema, draft, locale)
  const savedNames = new Set((service?.httpHeaderNames ?? []).map(name => name.toLowerCase()))
  return (
    <details data-shared-service-advanced="true">
      <summary>{t('catalog.sharedServiceAdvanced')}</summary>
      <div className="cxf-form-body">
        <p className="cxf-help">{t('catalog.sharedServiceDefaults')}</p>
        <div className="cxf-form-grid">
          {projected.map(field => (
            <HostFieldRow
              key={field.path.join('.')}
              field={field}
              value={field.value}
              locale={locale}
              changed={false}
              disabled={disabled}
              fieldActions="static"
              idPrefix="shared-service-advanced"
              {...(snapshot.issues.find(issue => issue.path.join('.') === field.path.join('.'))?.message
                ? { issueText: t('catalog.sharedServiceAdvancedInvalid') }
                : {})}
              {...(field.path[0] === 'fixedHeaders'
                ? {
                  renderArrayItemSupplement: ({ value, onChange: change, disabled: rowDisabled }) => {
                    const configured = savedNames.has(String(value.name).toLowerCase())
                    return (
                      <div className="cxf-form-actions">
                        <span className="cxf-status">{configured ? t('catalog.sharedServiceConfigured') : ''}</span>
                        {configured
                          ? (
                            <Button
                              tag="button"
                              variant="text"
                              disabled={rowDisabled}
                              aria-pressed={value.value === '' && value.replaceWithEmpty === true}
                              onClick={() =>
                                change({
                                  ...value,
                                  value: '',
                                  replaceWithEmpty: !(value.value === '' && value.replaceWithEmpty === true),
                                })}
                            >
                              {t('catalog.sharedServiceHeaderEmpty')}
                            </Button>
                          )
                          : null}
                      </div>
                    )
                  },
                }
                : {})}
              onChange={value => {
                if (!disabled) onChange({ ...draft, [field.path[0]!]: value })
              }}
            />
          ))}
        </div>
        <div className="cxf-form-action-buttons">
          <Button
            tag="button"
            variant="text"
            disabled={disabled}
            onClick={() => onChange(sharedServiceAdvancedDraft(undefined))}
          >
            {t('catalog.sharedServiceResetAdvanced')}
          </Button>
        </div>
        {validSharedServiceAdvanced(draft) ? null : <p role="status">{t('catalog.sharedServiceAdvancedInvalid')}</p>}
      </div>
    </details>
  )
}
