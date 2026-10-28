import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'
import type {
  NativeProviderSelectionClient,
  NativeProviderSelectionCommandChannel,
  NativeProviderSelectionProjection,
} from './native-provider-selection-client.js'
import { isModelReasoningEffort } from '../model-reasoning-capabilities.js'
import { type CatalogReasoningLookup, resolveTargetReasoning } from './native-model-reasoning.js'

/** Safe metadata validation only. No selection, credentials, or native mutation. */
export async function validateNextSendSelection(
  selection: NonNullable<NativeProviderSelectionProjection['nextSend']>,
  control: NativeModelSelectionControl | undefined,
  channel: NativeProviderSelectionCommandChannel,
  reasoning: CatalogReasoningLookup,
): Promise<boolean> {
  if (!control) return false
  if (selection.providerId === 'openai') {
    if (!control.models.some(model => model.id === selection.model && !model.disabled)) return false
  } else {
    if (!channel.catalogRead) return false
    try {
      const catalog = await channel.catalogRead()
      if (
        !catalog.some(provider =>
          provider.providerId === selection.providerId
          && provider.models.some(model => model.id === selection.model)
        )
      ) return false
    } catch {
      return false
    }
  }
  return selection.reasoningEffort === undefined || resolveTargetReasoning(
    selection,
    selection.reasoningEffort,
    control.models,
    reasoning,
  ).efforts.includes(selection.reasoningEffort)
}

export async function stageModelNextSend(
  target: { providerId: string; model: string },
  control: NativeModelSelectionControl,
  channel: NativeProviderSelectionCommandChannel,
  reasoning: CatalogReasoningLookup,
  client: NativeProviderSelectionClient,
  current: () => boolean,
): Promise<'accepted' | 'busy' | 'unavailable'> {
  const generation = client.reserveDraftEdit()
  const effort = resolveTargetReasoning(
    target,
    client.snapshot().nextSend?.reasoningEffort ?? control.reasoningEffort,
    control.models,
    reasoning,
  ).effort
  const draft = {
    ...target,
    ...(isModelReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
  }
  if (!await validateNextSendSelection(draft, control, channel, reasoning) || !current()) return 'unavailable'
  return client.stageNextSend(draft, generation) ? 'accepted' : 'busy'
}

export function stageEffortNextSend(
  target: { providerId: string; model: string },
  effort: string,
  control: NativeModelSelectionControl | undefined,
  reasoning: CatalogReasoningLookup,
  client: NativeProviderSelectionClient,
): 'accepted' | 'busy' | 'unavailable' {
  if (
    !control || !isModelReasoningEffort(effort)
    || !resolveTargetReasoning(target, effort, control.models, reasoning).efforts.includes(effort)
  ) {
    return 'unavailable'
  }
  return client.stageNextSend({
      ...target,
      reasoningEffort: effort,
    })
    ? 'accepted'
    : 'busy'
}
