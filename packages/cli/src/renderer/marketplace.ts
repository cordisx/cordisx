import {
  rankMarketplacePlugins,
  type MarketplaceRankingExplanation,
  type MarketplaceSearchCandidate,
} from './marketplace-ranking.js'
import {
  evaluateMarketplaceTrust,
  type MarketplaceCertificationRecord,
  type MarketplaceOfficialRecord,
  type MarketplaceTrustEvaluation,
} from './marketplace-trust.js'
import {
  BrowserMarketplaceFeedCache,
  marketplaceCacheAge,
} from './marketplace-cache.js'
import {
  BrowserMarketplaceSourceStore,
  OFFICIAL_MARKETPLACE_SOURCE,
  normalizeMarketplaceSource,
  parseMarketplaceSourceImport,
  type MarketplaceSourceRecord,
  type MarketplaceStorage,
} from './marketplace-source.js'

export {
  MARKETPLACE_SOURCE_RECORDS_KEY,
  MARKETPLACE_SOURCE_SCHEMA_V1,
  MARKETPLACE_SOURCES_KEY,
  OFFICIAL_MARKETPLACE_SOURCE,
  isOfficialMarketplaceSource,
  normalizeMarketplaceSource,
  parseMarketplaceSourceImport,
  type MarketplaceSourceImportV1,
  type MarketplaceSourceLocalOverrides,
  type MarketplaceSourceRecord,
  type MarketplaceStorage,
} from './marketplace-source.js'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PLUGIN_SCHEMAS = Object.freeze({
  1: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json',
  2: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json',
  3: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v3.schema.json',
  4: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v4.schema.json',
})
const FEED_SCHEMAS = Object.freeze({
  1: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json',
  2: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
  3: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v3.schema.json',
  4: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v4.schema.json',
})

export interface MarketplaceAuthor {
  readonly name: string
  readonly url?: string
}

export interface MarketplacePluginLocalization {
  readonly name?: string
  readonly description?: string
  readonly authors?: readonly string[]
  readonly keywords?: readonly string[]
}

export interface MarketplaceFeedLocalization {
  readonly name?: string
}

export interface MarketplaceArtifact {
  readonly publisherIdentity: string
  readonly packageNamespace: string
  readonly packageName: string
  readonly downloadUrl: string
  readonly integrity: string
}
export interface MarketplaceCommerceDescriptor {
  readonly purchaseUrl: string
  readonly manageUrl?: string
  readonly recoveryUrl?: string
  readonly environment: 'sandbox' | 'live'
}

export interface MarketplacePlugin {
  readonly schemaVersion: 1 | 2 | 3 | 4
  readonly id: string
  /** Locale of the required base display metadata; v1 projects as legacy `en`. */
  readonly fallbackLocale: string
  readonly name: string
  readonly description: string
  readonly localizations: Readonly<Record<string, MarketplacePluginLocalization>>
  readonly version: string
  readonly source: string
  readonly homepage?: string
  readonly icon?: string
  readonly manifest?: string
  readonly artifact?: MarketplaceArtifact
  readonly commerce?: MarketplaceCommerceDescriptor
  readonly license: string
  readonly compatibility: { readonly cordisx: string }
  readonly authors: readonly MarketplaceAuthor[]
  readonly keywords: readonly string[]
}

export interface MarketplaceCatalogPlugin extends MarketplacePlugin {
  readonly identity: string
  readonly feedUrl: string
  readonly feedName: string
  readonly feedFallbackLocale: string
  readonly feedLocalizations: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly feedHomepage: string
  readonly official?: MarketplaceOfficialRecord
  readonly certification?: MarketplaceCertificationRecord
}

export interface MarketplacePluginProjection {
  readonly name: string
  readonly description: string
  readonly authors: readonly MarketplaceAuthor[]
  readonly keywords: readonly string[]
  readonly feedName: string
  /** Current projection, fallback/English metadata, and canonical machine terms. */
  readonly searchValues: readonly string[]
}

export interface MarketplaceCatalogEligibility {
  readonly compatible?: boolean
  readonly visible?: boolean
  readonly policyBlocked?: boolean
}

export interface MarketplaceCatalogSearchOptions {
  readonly query: string
  readonly currentLocale: string
  readonly certifiedOnly?: boolean
  readonly officialOnly?: boolean
  readonly eligibility?: (plugin: MarketplaceCatalogPlugin) => MarketplaceCatalogEligibility
}

export interface MarketplaceCatalogSearchResult {
  readonly plugin: MarketplaceCatalogPlugin
  readonly projection: MarketplacePluginProjection
  readonly ranking: MarketplaceRankingExplanation
}

