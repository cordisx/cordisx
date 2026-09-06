import React from 'react'
import { describe, expect, it } from 'vitest'
import {
  BrowserMarketplaceModel,
  MARKETPLACE_SOURCES_KEY,
  OFFICIAL_MARKETPLACE_SOURCE,
} from '../packages/cli/src/renderer/marketplace.js'
import { managerModel, managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'
const SOURCE = 'https://marketplace.example/feed.json'
const PLUGIN_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json'
const FEED_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json'
const PLUGIN_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v3.schema.json'
const FEED_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v3.schema.json'
const OFFICIAL_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v1.schema.json'
const CERTIFICATION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v1.schema.json'
const EVIDENCE = `https://github.com/cordisx/marketplace/commit/${'b'.repeat(40)}`
const DIGEST = `sha256:${'a'.repeat(64)}`

const feed = {
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
    homepage: 'https://cordisx.github.io/',
    license: 'MIT',
    compatibility: { cordisx: '^0.1.0' },
    authors: [{ name: 'CordisX Team', url: 'https://cordisx.github.io/' }],
    keywords: ['extensions', 'ui'],
  }],
}

function trustPlugin(
  id: string,
  name: string,
  source: string,
  namespace: string,
  keywords: readonly string[] = [],
): Record<string, unknown> {
  return {
    $schema: PLUGIN_SCHEMA_V3,
    schemaVersion: 3,
    id,
    fallbackLocale: 'en',
    name,
    description: `${name} marketplace description.`,
    version: '1.2.3',
    source,
    artifact: {
      publisherIdentity: `npm:${namespace}`,
      packageNamespace: namespace,
      packageName: `${namespace}/${id}`,
      downloadUrl: `https://registry.npmjs.org/${namespace}/${id}/-/${id}-1.2.3.tgz`,
      integrity: DIGEST,
    },
    license: 'MIT',
    compatibility: { cordisx: '^0.1.0' },
    authors: [{ name: namespace === '@cordisx' ? 'CordisX Team' : 'Community Maintainer' }],
    keywords,
  }
}

function official(id: string, source: string): Record<string, unknown> {
  return {
    $schema: OFFICIAL_SCHEMA,
    schemaVersion: 1,
    designation: 'cordisx-official',
    identity: {
      pluginId: id,
      canonicalSource: source,
      publisherIdentity: 'npm:@cordisx',
      packageNamespace: '@cordisx',
      packageName: `@cordisx/${id}`,
    },
    verificationPolicy: { id: 'cordisx-official-publisher', version: '1.0.0' },
    verifiedAt: '2026-08-20T00:00:00Z',
    reviewer: { authority: 'cordisx.marketplace.codeowners/v1', evidenceRef: EVIDENCE },
    status: 'active',
    label: { key: 'official.label', fallback: 'Official' },
    description: { key: 'official.description', fallback: 'Created and maintained by CordisX.' },
  }
}

function certification(id: string, source: string): Record<string, unknown> {
  return {
    $schema: CERTIFICATION_SCHEMA,
    schemaVersion: 1,
    level: 'cordisx-certified',
    identity: { pluginId: id, version: '1.2.3', canonicalSource: source, integrity: DIGEST },
    reviewPolicy: { id: 'cordisx-marketplace-review', version: '1.0.0' },
    reviewedAt: '2026-08-20T00:00:00Z',
    expiresAt: '2027-08-20T00:00:00Z',
    reviewer: { authority: 'cordisx.marketplace.codeowners/v1', evidenceRef: EVIDENCE },
    status: 'active',
    label: { key: 'certified.label', fallback: 'CordisX Certified' },
    description: { key: 'certified.description', fallback: 'Reviewed under policy 1.0.0.' },
  }
}

const TRUSTED_SOURCE = 'https://github.com/cordisx/trusted'
const OFFICIAL_ONLY_SOURCE = 'https://github.com/cordisx/official-only'
const COMMUNITY_SOURCE = 'https://github.com/example/community-certified'
const EXACT_SOURCE = 'https://github.com/example/exact-match'
const BLOCKED_SOURCE = 'https://github.com/example/blocked'

