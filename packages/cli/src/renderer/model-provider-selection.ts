import type { ModelProviderModelV1, ModelProviderV1 } from '@cordisx/protocol/model-providers/v1'
import type { NativeProviderModelOption, ProviderSelectionSnapshot } from './model-provider-selector.js'
import { resolveTargetReasoning } from './native-model-reasoning.js'
import { equivalentModel, type HostModelProvider } from './model-providers.js'
import { friendlyModelLabel } from './adapter/native-model-provider-seat.js'

export function selectionModelForProvider(
  current: ModelProviderModelV1 | undefined,
  provider: Pick<ModelProviderV1, 'models' | 'defaultModelId'>,
  locale: string,
): ModelProviderModelV1 | undefined {
  const equivalent = current === undefined ? undefined : equivalentModel(current, provider.models)
  if (equivalent !== undefined) return equivalent
  if (current !== undefined) {
    const currentName = friendlyModelLabel(current.label).toLocaleLowerCase(locale)
    const sameName = provider.models.filter(model =>
      friendlyModelLabel(model.label).toLocaleLowerCase(locale) === currentName
    )
    if (sameName.length === 1) return sameName[0]
  }
  return provider.models.find(model => model.id === provider.defaultModelId) ?? provider.models[0]
}

export function nativeModelsForProvider(
  snapshot: ProviderSelectionSnapshot,
  providerId: string,
): readonly NativeProviderModelOption[] {
  const models = snapshot.nativeModels ?? []
  if (snapshot.nativeModelsScope === 'active-provider') {
    return providerId === snapshot.nativeModelsProviderId ? models : []
  }
  if (snapshot.nativeModelsScope !== 'global') return models
  const assigned = new Set(
    (snapshot.nativeModelAssignments ?? [])
      .filter(assignment => assignment.providerId === providerId)
      .map(assignment => assignment.model),
  )
  return models.filter(model => assigned.has(model.id))
}

