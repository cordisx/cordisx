import type { CodexCreationSettings } from '../codex-creation-settings.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Preserve explicit Channel/profile choices before applying the native owner's fallback. */
export async function channelNativeCreationSelection(
  defaults: CodexCreationSettings,
  input: { providerId?: string; model?: string; fallbackProviderId?: string; fallbackModel?: string },
  list: () => Promise<unknown>,
) {
  const selection = {
    ...(defaults.providerId ? { providerId: defaults.providerId } : {}),
    ...(defaults.model && (!input.providerId || input.providerId === defaults.providerId)
      ? { model: defaults.model }
      : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(defaults.fast === undefined ? {} : { fast: defaults.fast }),
  }
  if (!selection.providerId && input.fallbackProviderId) selection.providerId = input.fallbackProviderId
  if (!selection.model && selection.providerId === input.fallbackProviderId && input.fallbackModel) {
    selection.model = input.fallbackModel
  }
  if (!selection.providerId || !selection.model) {
    const providers = object(await list()).providers
    const rows = Array.isArray(providers) ? providers.map(object) : []
    const provider = rows.find(row => row.providerId === (selection.providerId ?? 'openai'))
    if (provider) {
      selection.providerId ??= String(provider.providerId)
      if (!selection.model && typeof provider.defaultModelId === 'string') selection.model = provider.defaultModelId
    }
  }
  return selection
}