export interface MarketplaceSourceSnapshot {
  readonly url: string
  readonly status: 'loading' | 'loaded' | 'failed'
  readonly phase: 'disabled' | 'idle' | 'revalidating' | 'fresh' | 'stale' | 'error'
  readonly enabled: boolean
  readonly official: boolean
  readonly stale: boolean
  readonly revalidating: boolean
  readonly attempts: number
  readonly local?: MarketplaceSourceRecord['local']
  readonly name?: string
  readonly fallbackLocale?: string
  readonly localizations?: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly homepage?: string
  readonly pluginCount?: number
  readonly trusted?: boolean
  readonly lastSuccessAt?: string
  readonly error?: string
}

export interface MarketplaceSourceProjection {
  readonly name: string
  readonly description?: string
  readonly note?: string
  readonly searchValues: readonly string[]
}

export interface MarketplaceDuplicate {
  readonly identity: string
  readonly winnerFeedUrl: string
  readonly duplicateFeedUrl: string
}

export interface MarketplaceSnapshot {
  readonly sources: readonly string[]
  readonly sourceRecords: readonly MarketplaceSourceRecord[]
  readonly sourceStates: readonly MarketplaceSourceSnapshot[]
  readonly plugins: readonly MarketplaceCatalogPlugin[]
  readonly duplicates: readonly MarketplaceDuplicate[]
  readonly loading: boolean
  readonly revalidating: boolean
}

