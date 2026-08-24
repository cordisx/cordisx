import { describe, expect, it } from 'vitest'
import {
  BrowserMarketplaceModel,
  MARKETPLACE_SOURCES_KEY,
  OFFICIAL_MARKETPLACE_SOURCE,
  canonicalPluginSource,
  marketplacePluginIdentity,
  normalizeMarketplaceSource,
  parseMarketplaceFeed,
  projectMarketplacePlugin,
  type MarketplaceFetcher,
  type MarketplaceStorage,
} from '../packages/cli/src/renderer/marketplace.js'

const PLUGIN_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json'
const FEED_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json'
const PLUGIN_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json'
const FEED_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json'
const PLUGIN_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v3.schema.json'
const FEED_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v3.schema.json'
const OFFICIAL_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v1.schema.json'
const CERTIFICATION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v1.schema.json'
const TRUST_SOURCE = 'https://github.com/cordisx/trusted'
const TRUST_DIGEST = `sha256:${'a'.repeat(64)}`
const TRUST_EVIDENCE = `https://github.com/cordisx/marketplace/commit/${'b'.repeat(40)}`

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

function localizedFeed(): Record<string, unknown> {
  return {
    $schema: FEED_SCHEMA_V2,
    schemaVersion: 2,
    fallbackLocale: 'en',
    name: 'CordisX Marketplace',
    localizations: { 'zh-CN': { name: 'CordisX 插件商店' } },
    homepage: 'https://marketplace.example/',
    plugins: [{
      $schema: PLUGIN_SCHEMA_V2,
      schemaVersion: 2,
      id: 'slot-showcase',
      fallbackLocale: 'en',
      name: 'Slot Showcase',
      description: 'Shows structured CordisX extension points.',
      localizations: {
        'zh-CN': {
          name: '点位展示',
          description: '展示结构化 CordisX 扩展点。',
          authors: ['CordisX 团队'],
          keywords: ['扩展点', '界面'],
        },
      },
      version: '1.2.3',
      source: 'https://github.com/cordisx/slot-showcase',
      license: 'MIT',
      compatibility: { cordisx: '^0.1.0' },
      authors: [{ name: 'CordisX Team', url: 'https://cordisx.github.io/' }],
      keywords: ['extensions', 'ui'],
    }],
  }
}

