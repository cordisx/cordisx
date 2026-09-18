import { fetchMarketplaceFeed } from '../launcher/marketplace.js'
import { marketplacePluginIdentity, parseMarketplaceFeed } from '../renderer/marketplace.js'
import type { MarketplaceCatalogPlugin } from '../renderer/marketplace-types.js'
import type {
  PluginManagementCatalogDetail,
  PluginManagementCatalogQuery,
  PluginManagementCatalogSnapshot,
  PluginManagementCatalogSourceStatus,
  PluginManagementCatalogSummary,
} from './contracts.js'
import { loadPluginManagementConfig, type PluginManagementPersistenceOptions } from './persistence.js'

export interface PluginManagementCatalog {
  refresh(sourceUrl?: string): Promise<PluginManagementCatalogSnapshot>
  query(query?: PluginManagementCatalogQuery): Promise<readonly PluginManagementCatalogSummary[]>
  pluginInfo(query: { readonly pluginId: string; readonly sourceUrl?: string; readonly version?: string }): Promise<
    PluginManagementCatalogDetail | undefined
  >
  invalidate(): void
}

function hiddenKey(identity: { readonly sourceUrl: string; readonly pluginId: string }): string {
  return `${identity.sourceUrl}\n${identity.pluginId}`
}

function catalogDetail(
  plugin: MarketplaceCatalogPlugin,
  sourceUrl: string,
  hidden: boolean,
): PluginManagementCatalogDetail {
  return {
    identity: { sourceUrl, pluginId: plugin.id },
    canonicalSource: plugin.source,
    version: plugin.version,
    name: plugin.name,
    description: plugin.description,
    authors: plugin.authors.map(author => author.name),
    keywords: plugin.keywords,
    hidden,
    installable: plugin.artifact !== undefined,
    ...(plugin.homepage === undefined ? {} : { homepage: plugin.homepage }),
    license: plugin.license,
    ...(plugin.artifact === undefined ? {} : { artifact: plugin.artifact }),
  }
}

function matchesCatalogQuery(plugin: PluginManagementCatalogDetail, query: PluginManagementCatalogQuery): boolean {
  if (query.sourceUrl !== undefined && plugin.identity.sourceUrl !== new URL(query.sourceUrl).href) return false
  if (query.version !== undefined && plugin.version !== query.version) return false
  if (query.includeHidden !== true && plugin.hidden) return false
  const text = query.query?.trim().toLocaleLowerCase()
  if (text === undefined || text === '') return true
  return [
    plugin.identity.pluginId,
    plugin.name,
    plugin.description,
    plugin.canonicalSource,
    plugin.identity.sourceUrl,
    ...plugin.authors,
    ...plugin.keywords,
  ].some(value => value.toLocaleLowerCase().includes(text))
}

export function createPluginManagementCatalog(
  options: PluginManagementPersistenceOptions,
): PluginManagementCatalog {
  let details: readonly PluginManagementCatalogDetail[] = []
  let fullyLoaded = false
  const loadedSources = new Set<string>()

  const refresh = async (sourceUrl?: string): Promise<PluginManagementCatalogSnapshot> => {
    const management = await loadPluginManagementConfig(options)
    const targetUrl = sourceUrl === undefined ? undefined : new URL(sourceUrl).href
    const selectedSources = targetUrl === undefined
      ? management.sources
      : management.sources.filter(source => source.url === targetUrl)
    if (targetUrl !== undefined && selectedSources.length === 0) {
      throw new Error('Marketplace source does not exist.')
    }
    const hidden = new Set(management.hiddenCatalogEntries.map(hiddenKey))
    const statuses: PluginManagementCatalogSourceStatus[] = []
    const nextDetails: PluginManagementCatalogDetail[] = []
    const seen = new Set<string>()
    for (const source of selectedSources) {
      if (!source.enabled) {
        statuses.push({ url: source.url, enabled: false, status: 'disabled' })
        continue
      }
      try {
        const response = await fetchMarketplaceFeed(source.url)
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Marketplace feed returned HTTP ${response.status}`)
        }
        const feed = parseMarketplaceFeed(JSON.parse(response.text) as unknown, {
          feedUrl: source.url,
          trustedRoots: [],
        })
        let pluginCount = 0
        for (const plugin of feed.plugins) {
          const identity = marketplacePluginIdentity(plugin.source, plugin.id)
          if (seen.has(identity)) continue
          seen.add(identity)
          pluginCount += 1
          nextDetails.push(catalogDetail(
            {
              ...plugin,
              identity,
              feedUrl: source.url,
              feedName: feed.name,
              feedFallbackLocale: feed.fallbackLocale,
              feedLocalizations: feed.localizations,
              feedHomepage: feed.homepage,
            },
            source.url,
            hidden.has(hiddenKey({ sourceUrl: source.url, pluginId: plugin.id })),
          ))
        }
        statuses.push({ url: source.url, enabled: true, status: 'loaded', pluginCount })
      } catch (error) {
        statuses.push({
          url: source.url,
          enabled: true,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (targetUrl === undefined) {
      details = nextDetails
      fullyLoaded = true
      loadedSources.clear()
      for (const source of management.sources) loadedSources.add(source.url)
    } else {
      details = [
        ...details.filter(plugin => plugin.identity.sourceUrl !== targetUrl),
        ...nextDetails,
      ]
      loadedSources.add(targetUrl)
    }
    const refreshed = {
      refreshedAt: new Date().toISOString(),
      sources: statuses,
      plugins: nextDetails,
    }
    return refreshed
  }

  const ensure = async (sourceUrl?: string): Promise<void> => {
    if (fullyLoaded) return
    if (sourceUrl !== undefined) {
      const canonical = new URL(sourceUrl).href
      if (!loadedSources.has(canonical)) await refresh(canonical)
      return
    }
    await refresh()
  }

  return {
    refresh,
    async query(query = {}) {
      await ensure(query.sourceUrl)
      return details.filter(plugin => matchesCatalogQuery(plugin, query))
    },
    async pluginInfo(query) {
      await ensure(query.sourceUrl)
      const matches = details.filter(plugin =>
        plugin.identity.pluginId === query.pluginId
        && (query.sourceUrl === undefined || plugin.identity.sourceUrl === new URL(query.sourceUrl).href)
        && (query.version === undefined || plugin.version === query.version)
      )
      if (matches.length > 1) throw new Error('Marketplace plugin selection is ambiguous; specify sourceUrl.')
      return matches[0]
    },
    invalidate() {
      details = []
      fullyLoaded = false
      loadedSources.clear()
    },
  }
}
