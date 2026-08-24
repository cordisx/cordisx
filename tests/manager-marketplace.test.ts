import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { MARKETPLACE_SOURCES_KEY, OFFICIAL_MARKETPLACE_SOURCE, parseMarketplaceFeed } from '../packages/cli/src/renderer/marketplace.js'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'

const SOURCE = 'https://marketplace.example/feed.json'
const PLUGIN_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json'
const FEED_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json'
const PLUGIN_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v3.schema.json'
const FEED_SCHEMA_V3 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v3.schema.json'
const OFFICIAL_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v1.schema.json'
const CERTIFICATION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v1.schema.json'
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

function snapshot(locale: 'en' | 'zh-CN'): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale, direction: 'ltr', version: locale === 'en' ? 2 : 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable',
      supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Manager Marketplace product list', () => {
  it('uses the standard clickable card, locale projection/search, and no permanent trust warning', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([SOURCE]))
    let requests = 0
    Object.defineProperty(dom.window, 'fetch', {
      configurable: true,
      value: async () => {
        requests += 1
        return { ok: true, status: 200, text: async () => JSON.stringify(feed) }
      },
    })
    let state = snapshot('zh-CN')
    const listeners = new Set<() => void>()
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin]') === null; attempt += 1) await settle()

      const card = dom.window.document.querySelector<HTMLElement>('[data-marketplace-plugin="slot-showcase"]')!
      const primary = card.querySelector<HTMLButtonElement>(':scope > .cxm-plugin-primary')!
      expect(card.tagName).toBe('DIV')
      expect(card.getAttribute('role')).toBe('listitem')
      expect(primary).not.toBeNull()
      expect(primary.querySelector('.cxm-plugin-icon')).not.toBeNull()
      expect(primary.querySelector('.cxm-plugin-name')?.textContent).toBe('点位展示')
      expect(primary.querySelector('.cxm-plugin-description')?.textContent).toBe('展示结构化 CordisX 扩展点。')
      expect(primary.querySelector('.cxm-plugin-meta-version')?.textContent).toBe('v1.2.3')
      expect(primary.querySelector('.cxm-plugin-meta-source')?.textContent).toBe('CordisX 插件商店')
      expect(card.querySelector('.cxm-chevron')).toBeNull()
      expect(dom.window.document.body.textContent).not.toContain('商店收录、schema 校验和页面展示都不代表')
      expect(dom.window.document.body.textContent).not.toContain('Shows structured CordisX extension points.')

      const styles = [...dom.window.document.querySelectorAll('style')].map(item => item.textContent ?? '').join('\n')
      expect(styles).toContain('.cxm-plugin-primary { display: flex;')
      expect(styles).toContain('padding: 12px')
      expect(styles).toContain('.cxm-plugin-meta-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }')
      expect(styles).toContain('.cxm-card-grid, .cxm-detail-grid, .cxm-plugin-list { grid-template-columns: 1fr; }')

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      search.value = 'Slot Showcase'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]')).not.toBeNull()
      const fallbackSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      fallbackSearch.value = 'CordisX Team'
      fallbackSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]')).not.toBeNull()

      state = snapshot('en')
      for (const listener of listeners) listener()
      const enSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      enSearch.value = 'Slot Showcase'
      enSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('.cxm-plugin-name')?.textContent).toBe('Slot Showcase')
      expect(dom.window.document.querySelector('.cxm-plugin-description')?.textContent).toBe('Shows structured CordisX extension points.')
      expect(dom.window.document.querySelector('.cxm-plugin-meta-source')?.textContent).toBe('CordisX Marketplace')
      expect(requests).toBe(1)

      dom.window.document.documentElement.className = 'electron-light'
      await settle()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')?.dataset.cordisxAppTheme).toBe('light')

      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin] .cxm-plugin-primary')!
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(dom.window.document.querySelector('[data-manager-page-route^="marketplace:"]')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxm-detail-description')?.textContent).toBe('Shows structured CordisX extension points.')
      expect(dom.window.document.body.textContent).not.toContain('外部链接不代表代码审计')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('keeps Official and Certified separate, ranks within text tiers, filters eligibility, and explains provenance accessibly', async () => {
    expect(() => parseMarketplaceFeed(trustedFeed, {
      feedUrl: OFFICIAL_MARKETPLACE_SOURCE,
      trustedRoots: [OFFICIAL_MARKETPLACE_SOURCE],
      now: '2026-08-24T13:00:00Z',
    })).not.toThrow()
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([OFFICIAL_MARKETPLACE_SOURCE]))
    Object.defineProperty(dom.window, 'fetch', {
      configurable: true,
      value: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(trustedFeed) }),
    })
    const state = snapshot('en')
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      marketplaceEligibility: plugin => plugin.id === 'blocked' ? { policyBlocked: true } : {},
      subscribe: () => () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      for (let attempt = 0; attempt < 20 && dom.window.document.querySelectorAll('[data-marketplace-plugin]').length < 4; attempt += 1) await settle()

      const rows = [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-plugin]')]
      expect(rows.map(row => row.dataset.marketplacePlugin)).toEqual(['trusted', 'official-only', 'community-certified', 'exact-match'])
      expect(dom.window.document.querySelector('[data-marketplace-plugin="blocked"]')).toBeNull()

      const trusted = dom.window.document.querySelector<HTMLElement>('[data-marketplace-plugin="trusted"]')!
      expect(trusted.dataset.marketplaceOfficial).toBe('true')
      expect(trusted.dataset.marketplaceCertified).toBe('true')
      expect(trusted.dataset.marketplaceRankingTrustBoost).toBe('2')
      expect(trusted.querySelector('[data-trust-dimension="official"]')?.textContent).toContain('官方')
      expect(trusted.querySelector('[data-trust-dimension="certified"]')?.textContent).toContain('已认证')
      expect(trusted.querySelector('[data-material-icon="marketplace-official"]')).not.toBeNull()
      expect(trusted.querySelector('[data-material-icon="marketplace-certified"]')).not.toBeNull()
      expect(trusted.querySelector('[data-trust-dimension="official"]')?.getAttribute('aria-label')).toContain('不等于该版本已认证')
      expect(trusted.querySelector('[data-trust-dimension="certified"]')?.getAttribute('aria-label')).toContain('不是绝对安全保证')
      const trustedPrimary = trusted.querySelector<HTMLButtonElement>('.cxm-plugin-primary')!
      expect(trustedPrimary.getAttribute('aria-label')).toContain('官方 · 已认证')
      trustedPrimary.focus()
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent).toContain('信任加权只在同一文本相关性层级内生效')
      expect(trustedPrimary.getAttribute('aria-describedby')).toMatch(/^cordisx-host-tooltip-/)
      trustedPrimary.blur()
      const community = dom.window.document.querySelector<HTMLElement>('[data-marketplace-plugin="community-certified"]')!
      expect(community.dataset.marketplaceOfficial).toBe('false')
      expect(community.dataset.marketplaceCertified).toBe('true')
      expect(community.querySelector('[data-trust-dimension="official"]')).toBeNull()
      expect(community.querySelector('[data-trust-dimension="certified"]')).not.toBeNull()

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      search.value = 'exact-match'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      const searched = [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-plugin]')]
      expect(searched.map(row => row.dataset.marketplacePlugin)).toEqual(['exact-match', 'trusted'])
      expect(searched[0]?.dataset.marketplaceRankingTier).toBe('exact-identity')
      expect(searched[1]?.dataset.marketplaceRankingTier).toBe('all-catalog-terms')
      expect(searched[1]?.dataset.marketplaceRankingExplanation).toContain('信任加权只在同一文本相关性层级内生效')

      const filter = dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')!
      expect(filter.getAttribute('aria-pressed')).toBe('false')
      filter.click()
      expect(dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')?.getAttribute('aria-pressed')).toBe('true')
      expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-plugin]')].map(row => row.dataset.marketplacePlugin)).toEqual(['trusted'])

      const filteredSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      filteredSearch.value = ''
      filteredSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin="trusted"] .cxm-plugin-primary')!.click()
      const officialDetail = dom.window.document.querySelector<HTMLElement>('[data-marketplace-trust-dimension="official"]')!
      const certifiedDetail = dom.window.document.querySelector<HTMLElement>('[data-marketplace-trust-dimension="certified"]')!
      expect(officialDetail.textContent).toContain('cordisx-official-publisher@1.0.0')
      expect(officialDetail.textContent).toContain('不等于该发布物已经通过版本认证')
      expect(certifiedDetail.textContent).toContain('cordisx-marketplace-review@1.0.0')
      expect(certifiedDetail.textContent).toContain(`发布物 ${DIGEST}`)
      expect(certifiedDetail.textContent).toContain('认证不是绝对安全保证')
      expect(certifiedDetail.querySelector<HTMLAnchorElement>('a')?.href).toBe(EVIDENCE)
      const boundary = dom.window.document.querySelector<HTMLElement>('[data-marketplace-trust-boundary]')!
      expect(boundary.textContent).toBe('认证不等于安全保障。')
      const documentation = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('a')]
        .find(link => link.textContent?.includes('查看信任说明'))
      expect(documentation?.href).toContain('/.agents/docs/dynamic-plugin-lifecycle.md')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
