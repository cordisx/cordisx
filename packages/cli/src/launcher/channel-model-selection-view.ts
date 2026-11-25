import type { ChatExecutionRecord } from './chat-execution-preferences.js'
import type { NativeSourceConfiguration } from './native-source-configuration.js'

/** A live source wins; persisted state is usable only after native confirmation. */
export function channelModelSelectionView(
  live: NativeSourceConfiguration | undefined,
  metadata: Record<string, unknown>,
  record: ChatExecutionRecord | undefined,
) {
  if (!live && record?.modelSelection?.status === 'unknown') throw new Error('MODEL_SELECTION_UNCONFIRMED')
  const effective = record?.effective
  const explicit = record?.modelSelection?.status === 'confirmed' ? record.modelSelection : undefined
  const confirmed = !record?.modelSelection && record?.application === 'applied'
    && typeof effective?.modelProvider === 'string' && typeof effective.model === 'string'
  const provider = live?.providerId ?? explicit?.providerId
    ?? (confirmed ? effective.modelProvider : metadata.modelProvider)
  const model = live?.model ?? explicit?.model ?? (confirmed ? effective.model : metadata.model)
    ?? (effective?.modelProvider === undefined || effective.modelProvider === provider ? effective?.model : undefined)
  return { provider, model }
}
