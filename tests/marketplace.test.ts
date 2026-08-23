import { describe, expect, it } from 'vitest'
import {
  BrowserMarketplaceModel,
  MARKETPLACE_SOURCES_KEY,
  canonicalPluginSource,
  marketplacePluginIdentity,
  normalizeMarketplaceSource,
  parseMarketplaceFeed,
  type MarketplaceFetcher,
  type MarketplaceStorage,
} from '../packages/cli/src/renderer/marketplace.js'

const PLUGIN_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json'
const FEED_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json'

function plugin(id: string, name: string, source = `https://github.com/example/${id}`): Record<string, unknown> {
  return {
    $schema: PLUGIN_SCHEMA,
    schemaVersion: 1,
    id,
    name,
    description: `${name} description`,
    version: '1.2.3',
    source,
    homepage: source,
    license: 'MIT',
    compatibility: { cordisx: '^0.1.0' },
    authors: [{ name: 'Example author', url: 'https://example.com/' }],
    keywords: ['example'],
  }
}

function feed(name: string, plugins: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    $schema: FEED_SCHEMA,
    schemaVersion: 1,
    name,
    homepage: `https://example.com/${name.toLowerCase()}`,
    plugins,
  })
}

class MemoryStorage implements MarketplaceStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function fetcher(entries: ReadonlyMap<string, string | Error>): MarketplaceFetcher {
  return async (url) => {
    const value = entries.get(url)
    if (value instanceof Error) throw value
    if (value === undefined) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => value }
  }
}

describe('marketplace feed', () => {
  it('uses canonical plugin source plus lowercase id as identity', () => {
    expect(canonicalPluginSource('https://github.com/example/plugin')).toBe('https://github.com/example/plugin')
    expect(marketplacePluginIdentity('https://github.com/example/plugin', 'demo')).toBe('https://github.com/example/plugin\u0000demo')
    expect(canonicalPluginSource('https://github.com/example/plugin/')).toBe('https://github.com/example/plugin')
    expect(() => parseMarketplaceFeed({
      $schema: FEED_SCHEMA,
      schemaVersion: 1,
      name: 'Invalid source',
      homepage: 'https://example.com/',
      plugins: [plugin('demo', 'Invalid source', 'https://github.com/example/plugin/')],
    })).toThrow('不是 canonical URL')
    expect(() => parseMarketplaceFeed({
      $schema: FEED_SCHEMA,
      schemaVersion: 1,
      name: 'Invalid',
      homepage: 'https://example.com/',
      plugins: [plugin('Not-Lowercase', 'Invalid')],
    })).toThrow('小写规范 id')
  })

  it('normalizes configured feed URLs without making them plugin identity', () => {
    expect(normalizeMarketplaceSource('https://EXAMPLE.com:443/feed.json?channel=stable')).toBe('https://example.com/feed.json?channel=stable')
    expect(() => normalizeMarketplaceSource('http://example.com/feed.json')).toThrow('HTTPS URL')
    expect(() => normalizeMarketplaceSource('https://user@example.com/feed.json')).toThrow('无凭据')
  })
})

describe('BrowserMarketplaceModel', () => {
  it('keeps the first configured feed winner and isolates later duplicates and source failures', async () => {
    const first = 'https://catalog-a.example/feed.json'
    const failed = 'https://catalog-b.example/feed.json'
    const later = 'https://catalog-c.example/feed.json'
    const sharedSource = 'https://github.com/example/shared'
    const storage = new MemoryStorage()
    storage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([first, failed, later]))
    const model = new BrowserMarketplaceModel(storage, fetcher(new Map([
      [first, feed('First', [plugin('shared', 'First winner', sharedSource)])],
      [failed, new Error('network unavailable')],
      [later, feed('Later', [plugin('shared', 'Later duplicate', sharedSource), plugin('unique', 'Unique plugin')])],
    ])))

    await model.reload()
    const snapshot = model.snapshot()
    expect(snapshot.loading).toBe(false)
    expect(snapshot.sourceStates).toEqual([
      expect.objectContaining({ url: first, status: 'loaded', pluginCount: 1 }),
      expect.objectContaining({ url: failed, status: 'failed', error: 'network unavailable' }),
      expect.objectContaining({ url: later, status: 'loaded', pluginCount: 2 }),
    ])
    expect(snapshot.plugins.map(item => [item.id, item.name, item.feedUrl])).toEqual([
      ['shared', 'First winner', first],
      ['unique', 'Unique plugin', later],
    ])
    expect(snapshot.duplicates).toEqual([{
      identity: `${sharedSource}\u0000shared`,
      winnerFeedUrl: first,
      duplicateFeedUrl: later,
    }])
    model.dispose()
  })

  it('persists an ordered, URL-unique source list and supports an empty catalog', async () => {
    const source = 'https://catalog.example/feed.json'
    const storage = new MemoryStorage()
    const model = new BrowserMarketplaceModel(storage, fetcher(new Map([[source, feed('Catalog', [])]])))

    await model.setSources([source, source])
    expect(model.snapshot().sources).toEqual([source])
    expect(storage.getItem(MARKETPLACE_SOURCES_KEY)).toBe(JSON.stringify([source]))

    await model.setSources([])
    expect(model.snapshot()).toEqual(expect.objectContaining({ sources: [], sourceStates: [], plugins: [], loading: false }))
    expect(storage.getItem(MARKETPLACE_SOURCES_KEY)).toBe('[]')
    model.dispose()
  })
})
