import type { SchemaFormOptionsV1 } from '@cordisx/protocol/schema-form/v1'
import Schema from '@deepseek-ai/schemastery'
import type { CordisXConfigFormIcon } from '../../../../contracts.js'
import { managerCopy } from '../../../ui-copy.js'

export interface ConnectionDraft extends Record<string, unknown> {
  title: string
  endpoint: string
  protocol: 'responses' | 'chat-completions'
  source: 'manual' | 'only' | 'augment'
  discoveryEnabled: boolean
  models: { id: string; label?: string; protocolCapabilities?: { responses: boolean } }[]
  emptyConfirmed: boolean
}

/** The same Host schema drives creation and existing-connection editing. */
export function connectionSchema(locale: string, draft: ConnectionDraft, responsesOnly = false) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const label = (text: string) => ({ label: text })
  const field = (text: string, icon: CordisXConfigFormIcon) => ({ label: text, cordisxForm: { icon } })
  return Schema.object({
    title: Schema.string().required().min(1).max(128).pattern(/^[^\u0000-\u001f\u007f]*\S[^\u0000-\u001f\u007f]*$/u)
      .extra('extra', field(t('catalog.title'), 'host:tags')),
    endpoint: Schema.string().required().min(1).max(2048).role('url')
      .extra('extra', field(t('catalog.endpoint'), 'host:info')),
    protocol: responsesOnly ? Schema.const('responses').required().hidden() : Schema.union([
      Schema.const('chat-completions').extra('extra', label('Chat Completions')),
      Schema.const('responses').extra('extra', label('Responses')),
    ]).required().extra('extra', field(t('catalog.protocol'), 'host:settings')),
    source: Schema.union([
      Schema.const('manual').extra('extra', label(t('catalog.manualReplace'))),
      Schema.const('only').extra('extra', label(t('catalog.autoOnly'))),
      Schema.const('augment').extra('extra', label(t('catalog.autoAugment'))),
    ]).required().extra('extra', field(t('catalog.source'), 'host:folder')),
    ...(draft.source === 'manual'
      ? {
        models: Schema.array(
          Schema.object({
            id: Schema.string().required().min(1).max(512).pattern(
              /^[^\u0000-\u001f\u007f]*\S[^\u0000-\u001f\u007f]*$/u,
            )
              .extra('extra', field(t('catalog.id'), 'host:key')),
            label: Schema.string().max(256).default('').extra('extra', field(t('catalog.label'), 'host:tags')),
          }).default({ id: '', label: '' }),
        ).max(10_000).default([]).extra('extra', {
          label: t('catalog.sourceCount'),
          cordisxForm: {
            icon: 'host:files',
            presenter: { version: 1, kind: 'array.object-page', options: { allowReorder: false } },
          },
        }),
        ...(draft.models.length === 0
          ? { emptyConfirmed: Schema.boolean().extra('extra', field(t('catalog.emptyConfirm'), 'host:save')) }
          : {}),
      }
      : {
        discoveryEnabled: Schema.boolean().role('switch').extra(
          'extra',
          field(t('catalog.discoveryGrant'), 'host:key'),
        ),
      }),
  }) as unknown as SchemaFormOptionsV1['schema']
}
