import { describe, expect, it } from 'vitest'
import { providerMenuLabel } from '../packages/cli/src/renderer/model-provider-selector.js'

describe('providerMenuLabel', () => {
  it('shortens only the two generated native labels and preserves custom parentheses', () => {
    expect(providerMenuLabel({ providerId: 'modelhub', title: 'ModelHub (Native Direct)' })).toBe('ModelHub')
    expect(providerMenuLabel({ providerId: 'openrouter', title: 'OpenRouter (Native Responses)' })).toBe('OpenRouter')
    expect(providerMenuLabel({ providerId: 'custom', title: 'Custom (Team)' })).toBe('Custom (Team)')
    expect(providerMenuLabel({ providerId: 'modelhub', title: 'ModelHub (Team)' })).toBe('ModelHub (Team)')
  })
})
