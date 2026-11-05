import type { ModelProviderModelV1, ModelProviderV1 } from '@cordisx/protocol/model-providers/v1'
import { equivalentModel } from './model-providers.js'
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