export interface MarketplaceModel {
  snapshot(): MarketplaceSnapshot
  setSources(sources: readonly string[]): Promise<void>
  setSourceRecords(sources: readonly MarketplaceSourceRecord[]): Promise<void>
  upsertSource(source: MarketplaceSourceRecord): Promise<void>
  removeSource(url: string): Promise<void>
  setSourceEnabled(url: string, enabled: boolean): Promise<void>
  moveSource(url: string, targetIndex: number): Promise<void>
  importSource(value: string): Promise<MarketplaceSourceRecord>
  reload(): Promise<void>
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface MarketplaceResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type MarketplaceFetcher = (url: string, init: RequestInit) => Promise<MarketplaceResponse>

interface ParsedFeed {
  readonly schemaVersion: 1 | 2 | 3 | 4
  readonly fallbackLocale: string
  readonly name: string
  readonly localizations: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly homepage: string
  readonly plugins: readonly MarketplacePlugin[]
  readonly trust?: MarketplaceTrustEvaluation
}

export interface MarketplaceFeedParseOptions {
  readonly feedUrl: string
  readonly trustedRoots: readonly string[]
  readonly now?: string
}

interface LoadResult {
  readonly state: MarketplaceSourceSnapshot
  readonly feed?: ParsedFeed
}

export interface MarketplaceModelOptions {
  readonly now?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly retryDelays?: readonly number[]
  readonly staleAfterMs?: number
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须是 JSON object')
  return value as Record<string, unknown>
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key))
  if (unexpected.length > 0) throw new Error(`${label} 包含不支持的字段: ${unexpected.join(', ')}`)
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} 必须是 1-${maxLength} 个字符的字符串`)
  }
  return value
}

function canonicalLocale(value: unknown, label: string): string {
  const locale = requiredString(value, label, 48)
  let canonical: string | undefined
  try {
    ;[canonical] = Intl.getCanonicalLocales(locale)
  } catch {
    throw new Error(`${label} 不是有效 locale`)
  }
  if (canonical !== locale) throw new Error(`${label} 必须使用 canonical locale`)
  return canonical
}

function localizedStrings(value: unknown, label: string, maxItems: number, maxLength: number, minItems = 1): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new Error(`${label} 必须包含 ${minItems}-${maxItems} 个字符串`)
  }
  const items = value.map((item, index) => requiredString(item, `${label}[${index}]`, maxLength))
  if (new Set(items).size !== items.length) throw new Error(`${label} 包含重复项`)
  return items
}

function parsePluginLocalizations(
  value: unknown,
  fallbackLocale: string,
  authorCount: number,
  label: string,
): Readonly<Record<string, MarketplacePluginLocalization>> {
  if (value === undefined) return Object.freeze({})
  const localizations = record(value)
  if (Object.keys(localizations).length > 32) throw new Error(`${label} 最多包含 32 个 locale`)
  const parsed: Record<string, MarketplacePluginLocalization> = Object.create(null) as Record<string, MarketplacePluginLocalization>
  for (const [localeValue, rawLocalization] of Object.entries(localizations)) {
    const locale = canonicalLocale(localeValue, `${label}.${localeValue}`)
    if (locale === fallbackLocale) throw new Error(`${label} 不得重复 fallbackLocale ${locale}`)
    const localization = record(rawLocalization)
    assertKeys(localization, ['name', 'description', 'authors', 'keywords'], `${label}.${locale}`)
    if (Object.keys(localization).length === 0) throw new Error(`${label}.${locale} 不能为空`)
    const authors = localization.authors === undefined
      ? undefined
      : localizedStrings(localization.authors, `${label}.${locale}.authors`, 20, 80)
    if (authors !== undefined && authors.length !== authorCount) {
      throw new Error(`${label}.${locale}.authors 必须保持作者顺序和数量`)
    }
    const keywords = localization.keywords === undefined
      ? undefined
      : localizedStrings(localization.keywords, `${label}.${locale}.keywords`, 20, 64, 0)
    parsed[locale] = Object.freeze({
      ...(localization.name === undefined ? {} : { name: requiredString(localization.name, `${label}.${locale}.name`, 80) }),
      ...(localization.description === undefined ? {} : { description: requiredString(localization.description, `${label}.${locale}.description`, 280) }),
      ...(authors === undefined ? {} : { authors }),
      ...(keywords === undefined ? {} : { keywords }),
    })
  }
  return Object.freeze(parsed)
}

function parseFeedLocalizations(
  value: unknown,
  fallbackLocale: string,
  label: string,
): Readonly<Record<string, MarketplaceFeedLocalization>> {
  if (value === undefined) return Object.freeze({})
  const localizations = record(value)
  if (Object.keys(localizations).length > 32) throw new Error(`${label} 最多包含 32 个 locale`)
  const parsed: Record<string, MarketplaceFeedLocalization> = Object.create(null) as Record<string, MarketplaceFeedLocalization>
  for (const [localeValue, rawLocalization] of Object.entries(localizations)) {
    const locale = canonicalLocale(localeValue, `${label}.${localeValue}`)
    if (locale === fallbackLocale) throw new Error(`${label} 不得重复 fallbackLocale ${locale}`)
    const localization = record(rawLocalization)
    assertKeys(localization, ['name'], `${label}.${locale}`)
    if (localization.name === undefined) throw new Error(`${label}.${locale}.name 是必填字符串`)
    parsed[locale] = Object.freeze({ name: requiredString(localization.name, `${label}.${locale}.name`, 100) })
  }
  return Object.freeze(parsed)
}

function canonicalDisplayLocale(value: string): string {
  try { return Intl.getCanonicalLocales(value)[0] ?? 'en' } catch { return 'en' }
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
export function projectMarketplacePlugin(plugin: MarketplaceCatalogPlugin, currentLocale: string): MarketplacePluginProjection {
  const authorNames = projectLocalizedField(
    plugin.authors.map(author => author.name),
    plugin.localizations,
    'authors',
    currentLocale,
    plugin.fallbackLocale,
  )
  const authors = plugin.authors.map((author, index) => ({ ...author, name: authorNames[index] ?? author.name }))
  const name = projectLocalizedField(plugin.name, plugin.localizations, 'name', currentLocale, plugin.fallbackLocale)
  const description = projectLocalizedField(plugin.description, plugin.localizations, 'description', currentLocale, plugin.fallbackLocale)
  const keywords = projectLocalizedField(plugin.keywords, plugin.localizations, 'keywords', currentLocale, plugin.fallbackLocale)
  const feedName = projectLocalizedField(plugin.feedName, plugin.feedLocalizations, 'name', currentLocale, plugin.feedFallbackLocale)
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
    if (localization !== undefined) searchMetadata.push(
      localization.name ?? '',
      localization.description ?? '',
      ...(localization.authors ?? []),
      ...(localization.keywords ?? []),
    )
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

export function projectMarketplaceSourceName(source: MarketplaceSourceSnapshot, currentLocale: string): string | undefined {
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
export function projectMarketplaceSource(source: MarketplaceSourceSnapshot, currentLocale: string): MarketplaceSourceProjection {
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
    ?? (source.official ? (officialChinese ? 'CordisX 官方插件商店' : 'CordisX Official Marketplace') : new URL(source.url).hostname)
  const description = source.local?.description
    ?? (source.official
      ? (officialChinese ? '由 CordisX 维护的默认插件发现来源。' : 'The default plugin discovery source maintained by CordisX.')
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

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const text = requiredString(value, label, 2048)
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error(`${label} 必须是无凭据 HTTPS URL`)
  return url.href
}

function parseArtifact(value: unknown, label: string): MarketplaceArtifact | undefined {
  if (value === undefined) return undefined
  const artifact = record(value)
  assertKeys(artifact, ['publisherIdentity', 'packageNamespace', 'packageName', 'downloadUrl', 'integrity'], label)
  const publisherIdentity = requiredString(artifact.publisherIdentity, `${label}.publisherIdentity`, 128)
  const packageNamespace = requiredString(artifact.packageNamespace, `${label}.packageNamespace`, 128)
  const packageName = requiredString(artifact.packageName, `${label}.packageName`, 214)
  if (!/^npm:@[a-z0-9][a-z0-9._-]*$/.test(publisherIdentity)) throw new Error(`${label}.publisherIdentity 不受支持`)
  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(packageNamespace)) throw new Error(`${label}.packageNamespace 不受支持`)
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error(`${label}.packageName 不受支持`)
  if (publisherIdentity !== `npm:${packageNamespace}`) throw new Error(`${label}.publisherIdentity 与 packageNamespace 不匹配`)
  if (!packageName.startsWith(`${packageNamespace}/`)) throw new Error(`${label}.packageName 不属于 packageNamespace`)
  const downloadUrl = requiredString(artifact.downloadUrl, `${label}.downloadUrl`, 2048)
  const parsedDownload = new URL(downloadUrl)
  if (parsedDownload.protocol !== 'https:' || parsedDownload.username !== '' || parsedDownload.password !== ''
    || parsedDownload.search !== '' || parsedDownload.hash !== '' || parsedDownload.href !== downloadUrl) {
    throw new Error(`${label}.downloadUrl 必须是 canonical HTTPS artifact URL`)
  }
  const integrity = requiredString(artifact.integrity, `${label}.integrity`, 71)
  if (!/^sha256:[a-f0-9]{64}$/.test(integrity)) throw new Error(`${label}.integrity 必须是 sha256 digest`)
  return { publisherIdentity, packageNamespace, packageName, downloadUrl, integrity }
}

function parseCommerce(value: unknown, label: string): MarketplaceCommerceDescriptor | undefined {
  if (value === undefined) return undefined
  const commerce = record(value)
  assertKeys(commerce, ['$schema', 'schemaVersion', 'mode', 'purchaseUrl', 'manageUrl', 'recoveryUrl', 'authorization'], label)
  if (commerce.$schema !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/commerce-descriptor.v1.schema.json' || commerce.schemaVersion !== 1 || commerce.mode !== 'external-publisher-v1') {
    throw new Error(`${label} schema 不受支持`)
  }
  const purchaseUrl = optionalHttpsUrl(commerce.purchaseUrl, `${label}.purchaseUrl`)
  if (purchaseUrl === undefined) throw new Error(`${label}.purchaseUrl 是必填 HTTPS URL`)
  const authorization = record(commerce.authorization)
  assertKeys(authorization, ['method', 'environment'], `${label}.authorization`)
  if (authorization.method !== 'publisher-grant.v1' || (authorization.environment !== 'sandbox' && authorization.environment !== 'live')) {
    throw new Error(`${label}.authorization 不受支持`)
  }
  const manageUrl = optionalHttpsUrl(commerce.manageUrl, `${label}.manageUrl`)
  const recoveryUrl = optionalHttpsUrl(commerce.recoveryUrl, `${label}.recoveryUrl`)
  return { purchaseUrl, ...(manageUrl === undefined ? {} : { manageUrl }), ...(recoveryUrl === undefined ? {} : { recoveryUrl }), environment: authorization.environment }
}

/** Canonical plugin source used with the lowercase plugin id as cross-feed identity. */
export function canonicalPluginSource(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('plugin source 必须是无凭据、query、fragment 的 HTTPS URL')
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href
}

export function marketplacePluginIdentity(source: string, id: string): string {
  return `${canonicalPluginSource(source)}\u0000${id}`
}

function parsePlugin(value: unknown, index: number): MarketplacePlugin {
  const plugin = record(value)
  const schemaVersion = plugin.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4) throw new Error(`plugins[${index}].schemaVersion 不受支持`)
  assertKeys(plugin, [
    '$schema',
    'schemaVersion',
    'id',
    'name',
    'description',
    'version',
    'source',
    'homepage',
    'icon',
    'manifest',
    'license',
    'compatibility',
    'authors',
    'keywords',
    ...(schemaVersion >= 2 ? ['fallbackLocale', 'localizations'] : []),
    ...(schemaVersion >= 3 ? ['artifact'] : []),
    ...(schemaVersion === 4 ? ['commerce'] : []),
  ], `plugins[${index}]`)
  if (plugin.$schema !== PLUGIN_SCHEMAS[schemaVersion]) throw new Error(`plugins[${index}].$schema 不受支持`)
  const id = requiredString(plugin.id, `plugins[${index}].id`, 96)
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`plugins[${index}].id 不是小写规范 id`)
  const version = requiredString(plugin.version, `plugins[${index}].version`, 160)
  if (!SEMVER_PATTERN.test(version)) throw new Error(`plugins[${index}].version 不是有效 semver`)
  const sourceText = requiredString(plugin.source, `plugins[${index}].source`, 2048)
  const source = canonicalPluginSource(sourceText)
  if (source !== sourceText) throw new Error(`plugins[${index}].source 不是 canonical URL`)

  const compatibility = record(plugin.compatibility)
  assertKeys(compatibility, ['cordisx'], `plugins[${index}].compatibility`)
  const authorsValue = plugin.authors
  if (!Array.isArray(authorsValue) || authorsValue.length === 0 || authorsValue.length > 20) {
    throw new Error(`plugins[${index}].authors 必须包含 1-20 个作者`)
  }
  const authors = authorsValue.map((value, authorIndex): MarketplaceAuthor => {
    const author = record(value)
    assertKeys(author, ['name', 'url'], `plugins[${index}].authors[${authorIndex}]`)
    const url = optionalHttpsUrl(author.url, `plugins[${index}].authors[${authorIndex}].url`)
    return {
      name: requiredString(author.name, `plugins[${index}].authors[${authorIndex}].name`, 80),
      ...(url === undefined ? {} : { url }),
    }
  })

  const keywordsValue = plugin.keywords ?? []
  if (!Array.isArray(keywordsValue) || keywordsValue.length > 20) throw new Error(`plugins[${index}].keywords 必须是最多 20 项的数组`)
  const keywords = keywordsValue.map((value, keywordIndex) => {
    const keyword = requiredString(value, `plugins[${index}].keywords[${keywordIndex}]`, 32)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(keyword)) throw new Error(`plugins[${index}].keywords[${keywordIndex}] 不是规范 keyword`)
    return keyword
  })
  if (new Set(keywords).size !== keywords.length) throw new Error(`plugins[${index}].keywords 包含重复项`)

  const fallbackLocale = schemaVersion >= 2
    ? canonicalLocale(plugin.fallbackLocale, `plugins[${index}].fallbackLocale`)
    : 'en'
  const localizations = schemaVersion >= 2
    ? parsePluginLocalizations(plugin.localizations, fallbackLocale, authors.length, `plugins[${index}].localizations`)
    : Object.freeze({})
  const homepage = optionalHttpsUrl(plugin.homepage, `plugins[${index}].homepage`)
  const icon = optionalHttpsUrl(plugin.icon, `plugins[${index}].icon`)
  const manifest = optionalHttpsUrl(plugin.manifest, `plugins[${index}].manifest`)
  const artifact = schemaVersion >= 3 ? parseArtifact(plugin.artifact, `plugins[${index}].artifact`) : undefined
  const commerce = schemaVersion === 4 ? parseCommerce(plugin.commerce, `plugins[${index}].commerce`) : undefined
  return {
    schemaVersion,
    id,
    fallbackLocale,
    name: requiredString(plugin.name, `plugins[${index}].name`, 80),
    description: requiredString(plugin.description, `plugins[${index}].description`, 280),
    localizations,
    version,
    source,
    ...(homepage === undefined ? {} : { homepage }),
    ...(icon === undefined ? {} : { icon }),
    ...(manifest === undefined ? {} : { manifest }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(commerce === undefined ? {} : { commerce }),
    license: requiredString(plugin.license, `plugins[${index}].license`, 80),
    compatibility: { cordisx: requiredString(compatibility.cordisx, `plugins[${index}].compatibility.cordisx`, 120) },
    authors,
    keywords,
  }
}

export function parseMarketplaceFeed(value: unknown, options?: MarketplaceFeedParseOptions): ParsedFeed {
  const feed = record(value)
  const schemaVersion = feed.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4) throw new Error('schemaVersion 不受支持')
  assertKeys(feed, [
    '$schema',
    'schemaVersion',
    'name',
    'homepage',
    'plugins',
    ...(schemaVersion >= 2 ? ['fallbackLocale', 'localizations'] : []),
    ...(schemaVersion >= 3 ? ['generatedAt', 'trust', 'official', 'certifications'] : []),
  ], 'feed')
  if (feed.$schema !== FEED_SCHEMAS[schemaVersion]) throw new Error('$schema 不受支持')
  const fallbackLocale = schemaVersion >= 2 ? canonicalLocale(feed.fallbackLocale, 'fallbackLocale') : 'en'
  const name = requiredString(feed.name, 'name', 100)
  const localizations = schemaVersion >= 2
    ? parseFeedLocalizations(feed.localizations, fallbackLocale, 'localizations')
    : Object.freeze({})
  const homepage = optionalHttpsUrl(feed.homepage, 'homepage')
  if (homepage === undefined) throw new Error('homepage 是必填 HTTPS URL')
  if (!Array.isArray(feed.plugins)) throw new Error('plugins 必须是数组')
  const plugins = feed.plugins.map(parsePlugin)
  if (plugins.some(plugin => plugin.schemaVersion !== schemaVersion)) throw new Error('feed 与 plugin schemaVersion 必须一致')
  const identities = new Set<string>()
  for (const plugin of plugins) {
    const identity = marketplacePluginIdentity(plugin.source, plugin.id)
    if (identities.has(identity)) throw new Error(`feed 内存在重复插件 ${plugin.source} / ${plugin.id}`)
    identities.add(identity)
  }
  const sorted = [...plugins].sort((left, right) => left.source.localeCompare(right.source)
    || left.id.localeCompare(right.id)
    || left.version.localeCompare(right.version))
  if (plugins.some((plugin, index) => plugin !== sorted[index])) throw new Error('plugins 没有按照 source/id/version 确定性排序')
  const trust = schemaVersion >= 3
    ? evaluateMarketplaceTrust(value, plugins.map(plugin => ({ ...plugin, identity: marketplacePluginIdentity(plugin.source, plugin.id) })), options ?? {
      feedUrl: OFFICIAL_MARKETPLACE_SOURCE,
      trustedRoots: [],
    })
    : undefined
  return { schemaVersion, fallbackLocale, name, localizations, homepage, plugins, ...(trust === undefined ? {} : { trust }) }
}

const DEFAULT_RETRY_DELAYS = Object.freeze([250, 1_000])
const DEFAULT_STALE_AFTER_MS = 5 * 60_000

class MarketplaceLoadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function sourceIdentity(record: MarketplaceSourceRecord): Pick<MarketplaceSourceSnapshot, 'url' | 'enabled' | 'official' | 'local'> {
  return {
    url: record.url,
    enabled: record.enabled,
    official: record.url === OFFICIAL_MARKETPLACE_SOURCE,
    ...(record.local === undefined ? {} : { local: record.local }),
  }
}

export class BrowserMarketplaceModel implements MarketplaceModel {
  private readonly sourceStore: BrowserMarketplaceSourceStore
  private readonly cache: BrowserMarketplaceFeedCache
  private sourceRecords: MarketplaceSourceRecord[]
  private sourceStates: MarketplaceSourceSnapshot[]
  private plugins: MarketplaceCatalogPlugin[] = []
  private duplicates: MarketplaceDuplicate[] = []
  private readonly loaded = new Map<string, LoadResult>()
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private controller: AbortController | undefined
  private refreshPromise: Promise<void> | undefined
  private readonly now: () => number
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly retryDelays: readonly number[]
  private readonly staleAfterMs: number

  constructor(
    storage: MarketplaceStorage | undefined,
    private readonly fetcher: MarketplaceFetcher | undefined,
    private readonly trustedRoots: readonly string[] = [OFFICIAL_MARKETPLACE_SOURCE],
    options: MarketplaceModelOptions = {},
  ) {
    this.sourceStore = new BrowserMarketplaceSourceStore(storage)
    this.cache = new BrowserMarketplaceFeedCache(storage)
    this.sourceRecords = [...this.sourceStore.snapshot()]
    this.sourceStates = []
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? abortableSleep
    this.retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.cache.prune(this.sourceRecords.map(source => source.url))
    this.hydrate()
  }

  snapshot(): MarketplaceSnapshot {
    return {
      sources: this.sourceRecords.map(source => source.url),
      sourceRecords: this.sourceRecords.map(source => Object.freeze({ ...source, ...(source.local === undefined ? {} : { local: Object.freeze({ ...source.local }) }) })),
      sourceStates: [...this.sourceStates],
      plugins: [...this.plugins],
      duplicates: [...this.duplicates],
      loading: this.sourceStates.some(source => source.status === 'loading'),
      revalidating: this.sourceStates.some(source => source.revalidating),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async setSources(sources: readonly string[]): Promise<void> {
    const previous = new Map(this.sourceRecords.map(source => [source.url, source]))
    const seen = new Set<string>()
    const records: MarketplaceSourceRecord[] = []
    for (const value of sources) {
      const url = normalizeMarketplaceSource(value.trim())
      if (seen.has(url)) continue
      seen.add(url)
      records.push(previous.get(url) ?? { url, enabled: true })
    }
    await this.replaceRecords(this.sourceStore.replace(records))
  }

  async setSourceRecords(sources: readonly MarketplaceSourceRecord[]): Promise<void> {
    await this.replaceRecords(this.sourceStore.replace(sources))
  }

  async upsertSource(source: MarketplaceSourceRecord): Promise<void> {
    await this.replaceRecords(this.sourceStore.upsert(source))
  }

  async removeSource(url: string): Promise<void> {
    await this.replaceRecords(this.sourceStore.remove(url))
  }

  async setSourceEnabled(url: string, enabled: boolean): Promise<void> {
    await this.replaceRecords(this.sourceStore.setEnabled(url, enabled))
  }

  async moveSource(url: string, targetIndex: number): Promise<void> {
    await this.replaceRecords(this.sourceStore.move(url, targetIndex))
  }

  async importSource(value: string): Promise<MarketplaceSourceRecord> {
    const source = parseMarketplaceSourceImport(value)
    await this.upsertSource(source)
    return source
  }

  async reload(): Promise<void> {
    if (this.refreshPromise !== undefined) return await this.refreshPromise
    const generation = ++this.generation
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.sourceStates = this.sourceRecords.map((source): MarketplaceSourceSnapshot => {
      if (!source.enabled) return this.disabledState(source)
      const previous = this.loaded.get(source.url)
      return {
        ...sourceIdentity(source),
        status: previous?.feed === undefined ? 'loading' : 'loaded',
        phase: 'revalidating',
        stale: previous?.state.stale ?? false,
        revalidating: true,
        attempts: 0,
        ...(previous?.state.name === undefined ? {} : { name: previous.state.name }),
        ...(previous?.state.fallbackLocale === undefined ? {} : { fallbackLocale: previous.state.fallbackLocale }),
        ...(previous?.state.localizations === undefined ? {} : { localizations: previous.state.localizations }),
        ...(previous?.state.homepage === undefined ? {} : { homepage: previous.state.homepage }),
        ...(previous?.state.pluginCount === undefined ? {} : { pluginCount: previous.state.pluginCount }),
        ...(previous?.state.trusted === undefined ? {} : { trusted: previous.state.trusted }),
        ...(previous?.state.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.state.lastSuccessAt }),
      }
    })
    this.notify()

    const task = (async (): Promise<void> => {
      const results = await Promise.all(this.sourceRecords.map(async (source): Promise<LoadResult> => {
        if (!source.enabled) return { state: this.disabledState(source) }
        return await this.load(source, controller.signal, this.loaded.get(source.url))
      }))
      if (generation !== this.generation) return
      this.loaded.clear()
      results.forEach((result, index) => {
        const source = this.sourceRecords[index]
        if (source?.enabled === true && result.feed !== undefined) this.loaded.set(source.url, result)
      })
      this.sourceStates = results.map(result => result.state)
      this.rebuildCatalog()
      this.notify()
    })()
    this.refreshPromise = task
    try {
      await task
    } finally {
      if (this.refreshPromise === task) this.refreshPromise = undefined
    }
  }

  dispose(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = undefined
    this.refreshPromise = undefined
    this.listeners.clear()
  }

  private async replaceRecords(records: readonly MarketplaceSourceRecord[]): Promise<void> {
    this.generation += 1
    this.controller?.abort()
    this.controller = undefined
    this.refreshPromise = undefined
    this.sourceRecords = [...records]
    this.cache.prune(this.sourceRecords.map(source => source.url))
    this.hydrate()
    this.notify()
    await this.reload()
  }

  private hydrate(): void {
    this.loaded.clear()
    this.sourceStates = this.sourceRecords.map((source): MarketplaceSourceSnapshot => {
      if (!source.enabled) return this.disabledState(source)
      const cached = this.cache.get(source.url)
      if (cached === undefined) return this.idleState(source)
      try {
        const feed = parseMarketplaceFeed(JSON.parse(cached.text) as unknown, { feedUrl: source.url, trustedRoots: this.trustedRoots })
        const stale = marketplaceCacheAge(cached, this.now()) > this.staleAfterMs
        const result: LoadResult = {
          state: this.feedState(source, feed, stale ? 'stale' : 'fresh', 0, cached.storedAt),
          feed,
        }
        this.loaded.set(source.url, result)
        return result.state
      } catch {
        this.cache.delete(source.url)
        return this.idleState(source)
      }
    })
    this.rebuildCatalog()
  }

  private idleState(source: MarketplaceSourceRecord): MarketplaceSourceSnapshot {
    return {
      ...sourceIdentity(source),
      status: 'loading',
      phase: 'idle',
      stale: false,
      revalidating: false,
      attempts: 0,
    }
  }

  private disabledState(source: MarketplaceSourceRecord): MarketplaceSourceSnapshot {
    return {
      ...sourceIdentity(source),
      status: 'loaded',
      phase: 'disabled',
      stale: false,
      revalidating: false,
      attempts: 0,
    }
  }

  private feedState(
    source: MarketplaceSourceRecord,
    feed: ParsedFeed,
    phase: 'fresh' | 'stale',
    attempts: number,
    storedAt: number,
    error?: string,
  ): MarketplaceSourceSnapshot {
    return {
      ...sourceIdentity(source),
      status: 'loaded',
      phase,
      stale: phase === 'stale',
      revalidating: false,
      attempts,
      name: feed.name,
      fallbackLocale: feed.fallbackLocale,
      localizations: feed.localizations,
      homepage: feed.homepage,
      pluginCount: feed.plugins.length,
      ...(feed.trust === undefined ? {} : { trusted: feed.trust.trusted }),
      lastSuccessAt: new Date(storedAt).toISOString(),
      ...(error === undefined ? {} : { error }),
    }
  }

  private async load(source: MarketplaceSourceRecord, signal: AbortSignal, previous: LoadResult | undefined): Promise<LoadResult> {
    let attempts = 0
    let lastError = '插件商店加载失败'
    const totalAttempts = this.retryDelays.length + 1
    for (let index = 0; index < totalAttempts; index += 1) {
      attempts = index + 1
      try {
        const loaded = await this.loadOnce(source.url, signal)
        const storedAt = this.now()
        this.cache.set({ url: source.url, text: loaded.text, storedAt })
        return { state: this.feedState(source, loaded.feed, 'fresh', attempts, storedAt), feed: loaded.feed }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        const retryable = error instanceof MarketplaceLoadError && error.retryable && !signal.aborted
        const delay = this.retryDelays[index]
        if (!retryable || delay === undefined) break
        await this.sleep(delay, signal)
      }
    }
    if (previous?.feed !== undefined) {
      const lastSuccess = previous.state.lastSuccessAt === undefined ? this.now() : Date.parse(previous.state.lastSuccessAt)
      return {
        state: this.feedState(source, previous.feed, 'stale', attempts, Number.isFinite(lastSuccess) ? lastSuccess : this.now(), lastError),
        feed: previous.feed,
      }
    }
    return {
      state: {
        ...sourceIdentity(source),
        status: 'failed',
        phase: 'error',
        stale: false,
        revalidating: false,
        attempts,
        error: lastError,
      },
    }
  }

  private async loadOnce(url: string, signal: AbortSignal): Promise<{ readonly feed: ParsedFeed; readonly text: string }> {
    if (this.fetcher === undefined) throw new MarketplaceLoadError('当前 renderer 不提供 fetch', false)
    let response: MarketplaceResponse
    try {
      response = await this.fetcher(url, { headers: { accept: 'application/json' }, signal })
    } catch (error) {
      throw new MarketplaceLoadError(error instanceof Error ? error.message : String(error), true)
    }
    if (!response.ok) throw new MarketplaceLoadError(`HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500)
    let text: string
    try { text = await response.text() } catch (error) {
      throw new MarketplaceLoadError(error instanceof Error ? error.message : String(error), true)
    }
    if (new Blob([text]).size > MAX_FEED_BYTES) throw new MarketplaceLoadError('feed 超过 2 MiB 限制', false)
    try {
      const feed = parseMarketplaceFeed(JSON.parse(text) as unknown, { feedUrl: url, trustedRoots: this.trustedRoots })
      return { feed, text }
    } catch (error) {
      throw new MarketplaceLoadError(error instanceof Error ? error.message : String(error), false)
    }
  }

  private rebuildCatalog(): void {
    const winners = new Map<string, MarketplaceCatalogPlugin>()
    const duplicates: MarketplaceDuplicate[] = []
    for (const source of this.sourceRecords) {
      if (!source.enabled) continue
      const result = this.loaded.get(source.url)
      if (result?.feed === undefined) continue
      for (const plugin of result.feed.plugins) {
        const identity = marketplacePluginIdentity(plugin.source, plugin.id)
        const pluginTrust = result.feed.trust?.byPluginIdentity.get(identity)
        const winner = winners.get(identity)
        if (winner !== undefined) {
          duplicates.push({ identity, winnerFeedUrl: winner.feedUrl, duplicateFeedUrl: source.url })
          continue
        }
        winners.set(identity, {
          ...plugin,
          identity,
          feedUrl: source.url,
          feedName: result.feed.name,
          feedFallbackLocale: result.feed.fallbackLocale,
          feedLocalizations: result.feed.localizations,
          feedHomepage: result.feed.homepage,
          ...(pluginTrust?.official === undefined ? {} : { official: pluginTrust.official }),
          ...(pluginTrust?.certification === undefined ? {} : { certification: pluginTrust.certification }),
        })
      }
    }
    this.plugins = [...winners.values()]
    this.duplicates = duplicates
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
