import {
  type EffectiveSelection,
  record,
  sameValues,
  type SelectionPatch,
  type SelectionSnapshot,
  string,
} from './native-model-provider-state.js'
import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'
import type { NativeProviderSelectionProjection } from './native-provider-selection-client.js'
import type { NativeModelSource } from './adapter/native-model-list.js'
import type { CatalogReasoningLookup } from './native-model-reasoning.js'
import { resolveTargetReasoning } from './native-model-reasoning.js'
import { isModelReasoningEffort } from '../model-reasoning-capabilities.js'
import { locateNativeComposerCreationSelection } from './adapter/native-composer-creation.js'
import { locateNativeModelProviderMountSeat } from './adapter/native-model-provider-seat.js'

export function nativeComposerCreationSelection(document: Document, composer?: HTMLElement) {
  const owner = composer ?? locateNativeModelProviderMountSeat(document)?.trigger.closest<HTMLElement>(
    '[data-codex-composer-root]',
  ) ?? undefined
  return locateNativeComposerCreationSelection(owner)
}

export function pendingNativeComposerSelection(projection: NativeProviderSelectionProjection): SelectionSnapshot {
  return {
    available: false,
    busy: true,
    ...(projection.draftPreference === undefined ? {} : {
      draftPreference: { ...projection.draftPreference, revision: projection.revision },
    }),
  }
}

/** Compose labels and catalog metadata without granting native interaction authority. */
export function nativeComposerSelectionPresentation(
  next: SelectionSnapshot,
  composer: HTMLElement | undefined,
  control: NativeModelSelectionControl | undefined,
  source: NativeModelSource,
  providerNames: ReadonlyMap<string, string>,
  catalogReasoning: CatalogReasoningLookup,
) {
  const pendingCreation = next.threadId === undefined ? locateNativeComposerCreationSelection(composer) : undefined
  const effectiveReasoning = next.modelProvider === undefined || next.model === undefined || control === undefined
    ? undefined
    : resolveTargetReasoning(
      { providerId: next.modelProvider, model: next.model },
      next.reasoningEffort,
      control.models,
      catalogReasoning,
    )
  return {
    ...(effectiveReasoning?.catalogBacked ? { reasoningEfforts: effectiveReasoning.efforts } : {}),
    modelLabel: control?.model === next.model ? control?.modelLabel : undefined,
    ...source.project(
      next.nativeModelsScope,
      next.modelProvider,
      control && control.model === next.model ? control.models : [],
    ),
    providerLabel: next.modelProvider === undefined ? undefined : providerNames.get(next.modelProvider),
    pendingCreation,
  }
}

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
  const serviceTier = threadId === undefined
    ? string(config.service_tier) ?? null
    : control.serviceTierKnown
    ? control.serviceTier
    : thread && Object.hasOwn(thread, 'serviceTier')
        && (thread.serviceTier === null || thread.serviceTier === 'priority' || thread.serviceTier === 'fast')
    ? thread.serviceTier
    : confirmed?.serviceTier
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
    ...(effort ? { reasoningEffort: effort } : threadId === undefined && string(config.model_reasoning_effort)
      ? { reasoningEffort: string(config.model_reasoning_effort)! }
      : {}),
    reasoningEfforts: control.reasoningEfforts,
    nativeModelsScope: string(config.model_catalog_json) === undefined ? 'active-provider' : 'global',
    ...(serviceTier === undefined ? {} : {
      serviceTier: serviceTier === 'priority' || serviceTier === 'fast' ? 'priority' as const : null,
    }),
    ...(threadId === undefined && projection.draftPreference !== undefined
      ? { draftPreference: { ...projection.draftPreference, revision: projection.revision } }
      : {}),
  }
}

/** Reconcile native control presentation while preserving a confirmed thread model. */
export function nativeComposerControlPatch(
  state: SelectionSnapshot,
  effective: EffectiveSelection | undefined,
  control: NativeModelSelectionControl,
  source: NativeModelSource,
  catalogReasoning: CatalogReasoningLookup,
): SelectionPatch | undefined {
  const model = effective?.model ?? control.model
  const reasoning = state.modelProvider === undefined
    ? undefined
    : resolveTargetReasoning(
      { providerId: state.modelProvider, model },
      control.reasoningEffort,
      control.models,
      catalogReasoning,
    )
  const reasoningEfforts = reasoning?.catalogBacked ? reasoning.efforts : control.reasoningEfforts
  const projectedModels = source.project(state.nativeModelsScope, state.modelProvider, control.models)
  if (
    state.model === model && state.modelLabel === control.modelLabel
    && JSON.stringify(state.nativeModels) === JSON.stringify(projectedModels.nativeModels)
    && state.nativeModelsProviderId === projectedModels.nativeModelsProviderId
    && state.reasoningEffort === control.reasoningEffort
    && sameValues(state.reasoningEfforts, reasoningEfforts)
  ) return undefined
  return { model, reasoningEffort: control.reasoningEffort, reasoningEfforts }
}

/** Resolve native baseline identities; the Host binding still decides the selected provider. */
export function nativeComposerBaselineRouting(
  baseline: NonNullable<Awaited<ReturnType<typeof readNativeComposerBaseline>>>,
  control: NativeModelSelectionControl,
  effective: EffectiveSelection | undefined,
  threadId: string | undefined,
) {
  const { config, thread } = baseline
  const providerNames = new Map<string, string>()
  for (const [id, value] of Object.entries(record(config.model_providers) ?? {})) {
    const name = string(record(value)?.name)
    if (name && name !== id) providerNames.set(id, name)
  }
  const catalogIdentity = string(config.model_catalog_json)
  return {
    provider: effective?.providerId ?? string(thread?.modelProvider)
      ?? (threadId === undefined ? string(config.model_provider) ?? 'openai' : undefined),
    model: effective?.model ?? (control.model || (threadId === undefined ? string(config.model) : undefined)),
    catalogIdentity,
    nativeModelsScope: catalogIdentity === undefined ? 'active-provider' as const : 'global' as const,
    providerNames,
  }
}

/** Only live, bound native controls can supply a creation source tuple. */
export function nativeSourceComposerConfiguration(
  state: SelectionSnapshot,
  control: NativeModelSelectionControl | undefined,
  visibleThreadId: string | undefined,
  operationActive: boolean,
) {
  if (
    !state.available || !visibleThreadId || state.threadId !== visibleThreadId || operationActive
    || !state.modelProvider || !state.model || !control || control.model !== state.model || !control.serviceTierKnown
    || state.serviceTier !== control.serviceTier || !isModelReasoningEffort(control.reasoningEffort)
  ) return undefined
  return {
    providerId: state.modelProvider,
    model: control.model,
    reasoningEffort: control.reasoningEffort,
    serviceTier: control.serviceTier,
  }
}
