import { type MarketplaceSearchCandidate, rankMarketplacePlugins } from './marketplace-ranking.js'

import type {
  MarketplaceCatalogPlugin,
  MarketplaceCatalogSearchOptions,
  MarketplaceCatalogSearchResult,
  MarketplaceFeedLocalization,
  MarketplacePluginLocalization,
  MarketplacePluginProjection,
  MarketplaceSourceProjection,
  MarketplaceSourceSnapshot,
} from './marketplace-types.js'
function canonicalDisplayLocale(value: string): string {
  try {
    return Intl.getCanonicalLocales(value)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

function currentLocaleChain(value: string): readonly string[] {
  const current = canonicalDisplayLocale(value)
  const language = current.split('-')[0]!
  return current === language ? [current] : [current, language]
}

function projectLocalizedField<T>(
  raw: T,
  localizations: Readonly<Record<string, MarketplacePluginLocalization | MarketplaceFeedLocalization>>,
  field: 'name' | 'description' | 'authors' | 'keywords',
  currentLocale: string,
  fallbackLocale: string,
): T {
  for (const locale of currentLocaleChain(currentLocale)) {
    if (locale === fallbackLocale) return raw
    const candidate = localizations[locale] as Readonly<Record<string, unknown>> | undefined
    if (candidate?.[field] !== undefined) return candidate[field] as T
  }
  return raw
}

/** Reproject cached feed metadata without refetching it. */
export function projectMarketplacePlugin(
  plugin: MarketplaceCatalogPlugin,
  currentLocale: string,
): MarketplacePluginProjection {
  const authorNames = projectLocalizedField(
    plugin.authors.map(author => author.name),
    plugin.localizations,
    'authors',
    currentLocale,
    plugin.fallbackLocale,
  )
  const authors = plugin.authors.map((author, index) => ({ ...author, name: authorNames[index] ?? author.name }))
  const name = projectLocalizedField(plugin.name, plugin.localizations, 'name', currentLocale, plugin.fallbackLocale)
  const description = projectLocalizedField(
    plugin.description,
    plugin.localizations,
    'description',
    currentLocale,
    plugin.fallbackLocale,
  )
  const keywords = projectLocalizedField(
    plugin.keywords,
    plugin.localizations,
    'keywords',
    currentLocale,
    plugin.fallbackLocale,
  )
  const feedName = projectLocalizedField(
    plugin.feedName,
    plugin.feedLocalizations,
    'name',
    currentLocale,
    plugin.feedFallbackLocale,
  )
  const searchMetadata = [
    name,
    description,
    ...authors.map(author => author.name),
    ...keywords,
    feedName,
    plugin.name,
    plugin.description,
    ...plugin.authors.map(author => author.name),
    ...plugin.keywords,
    plugin.feedName,
  ]
  for (const locale of [...new Set([...currentLocaleChain(currentLocale), plugin.fallbackLocale, 'en'])]) {
    const localization = plugin.localizations[locale]
    if (localization !== undefined) {
      searchMetadata.push(
        localization.name ?? '',
        localization.description ?? '',
        ...(localization.authors ?? []),
        ...(localization.keywords ?? []),
      )
    }
    const feedLocalization = plugin.feedLocalizations[locale]
    if (feedLocalization?.name !== undefined) searchMetadata.push(feedLocalization.name)
  }
  return Object.freeze({
    name,
    description,
    authors: Object.freeze(authors),
    keywords,
    feedName,
    searchValues: Object.freeze([
      ...searchMetadata.filter(value => value !== ''),
      plugin.id,
      plugin.version,
      plugin.source,
      plugin.feedUrl,
    ]),
  })
}

export function projectMarketplaceSourceName(
  source: MarketplaceSourceSnapshot,
  currentLocale: string,
): string | undefined {
  if (source.local?.name !== undefined) return source.local.name
  if (source.name === undefined) return undefined
  return projectLocalizedField(
    source.name,
    source.localizations ?? Object.freeze({}),
    'name',
    currentLocale,
    source.fallbackLocale ?? 'en',
  )
}

/** Project remote feed metadata with profile-local overrides without changing source identity or trust. */
export function projectMarketplaceSource(
  source: MarketplaceSourceSnapshot,
  currentLocale: string,
): MarketplaceSourceProjection {
  const remoteName = source.name === undefined
    ? undefined
    : projectLocalizedField(
      source.name,
      source.localizations ?? Object.freeze({}),
      'name',
      currentLocale,
      source.fallbackLocale ?? 'en',
    )
  const officialChinese = canonicalDisplayLocale(currentLocale).toLowerCase().startsWith('zh')
  const name = source.local?.name
    ?? remoteName
    ?? (source.official
      ? (officialChinese ? 'CordisX 官方插件商店' : 'CordisX Official Marketplace')
      : new URL(source.url).hostname)
  const description = source.local?.description
    ?? (source.official
      ? (officialChinese
        ? '由 CordisX 维护的默认插件发现来源。'
        : 'The default plugin discovery source maintained by CordisX.')
      : undefined)
  const searchValues = [
    name,
    description ?? '',
    source.local?.note ?? '',
    remoteName ?? '',
    source.name ?? '',
    source.url,
    new URL(source.url).hostname,
  ].filter(value => value !== '')
  return Object.freeze({
    name,
    ...(description === undefined ? {} : { description }),
    ...(source.local?.note === undefined ? {} : { note: source.local.note }),
    searchValues: Object.freeze([...new Set(searchValues)]),
  })
}

interface MarketplaceCatalogRankingCandidate extends MarketplaceSearchCandidate {
  readonly catalogPlugin: MarketplaceCatalogPlugin
  readonly projection: MarketplacePluginProjection
}

/** Locale-aware catalog projection coupled to the stable eligibility/text/trust ranking contract. */
export function searchMarketplaceCatalog(
  plugins: readonly MarketplaceCatalogPlugin[],
  options: MarketplaceCatalogSearchOptions,
): MarketplaceCatalogSearchResult[] {
  const candidates = plugins.map((plugin): MarketplaceCatalogRankingCandidate => {
    const projection = projectMarketplacePlugin(plugin, options.currentLocale)
    const eligibility = options.eligibility?.(plugin) ?? {}
    return {
      catalogPlugin: plugin,
      projection,
      identity: plugin.identity,
      id: plugin.id,
      name: projection.name,
      description: projection.description,
      source: plugin.source,
      authors: [...projection.authors.map(author => author.name), ...projection.searchValues],
      keywords: projection.keywords,
      official: plugin.official !== undefined,
      certified: plugin.certification !== undefined,
      ...eligibility,
    }
  })
  return rankMarketplacePlugins(candidates, {
    query: options.query,
    ...(options.certifiedOnly === undefined ? {} : { certifiedOnly: options.certifiedOnly }),
    ...(options.officialOnly === undefined ? {} : { officialOnly: options.officialOnly }),
  }).map(result => ({
    plugin: result.plugin.catalogPlugin,
    projection: result.plugin.projection,
    ranking: result.ranking,
  }))
}
