import { describe, expect, it } from 'vitest'
import { headlessConfiguredProviders } from '../packages/cli/src/launcher/headless-configured-providers.js'

describe('headless configured provider catalog', () => {
  it('does not borrow capability evidence from a different provider with the same model ID', () => {
    const configured = headlessConfiguredProviders({
      CORDISX_HEADLESS_PROVIDER_ID: 'aiden',
      CORDISX_HEADLESS_MODEL_ID: 'same-id',
    }, [{
      id: 'same-id',
      label: 'native',
      aliases: [],
      supportsFastMode: true,
      reasoningCapabilities: { efforts: ['high'] },
    }])
    expect(configured?.[0]?.models[0]).toEqual({
      id: 'same-id',
      label: 'same-id',
      aliases: [],
      supportsFastMode: false,
    })
  })
  it('rejects incomplete or ambiguous operator catalogs', () => {
    expect(() => headlessConfiguredProviders({ CORDISX_HEADLESS_PROVIDER_ID: 'aiden' }, []))
      .toThrow('HEADLESS_MODEL_CATALOG_INVALID')
    expect(() =>
      headlessConfiguredProviders({
        CORDISX_HEADLESS_PROVIDER_ID: 'aiden',
        CORDISX_HEADLESS_MODEL_ID: 'first',
        CORDISX_HEADLESS_EXTRA_PROVIDER: 'aiden',
        CORDISX_HEADLESS_EXTRA_MODELS: 'second',
      }, [])
    ).toThrow('HEADLESS_MODEL_CATALOG_INVALID')
  })
  it('admits more than two shared providers while preserving the legacy selection and capability isolation', () => {
    const declared = Array.from({ length: 5 }, (_, index) => ({
      providerId: index === 0 ? 'primary' : 'service-' + index,
      pluginId: 'model-service',
      models: [{ id: 'shared', label: 'Shared', aliases: [] }],
      defaultModelId: 'shared',
    }))
    const catalog = headlessConfiguredProviders(
      {
        CORDISX_HEADLESS_PROVIDER_ID: 'primary',
        CORDISX_HEADLESS_MODEL_ID: 'original',
        CORDISX_HEADLESS_EXTRA_PROVIDER: 'extra',
        CORDISX_HEADLESS_EXTRA_MODELS: 'second',
      },
      [],
      declared,
    )
    expect(catalog?.map(provider => provider.providerId)).toEqual([
      'primary',
      'extra',
      'service-1',
      'service-2',
      'service-3',
      'service-4',
    ])
    expect(catalog?.[0]?.defaultModelId).toBe('original')
    expect(catalog?.[0]?.models.map(model => model.id)).toEqual(['original', 'shared'])
  })
  it('retains native OpenAI models and defaults when only shared services are configured', () => {
    const native = [{ id: 'native', label: 'Native', aliases: [], supportsFastMode: true }]
    const catalog = headlessConfiguredProviders({}, native, [{
      providerId: 'service',
      pluginId: 'model-service',
      models: [{ id: 'native', label: 'External', aliases: [] }],
    }], 'native')
    expect(catalog?.[0]).toMatchObject({ providerId: 'openai', defaultModelId: 'native', models: native })
    expect(catalog?.[1]?.models[0]).not.toHaveProperty('supportsFastMode')
  })
})
