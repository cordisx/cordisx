import {
  isModelReasoningEffort,
  type ModelReasoningEffort,
  parseModelReasoningCapabilities,
} from '../model-reasoning-capabilities.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

/** Explicit creation effort is checked against the selected model before native provisioning. */
export function nativeTaskEffort(
  catalog: readonly NativeModelProviderCatalogEntry[],
  providerId: string,
  model: string,
  thinking: unknown,
): { effort?: ModelReasoningEffort } | { reason: string } {
  if (thinking === undefined) return {}
  if (!isModelReasoningEffort(thinking)) return { reason: 'invalid-reasoning-effort' }
  const capabilities = parseModelReasoningCapabilities(
    catalog.find(provider => provider.providerId === providerId)?.models.find(row => row.id === model)
      ?.reasoningCapabilities,
  )
  if (!capabilities) return { reason: 'reasoning-capabilities-unavailable' }
  return capabilities.efforts.includes(thinking)
    ? { effort: thinking }
    : { reason: 'reasoning-effort-unsupported' }
}

/** Check explicitly requested capabilities again immediately before each native write. */
export function nativeTaskSelectionAllowed(
  catalog: readonly NativeModelProviderCatalogEntry[],
  selection: {
    providerId: string
    model: string
    reasoningEffort?: ModelReasoningEffort
    serviceTier?: 'priority' | null
    reasoningExplicit?: boolean
    fastExplicit?: boolean
  },
) {
  const model = catalog.find(provider => provider.providerId === selection.providerId)?.models.find(row =>
    row.id === selection.model
  )
  if (!model) return false
  if (
    selection.reasoningExplicit && (selection.reasoningEffort === undefined
      || 'reason' in nativeTaskEffort(catalog, selection.providerId, selection.model, selection.reasoningEffort))
  ) {
    return false
  }
  return !selection.fastExplicit || selection.serviceTier !== 'priority' || model.supportsFastMode === true
}
