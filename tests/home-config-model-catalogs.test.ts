import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig, parseHomeConfig } from '../packages/cli/src/config/home-config.js'

function configured(configModelCatalogs: unknown) {
  const base = createDefaultHomeConfig()
  return {
    ...base,
    apps: {
      codex: {
        defaultProfile: 'first',
        profiles: {
          first: { displayName: 'First', dataMode: 'shared', configModelCatalogs },
          second: { displayName: 'Second', dataMode: 'shared', configModelCatalogs: { gateway: 'second.json' } },
        },
      },
    },
  }
}

describe('profile config model catalogs', () => {
  it('preserves legacy defaults and isolates explicit mappings per profile', () => {
    expect(createDefaultHomeConfig().apps.codex?.profiles.default?.configModelCatalogs).toBeUndefined()
    const config = parseHomeConfig(configured({ gateway: 'first.json', other: '/local/other.json' }))
    expect(config.apps.codex?.profiles.first?.configModelCatalogs).toEqual({
      gateway: 'first.json',
      other: '/local/other.json',
    })
    expect(config.apps.codex?.profiles.second?.configModelCatalogs).toEqual({ gateway: 'second.json' })
    expect(parseHomeConfig(configured({})).apps.codex?.profiles.first?.configModelCatalogs).toEqual({})
  })

  it.each([
    null,
    [],
    'file',
    { openai: 'a.json' },
    { 'bad\nprovider': 'a.json' },
    { gateway: '' },
    { gateway: 'https://example.test/models.json' },
    { gateway: 'secret\npath' },
    { gateway: 1 },
    { gateway: 'x'.repeat(4097) },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`p${i}`, 'a.json'])),
  ])('rejects invalid mappings without echoing their values', value => {
    expect(() => parseHomeConfig(configured(value))).toThrow('configModelCatalogs')
  })
})
