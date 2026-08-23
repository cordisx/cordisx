export const OFFICIAL_MARKETPLACE_SOURCE = 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'
export const MARKETPLACE_SOURCES_KEY = 'cordisx.manager.marketplaceSources.v1'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PLUGIN_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json'
const FEED_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json'

export interface MarketplaceAuthor {
  readonly name: string
  readonly url?: string
}

export interface MarketplacePlugin {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description: string
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
  readonly feedHomepage: string
}

export interface MarketplaceSourceSnapshot {
  readonly url: string
  readonly status: 'loading' | 'loaded' | 'failed'
  readonly name?: string
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
  readonly name: string
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
  ], `plugins[${index}]`)
  if (plugin.$schema !== PLUGIN_SCHEMA) throw new Error(`plugins[${index}].$schema 不受支持`)
  if (plugin.schemaVersion !== 1) throw new Error(`plugins[${index}].schemaVersion 必须为 1`)
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

  const homepage = optionalHttpsUrl(plugin.homepage, `plugins[${index}].homepage`)
  const icon = optionalHttpsUrl(plugin.icon, `plugins[${index}].icon`)
  const manifest = optionalHttpsUrl(plugin.manifest, `plugins[${index}].manifest`)
  return {
    schemaVersion: 1,
    id,
    name: requiredString(plugin.name, `plugins[${index}].name`, 80),
    description: requiredString(plugin.description, `plugins[${index}].description`, 280),
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
  assertKeys(feed, ['$schema', 'schemaVersion', 'name', 'homepage', 'plugins'], 'feed')
  if (feed.$schema !== FEED_SCHEMA) throw new Error('$schema 不受支持')
  if (feed.schemaVersion !== 1) throw new Error('schemaVersion 必须为 1')
  const name = requiredString(feed.name, 'name', 100)
  const homepage = optionalHttpsUrl(feed.homepage, 'homepage')
  if (homepage === undefined) throw new Error('homepage 是必填 HTTPS URL')
  if (!Array.isArray(feed.plugins)) throw new Error('plugins 必须是数组')
  const plugins = feed.plugins.map(parsePlugin)
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
  return { name, homepage, plugins }
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
          state: { url, status: 'loaded', name: feed.name, homepage: feed.homepage, pluginCount: feed.plugins.length },
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
