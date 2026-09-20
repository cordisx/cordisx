import { describe, expect, it } from 'vitest'
import { resolveMarketplaceSourceReference } from '../packages/cli/src/management/source-reference.js'

const source = {
  url: 'https://plugins.example/marketplace.json',
  enabled: true,
  local: { name: 'team' },
}

describe('Marketplace source references', () => {
  it('resolves an exact Host-owned name and preserves canonical URL input', () => {
    expect(resolveMarketplaceSourceReference([source], 'team')).toBe(source.url)
    expect(resolveMarketplaceSourceReference([source], source.url)).toBe(source.url)
  })

  it('rejects names outside the selected profile, disabled sources, and duplicate names', () => {
    expect(() => resolveMarketplaceSourceReference([], 'team')).toThrow('source name was not found')
    expect(() => resolveMarketplaceSourceReference([{ ...source, enabled: false }], 'team')).toThrow(
      'source is disabled',
    )
    expect(() =>
      resolveMarketplaceSourceReference([
        source,
        { ...source, url: 'https://other.example/marketplace.json' },
      ], 'team')
    ).toThrow('source name is ambiguous')
  })
})
