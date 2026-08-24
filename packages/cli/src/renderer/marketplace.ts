export const OFFICIAL_MARKETPLACE_SOURCE = 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'
export const MARKETPLACE_SOURCES_KEY = 'cordisx.manager.marketplaceSources.v1'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PLUGIN_SCHEMAS = Object.freeze({
  1: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json',
  2: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json',
})
const FEED_SCHEMAS = Object.freeze({
  1: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json',
  2: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
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

export interface MarketplacePlugin {
  readonly schemaVersion: 1 | 2
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

export interface MarketplaceSourceSnapshot {
  readonly url: string
  readonly status: 'loading' | 'loaded' | 'failed'
  readonly name?: string
  readonly fallbackLocale?: string
  readonly localizations?: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly homepage?: string
  readonly pluginCount?: number
  readonly error?: string
}

export interface MarketplaceDuplicate {
  readonly identity: string
  readonly winnerFeedUrl: string
  readonly duplicateFeedUrl: string
}

export interface MarketplaceSnapshot {
  readonly sources: readonly string[]
  readonly sourceStates: readonly MarketplaceSourceSnapshot[]
  readonly plugins: readonly MarketplaceCatalogPlugin[]
  readonly duplicates: readonly MarketplaceDuplicate[]
  readonly loading: boolean
}

export interface MarketplaceModel {
  snapshot(): MarketplaceSnapshot
  setSources(sources: readonly string[]): Promise<void>
  reload(): Promise<void>
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface MarketplaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface MarketplaceResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type MarketplaceFetcher = (url: string, init: RequestInit) => Promise<MarketplaceResponse>

interface ParsedFeed {
  readonly schemaVersion: 1 | 2
  readonly fallbackLocale: string
  readonly name: string
  readonly localizations: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly homepage: string
  readonly plugins: readonly MarketplacePlugin[]
}

interface LoadResult {
  readonly state: MarketplaceSourceSnapshot
  readonly feed?: ParsedFeed
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
  if (source.name === undefined) return undefined
  return projectLocalizedField(
    source.name,
    source.localizations ?? Object.freeze({}),
    'name',
    currentLocale,
    source.fallbackLocale ?? 'en',
  )
}

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const text = requiredString(value, label, 2048)
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error(`${label} 必须是无凭据 HTTPS URL`)
  return url.href
}

/** Normalize a configured JSON feed URL. Feed query parameters are allowed; credentials and fragments are not. */
export function normalizeMarketplaceSource(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('插件商店地址必须是无凭据、无 fragment 的 HTTPS URL')
  }
  return url.href
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
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error(`plugins[${index}].schemaVersion 不受支持`)
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
    ...(schemaVersion === 2 ? ['fallbackLocale', 'localizations'] : []),
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

  const fallbackLocale = schemaVersion === 2
    ? canonicalLocale(plugin.fallbackLocale, `plugins[${index}].fallbackLocale`)
    : 'en'
  const localizations = schemaVersion === 2
    ? parsePluginLocalizations(plugin.localizations, fallbackLocale, authors.length, `plugins[${index}].localizations`)
    : Object.freeze({})
  const homepage = optionalHttpsUrl(plugin.homepage, `plugins[${index}].homepage`)
  const icon = optionalHttpsUrl(plugin.icon, `plugins[${index}].icon`)
  const manifest = optionalHttpsUrl(plugin.manifest, `plugins[${index}].manifest`)
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
    license: requiredString(plugin.license, `plugins[${index}].license`, 80),
    compatibility: { cordisx: requiredString(compatibility.cordisx, `plugins[${index}].compatibility.cordisx`, 120) },
    authors,
    keywords,
  }
}

export function parseMarketplaceFeed(value: unknown): ParsedFeed {
  const feed = record(value)
  const schemaVersion = feed.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error('schemaVersion 不受支持')
  assertKeys(feed, [
    '$schema',
    'schemaVersion',
    'name',
    'homepage',
    'plugins',
    ...(schemaVersion === 2 ? ['fallbackLocale', 'localizations'] : []),
  ], 'feed')
  if (feed.$schema !== FEED_SCHEMAS[schemaVersion]) throw new Error('$schema 不受支持')
  const fallbackLocale = schemaVersion === 2 ? canonicalLocale(feed.fallbackLocale, 'fallbackLocale') : 'en'
  const name = requiredString(feed.name, 'name', 100)
  const localizations = schemaVersion === 2
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
  return { schemaVersion, fallbackLocale, name, localizations, homepage, plugins }
}

function normalizeSources(sources: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const normalized = normalizeMarketplaceSource(source.trim())
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function readSources(storage: MarketplaceStorage | undefined): string[] {
  if (storage === undefined) return [OFFICIAL_MARKETPLACE_SOURCE]
  try {
    const stored = storage.getItem(MARKETPLACE_SOURCES_KEY)
    if (stored === null) return [OFFICIAL_MARKETPLACE_SOURCE]
    const value = JSON.parse(stored) as unknown
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return [OFFICIAL_MARKETPLACE_SOURCE]
    return normalizeSources(value)
  } catch {
    return [OFFICIAL_MARKETPLACE_SOURCE]
  }
}

export class BrowserMarketplaceModel implements MarketplaceModel {
  private sources: string[]
  private sourceStates: MarketplaceSourceSnapshot[]
  private plugins: MarketplaceCatalogPlugin[] = []
  private duplicates: MarketplaceDuplicate[] = []
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private controller: AbortController | undefined

  constructor(
    private readonly storage: MarketplaceStorage | undefined,
    private readonly fetcher: MarketplaceFetcher | undefined,
  ) {
    this.sources = readSources(storage)
    this.sourceStates = this.sources.map(url => ({ url, status: 'loading' }))
  }

  snapshot(): MarketplaceSnapshot {
    return {
      sources: [...this.sources],
      sourceStates: [...this.sourceStates],
      plugins: [...this.plugins],
      duplicates: [...this.duplicates],
      loading: this.sourceStates.some(source => source.status === 'loading'),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async setSources(sources: readonly string[]): Promise<void> {
    this.sources = normalizeSources(sources)
    this.storage?.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify(this.sources))
    await this.reload()
  }

  async reload(): Promise<void> {
    const generation = ++this.generation
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.sourceStates = this.sources.map(url => ({ url, status: 'loading' }))
    this.plugins = []
    this.duplicates = []
    this.notify()

    const results = await Promise.all(this.sources.map(async (url): Promise<LoadResult> => {
      if (this.fetcher === undefined) return { state: { url, status: 'failed', error: '当前 renderer 不提供 fetch' } }
      try {
        const response = await this.fetcher(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        if (new Blob([text]).size > MAX_FEED_BYTES) throw new Error('feed 超过 2 MiB 限制')
        const feed = parseMarketplaceFeed(JSON.parse(text) as unknown)
        return {
          state: {
            url,
            status: 'loaded',
            name: feed.name,
            fallbackLocale: feed.fallbackLocale,
            localizations: feed.localizations,
            homepage: feed.homepage,
            pluginCount: feed.plugins.length,
          },
          feed,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { state: { url, status: 'failed', error: message } }
      }
    }))
    if (generation !== this.generation) return

    const winners = new Map<string, MarketplaceCatalogPlugin>()
    const duplicates: MarketplaceDuplicate[] = []
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]
      const feedUrl = this.sources[index]
      if (result?.feed === undefined || feedUrl === undefined) continue
      for (const plugin of result.feed.plugins) {
        const identity = marketplacePluginIdentity(plugin.source, plugin.id)
        const winner = winners.get(identity)
        if (winner !== undefined) {
          duplicates.push({ identity, winnerFeedUrl: winner.feedUrl, duplicateFeedUrl: feedUrl })
          continue
        }
        winners.set(identity, {
          ...plugin,
          identity,
          feedUrl,
          feedName: result.feed.name,
          feedFallbackLocale: result.feed.fallbackLocale,
          feedLocalizations: result.feed.localizations,
          feedHomepage: result.feed.homepage,
        })
      }
    }
    this.sourceStates = results.map(result => result.state)
    this.plugins = [...winners.values()]
    this.duplicates = duplicates
    this.notify()
  }

  dispose(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = undefined
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
