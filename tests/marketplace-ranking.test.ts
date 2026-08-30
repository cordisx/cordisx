import { describe, expect, it } from 'vitest'
import {
  rankMarketplacePlugins,
  type MarketplaceSearchCandidate,
} from '../packages/cli/src/renderer/marketplace-ranking.js'

function candidate(
  id: string,
  overrides: Partial<MarketplaceSearchCandidate> = {},
): MarketplaceSearchCandidate {
  return {
    identity: `https://github.com/example/${id}\u0000${id}`,
    id,
    name: id.split('-').map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' '),
    description: `${id} integration for CordisX`,
    source: `https://github.com/example/${id}`,
    authors: ['Example publisher'],
    keywords: ['integration'],
    official: false,
    certified: false,
    ...overrides,
  }
}

describe('marketplace ranking', () => {
  it('filters ineligible and policy-blocked entries before text ranking', () => {
    const result = rankMarketplacePlugins([
      candidate('visible'),
      candidate('incompatible', { compatible: false, official: true, certified: true }),
      candidate('hidden', { visible: false, official: true, certified: true }),
      candidate('blocked', { policyBlocked: true, official: true, certified: true }),
    ], { query: '' })

    expect(result.map(item => item.plugin.id)).toEqual(['visible'])
  })

  it('never lets Official priority cross a text relevance tier', () => {
    const result = rankMarketplacePlugins([
      candidate('trace', { name: 'Trace', official: false, certified: false }),
      candidate('helper', {
        name: 'Unrelated helper',
        description: 'A utility that mentions trace once',
        official: true,
        certified: true,
      }),
    ], { query: 'trace' })

    expect(result.map(item => item.plugin.id)).toEqual(['trace', 'helper'])
    expect(result[0]?.ranking).toEqual(expect.objectContaining({ textTier: 'exact-identity', officialPriority: 0 }))
    expect(result[1]?.ranking).toEqual(expect.objectContaining({ textTier: 'all-catalog-terms', officialPriority: 1 }))
  })

  it('models all four states but gives bounded product priority only to Official', () => {
    const result = rankMarketplacePlugins([
      candidate('plain', { name: 'Plain Tool', description: 'trace integration' }),
      candidate('certified', { name: 'Certified Tool', description: 'trace integration', certified: true }),
      candidate('official', { name: 'Official Tool', description: 'trace integration', official: true }),
      candidate('both', { name: 'Both Tool', description: 'trace integration', official: true, certified: true }),
    ], { query: 'trace' })

    expect(result.map(item => item.plugin.id)).toEqual(['both', 'official', 'certified', 'plain'])
    expect(result.map(item => [item.ranking.officialPriority, item.ranking.scoreWithinTier]))
      .toEqual([[1, 41], [1, 41], [0, 40], [0, 40]])
    expect(result[0]?.ranking).not.toHaveProperty('certificationBoost')
    expect(result[2]?.ranking).not.toHaveProperty('certificationBoost')
  })

  it('supports certified-only filtering without treating Official as Certified', () => {
    const result = rankMarketplacePlugins([
      candidate('official-only', { official: true }),
      candidate('third-party-certified', { certified: true }),
      candidate('official-certified', { official: true, certified: true }),
    ], { query: '', certifiedOnly: true })

    expect(result.map(item => item.plugin.id)).toEqual(['official-certified', 'third-party-certified'])
  })

  it('uses canonical identity as a stable final tie-break independent of feed order', () => {
    const alpha = candidate('alpha', { description: 'trace integration' })
    const beta = candidate('beta', { description: 'trace integration' })
    const first = rankMarketplacePlugins([beta, alpha], { query: 'trace' })
    const second = rankMarketplacePlugins([alpha, beta], { query: 'trace' })

    expect(first.map(item => item.plugin.identity)).toEqual(second.map(item => item.plugin.identity))
    expect(first.map(item => item.plugin.id)).toEqual(['alpha', 'beta'])
  })
})
