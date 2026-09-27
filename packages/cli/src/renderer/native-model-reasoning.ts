import { type ModelReasoningCapabilities, resolveModelReasoningEffort } from '../model-reasoning-capabilities.js'

export type CatalogReasoningLookup = (
  providerId: string,
  model: string,
) => ModelReasoningCapabilities | null | undefined

export interface NativeReasoningModel {
  readonly id: string
  readonly reasoningCapabilities?: ModelReasoningCapabilities
  readonly defaultReasoningEffort?: string
}

export interface TargetReasoning {
  readonly effort?: string
  readonly efforts: readonly string[]
  readonly catalogBacked: boolean
}

export function resolveTargetReasoning(
  target: { readonly providerId: string; readonly model: string },
  currentEffort: string | undefined,
  models: readonly NativeReasoningModel[],
  catalogReasoning: CatalogReasoningLookup,
): TargetReasoning {
  const catalog = catalogReasoning(target.providerId, target.model)
  const native = models.find(model => model.id === target.model)
  const capabilities = catalog ?? native?.reasoningCapabilities
  const effort = resolveModelReasoningEffort(capabilities, currentEffort) ?? native?.defaultReasoningEffort
  return {
    ...(effort === undefined ? {} : { effort }),
    efforts: capabilities?.efforts ?? [],
    catalogBacked: catalog !== undefined,
  }
}
