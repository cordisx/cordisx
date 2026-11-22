import type { CodexCreationSettings } from '../codex-creation-settings.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

/** Changing provider without naming a model uses that provider's default, never another provider's model. */
export function codexCreationSelection(
  defaults: CodexCreationSettings,
  explicit: CodexCreationSettings,
  catalog: readonly NativeModelProviderCatalogEntry[],
): CodexCreationSettings {
  let providerId = explicit.providerId ?? defaults.providerId
  let model = explicit.model ?? (explicit.providerId !== undefined && explicit.providerId !== defaults.providerId
    ? undefined
    : defaults.model)
  const fast = explicit.fast ?? defaults.fast
  if (providerId === undefined && model !== undefined) {
    const providers = catalog.filter(row => row.models.some(entry => entry.id === model))
    if (providers.length !== 1) throw new Error('AMBIGUOUS_MODEL_PROVIDER')
    providerId = providers[0]!.providerId
  }
  if (providerId === undefined && fast === true && model === undefined) providerId = 'openai'
  if (providerId !== undefined) {
    const provider = catalog.find(row => row.providerId === providerId)
    if (!provider) throw new Error('PROVIDER_NOT_IN_CATALOG')
    model ??= provider.defaultModelId
    if (!model || !provider.models.some(row => row.id === model)) throw new Error('MODEL_NOT_IN_PROVIDER_CATALOG')
  }
  if (
    fast === true && providerId && model
    && !catalog.find(row => row.providerId === providerId)?.models.some(row => row.id === model && row.supportsFastMode)
  ) {
    throw new Error('FAST_NOT_SUPPORTED')
  }
  return { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}), ...(fast === undefined ? {} : { fast }) }
}