const trustedFeed = {
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
  homepage: 'https://cordisx.github.io/marketplace/',
  plugins: [
    trustPlugin('official-only', 'Official Only', OFFICIAL_ONLY_SOURCE, '@cordisx'),
    trustPlugin('trusted', 'Trusted Booster', TRUSTED_SOURCE, '@cordisx', ['exact-match']),
    trustPlugin('blocked', 'Blocked By Policy', BLOCKED_SOURCE, '@example'),
    trustPlugin('community-certified', 'Community Certified', COMMUNITY_SOURCE, '@example'),
    trustPlugin('exact-match', 'Exact Match', EXACT_SOURCE, '@example'),
  ],
  official: [official('official-only', OFFICIAL_ONLY_SOURCE), official('trusted', TRUSTED_SOURCE)],
  certifications: [certification('trusted', TRUSTED_SOURCE), certification('community-certified', COMMUNITY_SOURCE)],
}

describe('React Manager Marketplace', () => {
  it('preserves eligibility, independent Official and Certified filters, exact text tiers, and accessible provenance', async () => {
    const fixture = reactManagerFixture()
    const { MarketplacePage } = await import('../packages/cli/src/renderer/manager/pages/MarketplacePage.js')
    fixture.dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([OFFICIAL_MARKETPLACE_SOURCE]))
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(trustedFeed) }),
    )
    await marketplace.reload()
    const state = managerSnapshot()
    const model = managerModel(state, {
      marketplaceEligibility: plugin => plugin.id === 'blocked' ? { policyBlocked: true } : {},
    })
    const router = managerRouter({ kind: 'primary', page: 'plugins' })
    const titles = () =>
      [...fixture.document.querySelectorAll('.cxr-marketplace .cxr-card-title')].map(item => item.textContent)
    try {
      await fixture.render(
        <MarketplacePage marketplace={marketplace} manager={model} snapshot={state} router={router} />,
      )
      expect(titles()).toEqual(['Official Only', 'Trusted Booster', 'Community Certified', 'Exact Match'])
      expect(fixture.document.body.textContent).not.toContain('Blocked By Policy')
      const trusted = fixture.document.querySelectorAll('.cxr-marketplace-primary')[1]!
      expect(trusted.getAttribute('aria-label')).toContain('Official')
      expect(trusted.getAttribute('aria-label')).toContain('Certified')
      await fixture.click('[aria-label="Official only"]')
      expect(titles()).toEqual(['Official Only', 'Trusted Booster'])
      await fixture.click('[aria-label="Certified only"]')
      expect(titles()).toEqual(['Trusted Booster'])
      await fixture.click('[aria-label="Official only"]')
      expect(titles()).toEqual(['Trusted Booster', 'Community Certified'])
      await fixture.click('[aria-label="Certified only"]')
      await fixture.type('.cxr-marketplace-search input', 'exact-match')
      expect(titles()[0]).toBe('Exact Match')
      await fixture.click('.cxr-marketplace-primary')
      expect(router.navigate).toHaveBeenCalledWith({
        kind: 'marketplace-plugin',
        identity: marketplace.snapshot().plugins.find(plugin => plugin.id === 'exact-match')!.identity,
      })
      await fixture.type('.cxr-marketplace-search input', 'nothing-matches')
      expect(titles()).toHaveLength(0)
      expect(fixture.document.querySelector('[role="search"] input')).not.toBeNull()
      await fixture.click('[aria-label="Manage sources"]')
      expect(router.navigate).toHaveBeenLastCalledWith({ kind: 'marketplace-sources' })
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('projects localized feed metadata and persists favorites without enabling unavailable install', async () => {
    const fixture = reactManagerFixture()
    const { MarketplacePage } = await import('../packages/cli/src/renderer/manager/pages/MarketplacePage.js')
    fixture.dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([SOURCE]))
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(feed) }),
    )
    await marketplace.reload()
    const state = managerSnapshot({ localization: { locale: 'zh-CN', direction: 'ltr', version: 1 } })
    try {
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(state)}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      expect(fixture.document.body.textContent).toContain('点位展示')
      expect(fixture.element('[aria-label="安装"]').classList.contains('t-is-disabled')).toBe(true)
      await fixture.click('[aria-label="收藏"]')
      expect(fixture.document.querySelector('[aria-label="取消收藏"]')).not.toBeNull()
      await fixture.render(null)
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(state)}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      expect(fixture.document.querySelector('[aria-label="取消收藏"]')).not.toBeNull()
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })
})
