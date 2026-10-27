import {
  type ModelReasoningCapabilities,
  type ModelReasoningEffort,
  resolveModelReasoningEffort,
} from '../model-reasoning-capabilities.js'
import type { PendingNativeProviderSelection } from './native-provider-selection-client.js'

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

export class PendingModelReasoning {
  private selection: { readonly key: string; readonly effort: ModelReasoningEffort } | undefined

  select(navigation: number, pending: PendingNativeProviderSelection, effort: ModelReasoningEffort): void {
    this.selection = { key: this.key(navigation, pending), effort }
  }

  resolve(
    navigation: number,
    pending: PendingNativeProviderSelection | undefined,
    fallback?: string,
  ): string | undefined {
    if (pending === undefined || this.selection?.key !== this.key(navigation, pending)) this.selection = undefined
    return this.selection?.effort ?? fallback
  }

  private key(navigation: number, pending: PendingNativeProviderSelection): string {
    return JSON.stringify([navigation, pending.generation, pending.providerId, pending.model])
  }
}

export function resolveTargetReasoning(
  target: { readonly providerId: string; readonly model: string },
  currentEffort: string | undefined,
  models: readonly NativeReasoningModel[],
  catalogReasoning: CatalogReasoningLookup,
): TargetReasoning {
  const catalog = catalogReasoning(target.providerId, target.model)
  const equivalent = models.filter(model => model.id.toLowerCase() === target.model.toLowerCase())
  const native = models.find(model => model.id === target.model)
    ?? (equivalent.length === 1 ? equivalent[0] : undefined)
  const capabilities = catalog ?? native?.reasoningCapabilities
  const effort = resolveModelReasoningEffort(capabilities, currentEffort) ?? native?.defaultReasoningEffort
  return {
    ...(effort === undefined ? {} : { effort }),
    efforts: capabilities?.efforts ?? [],
    catalogBacked: catalog !== undefined,
  }
}
