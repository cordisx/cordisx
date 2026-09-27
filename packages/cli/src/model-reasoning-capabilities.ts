export const modelReasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type ModelReasoningEffort = typeof modelReasoningEfforts[number]

export interface ModelReasoningCapabilities {
  readonly efforts: readonly ModelReasoningEffort[]
  readonly defaultEffort?: ModelReasoningEffort
}

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === 'string' && modelReasoningEfforts.includes(value as ModelReasoningEffort)
}

/** Invalid or incomplete metadata stays unknown instead of widening model capabilities. */
export function parseModelReasoningCapabilities(value: unknown): ModelReasoningCapabilities | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['efforts', 'defaultEffort'].includes(key))) return undefined
  if (
    !Array.isArray(input.efforts) || input.efforts.length === 0 || input.efforts.length > modelReasoningEfforts.length
    || input.efforts.some(effort => !isModelReasoningEffort(effort))
  ) return undefined
  const efforts = [...new Set(input.efforts as ModelReasoningEffort[])]
  if (efforts.length !== input.efforts.length) return undefined
  efforts.sort((left, right) => modelReasoningEfforts.indexOf(left) - modelReasoningEfforts.indexOf(right))
  const defaultEffort = input.defaultEffort
  if (defaultEffort !== undefined && (!isModelReasoningEffort(defaultEffort) || !efforts.includes(defaultEffort))) {
    return undefined
  }
  return Object.freeze({
    efforts: Object.freeze(efforts),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  })
}

export function resolveModelReasoningEffort(
  capabilities: ModelReasoningCapabilities | undefined,
  current: unknown,
): ModelReasoningEffort | undefined {
  if (capabilities === undefined) return undefined
  if (isModelReasoningEffort(current) && capabilities.efforts.includes(current)) return current
  return capabilities.defaultEffort
}
