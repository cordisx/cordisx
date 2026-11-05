import { record, type SelectionSnapshot, string } from './native-model-provider-state.js'
import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'
import type { NativeProviderSelectionProjection } from './native-provider-selection-client.js'

/** Read native defaults without publishing them as the Host's selected provider. */
export async function readNativeComposerBaseline(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  threadId: string | undefined,
  current: () => boolean,
): Promise<{ thread: Record<string, unknown> | undefined; config: Record<string, unknown> } | undefined> {
  const response = threadId === undefined
    ? undefined
    : record(await request('thread/read', { threadId, includeTurns: false }))
  if (!current()) return undefined
  const result = record(await request('config/read', { includeLayers: false, cwd: null }))
  if (!current()) return undefined
  return { thread: record(response?.thread), config: record(result?.config) ?? {} }
}

export function refreshedNativeComposerSelection(
  threadId: string | undefined,
  baseline: NonNullable<Awaited<ReturnType<typeof readNativeComposerBaseline>>>,
  control: NativeModelSelectionControl,
  projection: NativeProviderSelectionProjection,
  busy: boolean,
  confirmed?: SelectionSnapshot,
): SelectionSnapshot {
  const { config, thread } = baseline
  const serviceTier = string(thread?.serviceTier) ?? string(config.service_tier)
  const effort = confirmed?.modelProvider === projection.effective?.providerId
      && confirmed?.model === projection.effective?.model
    ? confirmed?.reasoningEffort ?? control.reasoningEffort
    : control.reasoningEffort
  return {
    available: projection.available,
    providerSwitchAvailable: thread?.ephemeral !== true,
    busy,
    ...(threadId === undefined ? {} : { threadId }),
    ...(projection.effective === undefined ? {} : {
      modelProvider: projection.effective.providerId,
      model: projection.effective.model,
    }),
    ...(effort === '' && string(config.model_reasoning_effort) === undefined
      ? {}
      : { reasoningEffort: effort || string(config.model_reasoning_effort)! }),
    reasoningEfforts: control.reasoningEfforts,
    nativeModelsScope: string(config.model_catalog_json) === undefined ? 'active-provider' : 'global',
    serviceTier: serviceTier === 'priority' || serviceTier === 'fast' ? 'priority' : null,
    ...(threadId === undefined && projection.draftPreference !== undefined
      ? { draftPreference: { ...projection.draftPreference, revision: projection.revision } }
      : {}),
  }
}
