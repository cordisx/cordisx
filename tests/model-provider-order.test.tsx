import { describe, expect, it } from 'vitest'
import {
  nativeModelsForProvider,
  orderProviderRows,
  type ProviderSelectionSnapshot,
} from '../packages/cli/src/renderer/model-provider-selector.js'

describe('provider display order', () => {
  it('keeps unusable rows first and moves usable favorites nearest the trigger', () => {
    const rows = [
      { id: 'ordinary-one', usable: true, favorite: false },
      { id: 'favorite-one', usable: true, favorite: true },
      { id: 'empty-favorite', usable: false, favorite: true },
      { id: 'ordinary-two', usable: true, favorite: false },
      { id: 'favorite-two', usable: true, favorite: true },
      { id: 'empty', usable: false, favorite: false },
    ]

    expect(orderProviderRows(rows).map(row => row.id)).toEqual([
      'empty-favorite',
      'empty',
      'ordinary-one',
      'ordinary-two',
      'favorite-one',
      'favorite-two',
    ])
  })

  it('does not attribute a global native catalog to the effective provider', () => {
    const snapshot: ProviderSelectionSnapshot = {
      available: true,
      busy: false,
      modelProvider: 'openai',
      model: 'gpt-6-astra',
      nativeModelsScope: 'global',
      nativeModels: [
        { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', disabled: false },
        { id: 'gpt-6-astra', label: 'GPT-6-Astra', disabled: false },
      ],
      nativeModelAssignments: [{ providerId: 'openai', model: 'gpt-6-astra' }],
    }

    expect(nativeModelsForProvider(snapshot, 'openai')).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', disabled: false },
    ])
    expect(nativeModelsForProvider(snapshot, 'deepseek')).toEqual([])
    expect(nativeModelsForProvider({
      ...snapshot,
      pendingProviderId: 'deepseek',
      pendingModel: 'deepseek-v4-flash',
    }, 'deepseek')).toEqual([])
    expect(nativeModelsForProvider({
      ...snapshot,
      nativeModelAssignments: [
        ...snapshot.nativeModelAssignments!,
        { providerId: 'deepseek', model: 'deepseek-v4-flash' },
      ],
    }, 'deepseek')).toEqual([
      { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', disabled: false },
    ])
  })

  it('keeps active-provider native models with their confirmed source provider', () => {
    const openaiModels = [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', disabled: false }]
    const deepseekModels = [{ id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', disabled: false }]
    const openai: ProviderSelectionSnapshot = {
      available: true,
      busy: false,
      modelProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      nativeModelsScope: 'active-provider',
      nativeModelsProviderId: 'openai',
      nativeModels: openaiModels,
    }

    expect(nativeModelsForProvider(openai, 'openai')).toEqual(openaiModels)
    expect(nativeModelsForProvider(openai, 'deepseek')).toEqual([])
    expect(nativeModelsForProvider({
      ...openai,
      pendingProviderId: 'deepseek',
      pendingModel: 'deepseek-v4-flash',
    }, 'deepseek')).toEqual([])

    const deepseek: ProviderSelectionSnapshot = {
      ...openai,
      modelProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      nativeModelsProviderId: 'deepseek',
      nativeModels: deepseekModels,
      pendingProviderId: undefined,
      pendingModel: undefined,
    }
    expect(nativeModelsForProvider(deepseek, 'deepseek')).toEqual(deepseekModels)
    expect(nativeModelsForProvider(deepseek, 'openai')).toEqual([])

    expect(nativeModelsForProvider(openai, 'openai')).toEqual(openaiModels)
    expect(nativeModelsForProvider({ ...openai, nativeModelsProviderId: undefined }, 'openai')).toEqual([])
  })
})
