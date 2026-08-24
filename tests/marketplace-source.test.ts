import { describe, expect, it } from 'vitest'
import {
  BrowserMarketplaceSourceStore,
  MARKETPLACE_SOURCE_RECORDS_KEY,
  MARKETPLACE_SOURCE_SCHEMA_V1,
  MARKETPLACE_SOURCES_KEY,
  OFFICIAL_MARKETPLACE_SOURCE,
  parseMarketplaceSourceImport,
  type MarketplaceStorage,
} from '../packages/cli/src/renderer/marketplace-source.js'
import {
  BrowserMarketplaceFeedCache,
  MARKETPLACE_FEED_CACHE_KEY,
} from '../packages/cli/src/renderer/marketplace-cache.js'

class MemoryStorage implements MarketplaceStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('Marketplace source store', () => {
  it('migrates legacy URL arrays and keeps the missing official source as an explicit disabled record', () => {
    const storage = new MemoryStorage()
    const custom = 'https://plugins.example/catalog.json'
    storage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([custom, custom]))

    const store = new BrowserMarketplaceSourceStore(storage)

    expect(store.snapshot()).toEqual([
      { url: OFFICIAL_MARKETPLACE_SOURCE, enabled: false },
      { url: custom, enabled: true },
    ])
    expect(JSON.parse(storage.getItem(MARKETPLACE_SOURCE_RECORDS_KEY)!)).toEqual({
      schemaVersion: 2,
      sources: [
        { url: OFFICIAL_MARKETPLACE_SOURCE, enabled: false },
        { url: custom, enabled: true },
      ],
    })
  })

  it('allows official disable and local overrides but refuses official deletion', () => {
    const storage = new MemoryStorage()
    const store = new BrowserMarketplaceSourceStore(storage)

    store.upsert({
      url: OFFICIAL_MARKETPLACE_SOURCE,
      enabled: true,
      local: { name: 'Team catalog', description: 'Reviewed team feed.', note: 'Keep first.' },
    })
    store.setEnabled(OFFICIAL_MARKETPLACE_SOURCE, false)

    expect(store.snapshot()[0]).toEqual({
      url: OFFICIAL_MARKETPLACE_SOURCE,
      enabled: false,
      local: { name: 'Team catalog', description: 'Reviewed team feed.', note: 'Keep first.' },
    })
    expect(() => store.remove(OFFICIAL_MARKETPLACE_SOURCE)).toThrow('不能删除，只能停用')
  })

  it('imports a bare URL or the closed v1 payload and rejects trust claims and untrimmed prose', () => {
    expect(parseMarketplaceSourceImport(' https://PLUGINS.example:443/catalog.json?channel=preview ')).toEqual({
      url: 'https://plugins.example/catalog.json?channel=preview',
      enabled: true,
    })
    expect(parseMarketplaceSourceImport(JSON.stringify({
      $schema: MARKETPLACE_SOURCE_SCHEMA_V1,
      schemaVersion: 1,
      url: 'https://plugins.example/catalog.json',
      enabled: false,
      local: { name: 'Preview', description: 'Preview plugins.', note: 'Enable after review.' },
    }))).toEqual({
      url: 'https://plugins.example/catalog.json',
      enabled: false,
      local: { name: 'Preview', description: 'Preview plugins.', note: 'Enable after review.' },
    })
    expect(() => parseMarketplaceSourceImport(JSON.stringify({
      $schema: MARKETPLACE_SOURCE_SCHEMA_V1,
      schemaVersion: 1,
      url: 'https://plugins.example/catalog.json',
      enabled: true,
      official: true,
    }))).toThrow('不支持的字段: official')
    expect(() => parseMarketplaceSourceImport(JSON.stringify({
      $schema: MARKETPLACE_SOURCE_SCHEMA_V1,
      schemaVersion: 1,
      url: 'https://plugins.example/catalog.json',
      enabled: true,
      local: { name: ' Preview ' },
    }))).toThrow('已裁剪')
  })
})

describe('Marketplace last-good cache', () => {
  it('persists canonical bounded entries and prunes removed sources independently of source config', () => {
    const storage = new MemoryStorage()
    const first = 'https://plugins.example/first.json'
    const second = 'https://plugins.example/second.json'
    const cache = new BrowserMarketplaceFeedCache(storage)
    cache.set({ url: first, text: '{"first":true}', storedAt: 20 })
    cache.set({ url: second, text: '{"second":true}', storedAt: 10 })

    expect(cache.get(first)).toEqual({ url: first, text: '{"first":true}', storedAt: 20 })
    cache.prune([first])
    expect(cache.get(second)).toBeUndefined()
    expect(JSON.parse(storage.getItem(MARKETPLACE_FEED_CACHE_KEY)!)).toEqual({
      schemaVersion: 1,
      entries: [{ url: first, text: '{"first":true}', storedAt: 20 }],
    })
  })

  it('discards corrupt persisted entries without changing source configuration', () => {
    const storage = new MemoryStorage()
    storage.setItem(MARKETPLACE_FEED_CACHE_KEY, JSON.stringify({
      schemaVersion: 1,
      entries: [{ url: 'http://localhost/feed', text: '{}', storedAt: 1 }],
    }))
    const cache = new BrowserMarketplaceFeedCache(storage)
    expect(cache.get(OFFICIAL_MARKETPLACE_SOURCE)).toBeUndefined()
  })
})
