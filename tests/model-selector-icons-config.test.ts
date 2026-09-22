import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig, parseHomeConfig } from '../packages/cli/src/config/home-config.js'

function configured(selectorIcons: unknown) {
  const base = createDefaultHomeConfig()
  return {
    ...base,
    apps: {
      codex: {
        defaultProfile: 'first',
        profiles: {
          first: { displayName: 'First', dataMode: 'shared', selectorIcons },
          second: { displayName: 'Second', dataMode: 'shared' },
        },
      },
    },
  }
}

describe('profile model selector icons', () => {
  it('keeps separate provider and exact provider-local model overrides', () => {
    const parsed = parseHomeConfig(configured({
      providers: { gateway: 'openrouter', moonshot: 'generic' },
      models: {
        gateway: { 'openai/gpt-5.6': 'openai', 'anthropic/claude': 'claude' },
        moonshot: { 'kimi-k2.5': 'kimi' },
      },
    }))
    expect(parsed.apps.codex?.profiles.first?.selectorIcons).toEqual({
      providers: { gateway: 'openrouter', moonshot: 'generic' },
      models: {
        gateway: { 'openai/gpt-5.6': 'openai', 'anthropic/claude': 'claude' },
        moonshot: { 'kimi-k2.5': 'kimi' },
      },
    })
    expect(parsed.apps.codex?.profiles.second?.selectorIcons).toBeUndefined()
  })

  it.each([
    null,
    [],
    { extra: {} },
    { providers: { openai: 'generic' } },
    { models: { openai: { gpt: 'openai' } } },
    { providers: { gateway: 'claude' } },
    { models: { gateway: { model: 'openrouter' } } },
    { providers: { gateway: 'https://example.test/icon.svg' } },
    { models: { gateway: { 'bad\nmodel': 'generic' } } },
  ])('rejects invalid selector icon settings without accepting arbitrary assets', value => {
    expect(() => parseHomeConfig(configured(value))).toThrow('selectorIcons')
  })
})
