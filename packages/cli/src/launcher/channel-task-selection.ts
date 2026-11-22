import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import type { ChannelTaskPatch } from './channel-task-config.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export interface ChannelTaskCatalogProvider {
  readonly providerId: string
  readonly defaultModelId?: string
  readonly models: readonly Record<string, unknown>[]
}
export function channelTaskCatalog(value: unknown): readonly ChannelTaskCatalogProvider[] {
  const providers = object(value).providers
  if (!Array.isArray(providers)) throw new Error('MODEL_CATALOG_UNAVAILABLE')
  return providers.map(object).filter(row => typeof row.providerId === 'string' && Array.isArray(row.models)).map(
    row => ({
      providerId: String(row.providerId),
      ...(typeof row.defaultModelId === 'string' ? { defaultModelId: row.defaultModelId } : {}),
      models: (row.models as unknown[]).map(object),
    }),
  )
}
export function validateChannelTaskSelection(
  providers: readonly ChannelTaskCatalogProvider[],
  selection: ChannelTaskPatch,
): ChannelTaskPatch {
  const provider = providers.find(provider => provider.providerId === selection.providerId)
  const model = provider?.models.find(model => model.id === selection.model)
  if (!model) throw new Error('SELECTION_OUTSIDE_CATALOG')
  if (selection.fast === true && model.supportsFastMode !== true) throw new Error('FAST_NOT_SUPPORTED')
  if (selection.effort && selection.effort !== 'inherit') {
    const capabilities = parseModelReasoningCapabilities(model.reasoningCapabilities)
    if (!capabilities) throw new Error('MODEL_EFFORT_UNAVAILABLE')
    if (!(capabilities.efforts as readonly string[]).includes(selection.effort)) {
      throw new Error('MODEL_EFFORT_UNSUPPORTED')
    }
  }
  return selection
}
/** Fill only genuinely implied choices; every implied field is included in the permission patch. */
export function resolveChannelTaskSelection(
  providers: readonly ChannelTaskCatalogProvider[],
  current: ChannelTaskPatch,
  patch: ChannelTaskPatch,
) {
  const selection = { ...current, ...patch }
  if (!selection.providerId && patch.model) {
    const matching = providers.filter(provider => provider.models.some(model => model.id === patch.model))
    if (matching.length !== 1) throw new Error('AMBIGUOUS_MODEL_PROVIDER')
    selection.providerId = matching[0]!.providerId
  }
  const provider = providers.find(provider => provider.providerId === selection.providerId)
  if (
    provider && patch.model === undefined
    && (patch.providerId !== undefined && patch.providerId !== current.providerId || !selection.model)
  ) {
    selection.model = provider.defaultModelId && provider.models.some(model => model.id === provider.defaultModelId)
      ? provider.defaultModelId
      : String(provider.models[0]?.id ?? '')
  }
  const model = provider?.models.find(model => model.id === selection.model)
  if (patch.fast === undefined && selection.fast === true && model?.supportsFastMode !== true) selection.fast = false
  if (patch.effort === undefined && selection.effort && selection.effort !== 'inherit' && model) {
    const efforts = parseModelReasoningCapabilities(model.reasoningCapabilities)?.efforts
    if (!efforts || !(efforts as readonly string[]).includes(selection.effort)) selection.effort = 'inherit'
  }
  validateChannelTaskSelection(providers, selection)
  const authorizedPatch: Record<string, string | boolean> = { ...patch }
  for (const field of ['providerId', 'model', 'effort', 'fast', 'projectId'] as const) {
    if (selection[field] !== current[field] && selection[field] !== undefined) {
      authorizedPatch[field] = selection[field]!
    }
  }
  return { selection, patch: authorizedPatch as ChannelTaskPatch }
}
export function channelTaskSelectionMatches(left: ChannelTaskPatch, right: ChannelTaskPatch): boolean {
  return ['providerId', 'model', 'effort', 'fast', 'projectId'].every(field =>
    left[field as keyof ChannelTaskPatch] === right[field as keyof ChannelTaskPatch]
  )
}
export function channelTaskIntentObserved(patch: ChannelTaskPatch, actual: ChannelTaskPatch): boolean {
  return Object.entries(patch).every(([field, value]) =>
    field === 'effort' && value === 'inherit' || actual[field as keyof ChannelTaskPatch] === value
  )
}
