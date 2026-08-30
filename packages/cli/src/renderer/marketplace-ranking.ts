export type MarketplaceTextTier =
  | 'exact-identity'
  | 'exact-name'
  | 'primary-prefix'
  | 'all-primary-terms'
  | 'all-catalog-terms'
  | 'partial-catalog'
  | 'browse'

export interface MarketplaceSearchCandidate {
  readonly identity: string
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: string
  readonly authors: readonly string[]
  readonly keywords: readonly string[]
  readonly official: boolean
  readonly certified: boolean
  readonly compatible?: boolean
  readonly visible?: boolean
  readonly policyBlocked?: boolean
}

export interface MarketplaceSearchOptions {
  readonly query: string
  readonly certifiedOnly?: boolean
  readonly officialOnly?: boolean
}

export interface MarketplaceRankingExplanation {
  readonly textTier: MarketplaceTextTier
  readonly textScore: number
  /** Bounded product priority. Certified is deliberately absent from ranking. */
  readonly officialPriority: 0 | 1
  readonly scoreWithinTier: number
  readonly stableIdentity: string
}

export interface MarketplaceSearchResult<Candidate extends MarketplaceSearchCandidate = MarketplaceSearchCandidate> {
  readonly plugin: Candidate
  readonly ranking: MarketplaceRankingExplanation
}

interface TextRanking {
  readonly tier: MarketplaceTextTier
  readonly order: number
  readonly score: number
}

const TEXT_TIER_ORDER: Readonly<Record<MarketplaceTextTier, number>> = Object.freeze({
  'exact-identity': 0,
  'exact-name': 1,
  'primary-prefix': 2,
  'all-primary-terms': 3,
  'all-catalog-terms': 4,
  'partial-catalog': 5,
  browse: 6,
})

function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ')
}

function compareStableIdentity(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function rankText(candidate: MarketplaceSearchCandidate, normalizedQuery: string): TextRanking | undefined {
  if (normalizedQuery === '') return { tier: 'browse', order: TEXT_TIER_ORDER.browse, score: 0 }

  const id = normalizeSearchText(candidate.id)
  const identity = normalizeSearchText(candidate.identity)
  const name = normalizeSearchText(candidate.name)
  const primary = `${id} ${name}`
  const catalog = normalizeSearchText([
    candidate.id,
    candidate.name,
    candidate.description,
    candidate.source,
    ...candidate.authors,
    ...candidate.keywords,
  ].join(' '))
  const terms = normalizedQuery.split(' ')

  if (normalizedQuery === id || normalizedQuery === identity) {
    return { tier: 'exact-identity', order: TEXT_TIER_ORDER['exact-identity'], score: 100 }
  }
  if (normalizedQuery === name) return { tier: 'exact-name', order: TEXT_TIER_ORDER['exact-name'], score: 96 }
  if (id.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) {
    return { tier: 'primary-prefix', order: TEXT_TIER_ORDER['primary-prefix'], score: 80 }
  }
  if (terms.every(term => primary.includes(term))) {
    const wholeTermMatches = terms.filter(term => id.split(/[._-]/).includes(term) || name.split(' ').includes(term)).length
    return { tier: 'all-primary-terms', order: TEXT_TIER_ORDER['all-primary-terms'], score: 60 + wholeTermMatches }
  }
  if (terms.every(term => catalog.includes(term))) {
    return { tier: 'all-catalog-terms', order: TEXT_TIER_ORDER['all-catalog-terms'], score: 40 }
  }
  const matchingTerms = terms.filter(term => catalog.includes(term)).length
  if (matchingTerms === 0) return undefined
  return {
    tier: 'partial-catalog',
    order: TEXT_TIER_ORDER['partial-catalog'],
    score: Math.round((20 * matchingTerms) / terms.length),
  }
}

/**
 * Search order is a lexicographic contract, not one unbounded score:
 * eligibility -> text tier -> bounded Official priority inside that tier -> canonical identity.
 * Certified remains a filterable exact-artifact review state and never changes order.
 */
export function rankMarketplacePlugins<Candidate extends MarketplaceSearchCandidate>(
  candidates: readonly Candidate[],
  options: MarketplaceSearchOptions,
): MarketplaceSearchResult<Candidate>[] {
  const normalizedQuery = normalizeSearchText(options.query)
  const ranked: Array<MarketplaceSearchResult<Candidate> & { readonly tierOrder: number }> = []

  for (const plugin of candidates) {
    if (plugin.compatible === false || plugin.visible === false || plugin.policyBlocked === true) continue
    if (options.certifiedOnly === true && !plugin.certified) continue
    if (options.officialOnly === true && !plugin.official) continue

    const text = rankText(plugin, normalizedQuery)
    if (text === undefined) continue
    const officialPriority: 0 | 1 = plugin.official ? 1 : 0
    ranked.push({
      plugin,
      tierOrder: text.order,
      ranking: {
        textTier: text.tier,
        textScore: text.score,
        officialPriority,
        scoreWithinTier: text.score + officialPriority,
        stableIdentity: plugin.identity,
      },
    })
  }

  ranked.sort((left, right) => left.tierOrder - right.tierOrder
    || right.ranking.scoreWithinTier - left.ranking.scoreWithinTier
    || compareStableIdentity(left.ranking.stableIdentity, right.ranking.stableIdentity))
  return ranked.map(({ plugin, ranking }) => ({ plugin, ranking }))
}