export function modelProviderSelectionDisplay(
  native: ProviderSelectionSnapshot,
  providers: readonly HostModelProvider[],
  copy: Readonly<{ choose: string; official: string; unknown: string }>,
) {
  // Cached values are projected only into this display function.
  if (!native.available && native.cachedDisplay && native.threadId !== undefined) {
    const { reasoningEffort: _previousEffort, ...base } = native
    native = {
      ...base,
      modelProvider: native.cachedDisplay.providerId,
      model: native.cachedDisplay.model,
      ...(native.cachedDisplay.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: native.cachedDisplay.reasoningEffort }),
    }
  }
  const cachedDisplay = !native.available ? native.cachedDisplay : undefined
  const preference = native.threadId === undefined ? native.draftPreference : undefined
  const creationDisplay = native.creationDisplay?.threadId === native.threadId ? native.creationDisplay : undefined
  const providerIntent = native.pendingProviderIntent?.providerId
  const selected = providers.find(provider => provider.providerId === native.modelProvider)
  const selectedModel = selected?.models.find(model => model.id === native.model)
  const queued = native.nextSend
  const pendingProviderId = queued?.providerId ?? native.pendingProviderId
  const pendingModelId = queued?.model ?? native.pendingModel
  const pendingEffort = queued?.reasoningEffort ?? native.pendingReasoningEffort
  const pendingProvider = providers.find(provider => provider.providerId === pendingProviderId)
  const pendingModel = pendingProvider?.models.find(model => model.id === pendingModelId)
    ?? (pendingProviderId === 'openai'
      ? nativeModelsForProvider(native, 'openai')?.find(model => model.id === pendingModelId)
      : undefined)
  const effectiveModel = selectedModel ?? (native.model === undefined
    ? undefined
    : { id: native.model, label: native.modelLabel ?? copy.choose })
  const selectedModelLabel = friendlyModelLabel(effectiveModel?.label ?? copy.choose)
  const providerLabel = selected?.title
    ?? (native.modelProvider === 'openai'
      ? copy.official
      : native.providerLabel ?? copy.unknown)
  const intentProvider = providers.find(provider => provider.providerId === providerIntent)
  const displayedProvider = providerIntent !== undefined
    ? intentProvider
    : creationDisplay !== undefined
    ? providers.find(provider => provider.providerId === creationDisplay.providerId)
    : pendingProviderId !== undefined
    ? pendingProvider
    : preference === undefined
    ? selected
    : providers.find(provider => provider.providerId === preference.providerId)
  const displayedProviderId = providerIntent ?? creationDisplay?.providerId ?? pendingProviderId
    ?? preference?.providerId
    ?? native.modelProvider ?? ''
  const displayedProviderLabel = displayedProviderId === 'openai'
    ? copy.official
    : displayedProvider?.title ?? providerIntent ?? creationDisplay?.providerId ?? pendingProviderId
      ?? preference?.providerId
      ?? cachedDisplay?.providerId ?? providerLabel
  const creation = creationDisplay ?? (native.threadId === undefined ? native.pendingCreation : undefined)
  const creationModel = creation === undefined
    ? undefined
    : displayedProvider?.models.find(model => model.id === creation.model)
      ?? (creationDisplay !== undefined || displayedProviderId === 'openai'
        ? { id: creation.model, label: creation.model }
        : undefined)
  const displayedModel = providerIntent === undefined
    ? creationModel ?? pendingModel ?? (pendingModelId !== undefined
      ? { id: pendingModelId, label: pendingModelId }
      : preference === undefined
      ? effectiveModel
      : displayedProvider?.models.find(model => model.id === preference.model)
        ?? (preference.model === undefined ? undefined : { id: preference.model, label: preference.model }))
    : undefined
  const displayedModelId = providerIntent === undefined
    ? creationModel?.id ?? pendingModelId ?? displayedModel?.id
    : undefined
  const displayedModelLabel = friendlyModelLabel(displayedModel?.label ?? copy.choose)
  const menuProvider = providerIntent === undefined
    ? displayedProvider
    : intentProvider
  const menuModels = menuProvider?.models
    ?? (displayedProviderId === 'openai'
      ? nativeModelsForProvider(native, 'openai')
      : [])
  const disclosedModel = menuModels.find(model => model.id === displayedModelId)
  const disclosedModelLabel = friendlyModelLabel(disclosedModel?.label ?? copy.choose)
  const displayedNativeModel = nativeModelsForProvider(native, displayedProviderId)
    ?.find(model => model.id === displayedModelId)
  const catalogBacked = displayedProviderId !== 'openai' && displayedProvider !== undefined
  const selectedReasoningEffort = creationModel !== undefined
    ? creation?.reasoningEffort
    : pendingProviderId === undefined
    ? native.reasoningEffort
    : pendingEffort
  // Model availability stays provider-scoped; reasoning metadata can still describe
  // the pending model before its provider switch has reached the native control.
  const reasoning = resolveTargetReasoning(
    { providerId: displayedProviderId, model: displayedModelId ?? '' },
    selectedReasoningEffort,
    native.nativeModels ?? [],
    () => disclosedModel?.reasoningCapabilities ?? (catalogBacked ? null : undefined),
  )
  const reasoningEfforts = reasoning.efforts.length > 0
    ? reasoning.efforts
    : !reasoning.catalogBacked || displayedNativeModel?.id === native.model && native.model !== undefined
    ? native.reasoningEfforts ?? []
    : []
  const reasoningEffort = cachedDisplay !== undefined || creationModel !== undefined
      || reasoningEfforts.includes(selectedReasoningEffort ?? '')
    ? selectedReasoningEffort
    : reasoning.effort
  return {
    preference,
    selected,
    providerIntent,
    effectiveModel,
    selectedModelLabel,
    providerLabel,
    pendingProviderId,
    pendingModelId,
    queued,
    displayedProvider,
    displayedProviderId,
    displayedProviderLabel,
    displayedModel,
    displayedModelId,
    displayedModelLabel,
    menuProvider,
    menuModels,
    disclosedModel,
    disclosedModelLabel,
    displayedNativeModel,
    reasoningEfforts,
    reasoningEffort,
  }
}
