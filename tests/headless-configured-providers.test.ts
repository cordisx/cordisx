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
})