function trustedFeed(certificationStatus: 'active' | 'revoked' = 'active'): Record<string, unknown> {
  return {
    $schema: FEED_SCHEMA_V3,
    schemaVersion: 3,
    generatedAt: '2026-08-24T12:31:00Z',
    trust: {
      authority: 'cordisx.marketplace.codeowners/v1',
      root: OFFICIAL_MARKETPLACE_SOURCE,
      grantModel: 'protected-merge-chain-v1',
      cryptographicAttestation: 'unsupported',
    },
    fallbackLocale: 'en',
    name: 'CordisX Marketplace',
    localizations: { 'zh-CN': { name: 'CordisX 插件商店' } },
    homepage: 'https://cordisx.github.io/marketplace/',
    plugins: [{
      $schema: PLUGIN_SCHEMA_V3,
      schemaVersion: 3,
      id: 'trusted',
      fallbackLocale: 'en',
      name: 'Trusted Plugin',
      description: 'A versioned artifact used by trust projection tests.',
      localizations: { 'zh-CN': { name: '受信插件', description: '用于信任投影测试的版本化发布物。' } },
      version: '1.2.3',
      source: TRUST_SOURCE,
      artifact: {
        publisherIdentity: 'npm:@cordisx',
        packageNamespace: '@cordisx',
        packageName: '@cordisx/trusted',
        downloadUrl: 'https://registry.npmjs.org/@cordisx/trusted/-/trusted-1.2.3.tgz',
        integrity: TRUST_DIGEST,
      },
      license: 'MIT',
      compatibility: { cordisx: '^0.1.0' },
      authors: [{ name: 'CordisX Team', url: 'https://cordisx.github.io/' }],
      keywords: ['trusted'],
    }],
    official: [{
      $schema: OFFICIAL_SCHEMA,
      schemaVersion: 1,
      designation: 'cordisx-official',
      identity: {
        pluginId: 'trusted',
        canonicalSource: TRUST_SOURCE,
        publisherIdentity: 'npm:@cordisx',
        packageNamespace: '@cordisx',
        packageName: '@cordisx/trusted',
      },
      verificationPolicy: { id: 'cordisx-official-publisher', version: '1.0.0' },
      verifiedAt: '2026-08-20T00:00:00Z',
      reviewer: { authority: 'cordisx.marketplace.codeowners/v1', evidenceRef: TRUST_EVIDENCE },
      status: 'active',
      label: { key: 'official.label', fallback: 'Official' },
      description: { key: 'official.description', fallback: 'Created and maintained by CordisX.' },
    }],
    certifications: [{
      $schema: CERTIFICATION_SCHEMA,
      schemaVersion: 1,
      level: 'cordisx-certified',
      identity: { pluginId: 'trusted', version: '1.2.3', canonicalSource: TRUST_SOURCE, integrity: TRUST_DIGEST },
      reviewPolicy: { id: 'cordisx-marketplace-review', version: '1.0.0' },
      reviewedAt: '2026-08-20T00:00:00Z',
      expiresAt: '2027-08-20T00:00:00Z',
      reviewer: { authority: 'cordisx.marketplace.codeowners/v1', evidenceRef: TRUST_EVIDENCE },
      status: certificationStatus,
      ...(certificationStatus === 'revoked' ? { revokedAt: '2026-08-23T00:00:00Z' } : {}),
      label: { key: 'certified.label', fallback: 'CordisX Certified' },
      description: { key: 'certified.description', fallback: 'Reviewed under policy 1.0.0.' },
    }],
  }
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

  it('accepts v2 localized discovery metadata and rejects identity-shifting locale data', () => {
    const parsed = parseMarketplaceFeed(localizedFeed())
    expect(parsed).toMatchObject({ schemaVersion: 2, fallbackLocale: 'en', name: 'CordisX Marketplace' })
    expect(parsed.plugins[0]).toMatchObject({
      schemaVersion: 2,
      fallbackLocale: 'en',
      localizations: { 'zh-CN': { name: '点位展示', authors: ['CordisX 团队'] } },
    })

    const wrongAuthors = structuredClone(localizedFeed())
    ;((wrongAuthors.plugins as Record<string, unknown>[])[0]!.localizations as Record<string, Record<string, unknown>>)['zh-CN']!.authors = ['甲', '乙']
    expect(() => parseMarketplaceFeed(wrongAuthors)).toThrow('保持作者顺序和数量')

    const noncanonical = structuredClone(localizedFeed())
    noncanonical.fallbackLocale = 'zh-cn'
    expect(() => parseMarketplaceFeed(noncanonical)).toThrow('canonical locale')
  })

  it('accepts v3 artifact metadata but projects trust only for an explicitly configured root', () => {
    const untrusted = parseMarketplaceFeed(trustedFeed())
    const trusted = parseMarketplaceFeed(trustedFeed(), {
      feedUrl: OFFICIAL_MARKETPLACE_SOURCE,
      trustedRoots: [OFFICIAL_MARKETPLACE_SOURCE],
      now: '2026-08-24T13:00:00Z',
    })

    expect(untrusted.trust).toEqual(expect.objectContaining({ trusted: false }))
    expect(untrusted.trust?.byPluginIdentity.size).toBe(0)
    expect(trusted.plugins[0]?.artifact).toEqual(expect.objectContaining({ integrity: TRUST_DIGEST }))
    expect(trusted.trust?.byPluginIdentity.get(`${TRUST_SOURCE}\u0000trusted`)).toEqual(expect.objectContaining({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
      certification: expect.objectContaining({ level: 'cordisx-certified' }),
    }))

    const selfDeclared = structuredClone(trustedFeed())
    ;(selfDeclared.plugins as Record<string, unknown>[])[0]!.official = true
    expect(() => parseMarketplaceFeed(selfDeclared)).toThrow('不支持的字段: official')
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

  it('reprojects cached v2 metadata and indexes current plus fallback locale without refetching', async () => {
    const source = 'https://catalog.example/localized.json'
    let requests = 0
    const model = new BrowserMarketplaceModel(undefined, async () => {
      requests += 1
      return { ok: true, status: 200, text: async () => JSON.stringify(localizedFeed()) }
    })
    await model.setSources([source])
    const plugin = model.snapshot().plugins[0]!
    const zh = projectMarketplacePlugin(plugin, 'zh-CN')
    const en = projectMarketplacePlugin(plugin, 'en')
    expect(zh).toMatchObject({
      name: '点位展示',
      description: '展示结构化 CordisX 扩展点。',
      authors: [{ name: 'CordisX 团队', url: 'https://cordisx.github.io/' }],
      keywords: ['扩展点', '界面'],
      feedName: 'CordisX 插件商店',
    })
    expect(en).toMatchObject({ name: 'Slot Showcase', feedName: 'CordisX Marketplace' })
    expect(zh.searchValues).toEqual(expect.arrayContaining([
      '点位展示', '扩展点', 'CordisX 插件商店',
      'Slot Showcase', 'extensions', 'CordisX Marketplace',
      'slot-showcase', '1.2.3',
    ]))
    expect(requests).toBe(1)
    model.dispose()
  })

  it('projects independent trust records and applies certification revocation on reload', async () => {
    let currentFeed = trustedFeed()
    const model = new BrowserMarketplaceModel(undefined, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(currentFeed),
    }))

    await model.reload()
    expect(model.snapshot().sourceStates[0]).toEqual(expect.objectContaining({ trusted: true }))
    expect(model.snapshot().plugins[0]).toEqual(expect.objectContaining({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
      certification: expect.objectContaining({ level: 'cordisx-certified' }),
    }))

    currentFeed = trustedFeed('revoked')
    await model.reload()
    expect(model.snapshot().plugins[0]).toEqual(expect.objectContaining({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
    }))
    expect(model.snapshot().plugins[0]?.certification).toBeUndefined()
    model.dispose()
  })
})
