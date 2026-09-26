import type { SchemaFormOptionsV1 } from '@cordisx/protocol/schema-form/v1'
import Schema from '@deepseek-ai/schemastery'
import { managerCopy } from '../../../ui-copy.js'

export interface ConnectionDraft extends Record<string, unknown> {
  title: string
  endpoint: string
  protocol: 'responses' | 'chat-completions'
  source: 'manual' | 'only' | 'augment'
  discoveryEnabled: boolean
  ids: string
  emptyConfirmed: boolean
}

/** The same Host schema drives creation and existing-connection editing. */
export function connectionSchema(locale: string, draft: ConnectionDraft) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const label = (text: string) => ({ label: text })
  return Schema.object({
    title: Schema.string().required().min(1).max(128).pattern(/^[^\u0000-\u001f\u007f]*\S[^\u0000-\u001f\u007f]*$/u)
      .extra('extra', label(t('catalog.title'))),
    endpoint: Schema.string().required().min(1).max(2048).role('url')
      .extra('extra', label(t('catalog.endpoint'))),
    protocol: Schema.union([
      Schema.const('chat-completions').extra('extra', label('Chat Completions')),
      Schema.const('responses').extra('extra', label('Responses')),
    ]).required().extra('extra', label(t('catalog.protocol'))),
    source: Schema.union([
      Schema.const('manual').extra('extra', label(t('catalog.manualReplace'))),
      Schema.const('only').extra('extra', label(t('catalog.autoOnly'))),
      Schema.const('augment').extra('extra', label(t('catalog.autoAugment'))),
    ]).required().extra('extra', label(t('catalog.source'))),
    ...(draft.source === 'manual'
      ? {
        ids: Schema.string().role('textarea').extra('extra', label(t('catalog.id'))),
        ...(draft.ids === ''
          ? { emptyConfirmed: Schema.boolean().extra('extra', label(t('catalog.emptyConfirm'))) }
          : {}),
      }
      : { discoveryEnabled: Schema.boolean().role('switch').extra('extra', label(t('catalog.discoveryGrant'))) }),
  }) as unknown as SchemaFormOptionsV1['schema']
}
