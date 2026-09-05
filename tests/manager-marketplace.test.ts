import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  MARKETPLACE_SOURCES_KEY,
  OFFICIAL_MARKETPLACE_SOURCE,
  parseMarketplaceFeed,
} from '../packages/cli/src/renderer/marketplace.js'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { managerCopy } from '../packages/cli/src/renderer/ui-copy.js'

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
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
    permissions: [],
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Manager Marketplace product list', () => {
  it('uses the standard clickable card, locale projection/search, and no permanent trust warning', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', {
      url: 'https://codex.local/',
    })
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
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      for (
        let attempt = 0;
        attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin]') === null;
        attempt += 1
      ) await settle()

      const card = dom.window.document.querySelector<HTMLElement>('[data-marketplace-plugin="slot-showcase"]')!
      const primary = card.querySelector<HTMLButtonElement>('.cxc-primary')!
      expect(card.tagName).toBe('DIV')
      expect(card.getAttribute('role')).toBe('listitem')
      expect(primary).not.toBeNull()
      expect(primary.querySelector('.cxm-plugin-icon')).not.toBeNull()
      expect(primary.querySelector('.cxc-title')?.textContent).toBe('点位展示')
      expect(primary.querySelector('.cxc-description')?.textContent).toBe('展示结构化 CordisX 扩展点。')
      expect(primary.querySelector('.cxc-machine-id')?.textContent).toBe('slot-showcase')
      expect(card.querySelector('.cxm-chevron')).toBeNull()
      const content = dom.window.document.querySelector<HTMLElement>('.cxm-content')!
      const discovery = content.querySelector<HTMLElement>('[data-marketplace-discovery-page]')!
      const tools = discovery.querySelector<HTMLElement>('.cxm-marketplace-discovery-tools')!
      const results = discovery.querySelector<HTMLElement>('[data-marketplace-results-scroll]')!
      expect(content.dataset.marketplaceDiscovery).toBe('true')
      expect(tools.querySelector('.cxm-toolbar > .cxc-search [data-collection-search="marketplace"]')).not.toBeNull()
      expect(tools.querySelector('.cxm-toolbar > [data-marketplace-source-menu]')).not.toBeNull()
      expect(tools.querySelector('.cxm-marketplace-filter-row [data-marketplace-certified-only]')).not.toBeNull()
      expect(tools.querySelector('.cxm-marketplace-filter-row [data-marketplace-official-only]')).not.toBeNull()
      expect(tools.querySelector('[data-marketplace-certified-only] svg')?.getAttribute('data-host-icon-key')).toBe(
        'trust.certified',
      )
      expect(tools.querySelector('[data-marketplace-official-only] svg')?.getAttribute('data-host-icon-key')).toBe(
        'trust.official',
      )
      expect(tools.querySelector('[data-marketplace-certified-only] svg')?.getAttribute('data-host-icon-variant')).toBe(
        'regular',
      )
      expect(results.contains(tools)).toBe(false)
      expect([...dom.window.document.querySelectorAll('a')].some(link => link.textContent?.includes('插件商店文档')))
        .toBe(false)
      expect(dom.window.document.body.textContent).not.toContain('商店收录、schema 校验和页面展示都不代表')
      expect(dom.window.document.body.textContent).not.toContain('Shows structured CordisX extension points.')

      const sourceMenu = tools.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!
      expect(sourceMenu.getAttribute('aria-expanded')).toBe('false')
      sourceMenu.click()
      expect(
        dom.window.document.querySelector<HTMLElement>(
          `[data-manager-action-menu="${managerCopy('zh-CN', 'marketplace.source-menu-label')}"]`,
        ),
      ).not.toBeNull()
      expect(sourceMenu.getAttribute('aria-expanded')).toBe('true')
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="manage"]')!.click()
      for (
        let attempt = 0;
        attempt < 20 && dom.window.document.querySelector('[data-marketplace-source-page="index"]') === null;
        attempt += 1
      ) await settle()
      expect(dom.window.document.querySelector('[data-marketplace-source-page="index"]')).not.toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()

      const styles = [...dom.window.document.querySelectorAll('style')].map(item => item.textContent ?? '').join('\n')
      expect(styles).toContain('.cxc-primary {')
      expect(styles).toContain('repeat(auto-fit, minmax(min(100%, 220px), 1fr))')
      expect(styles).toContain('.cxc-card:focus-within .cxc-actions')
      expect(styles).toContain('.cxm-content[data-marketplace-discovery="true"] { overflow: hidden; }')
      expect(styles).toContain('.cxm-marketplace-results { min-width: 0; min-height: 0; flex: 1 1 auto;')

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="marketplace"]')!
      search.value = 'Slot Showcase'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]')).not.toBeNull()
      const fallbackSearch = dom.window.document.querySelector<HTMLInputElement>(
        '[data-collection-search="marketplace"]',
      )!
      fallbackSearch.value = 'CordisX Team'
      fallbackSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]')).not.toBeNull()

      state = snapshot('en')
      for (const listener of listeners) listener()
      const enSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="marketplace"]')!
      enSearch.value = 'Slot Showcase'
      enSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('.cxc-title')?.textContent).toBe('Slot Showcase')
      expect(dom.window.document.querySelector('.cxc-description')?.textContent).toBe(
        'Shows structured CordisX extension points.',
      )
      expect(requests).toBe(1)

      dom.window.document.documentElement.className = 'electron-light'
      await settle()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')?.dataset.cordisxAppTheme)
        .toBe('light')

      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin] .cxc-primary')!.click()
      expect(dom.window.document.querySelector('[data-manager-page-route^="marketplace:"]')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxm-detail-description')?.textContent).toBe(
        'Shows structured CordisX extension points.',
      )
      expect(dom.window.document.body.textContent).not.toContain('外部链接不代表代码审计')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('keeps Official and Certified separate, ranks within text tiers, filters eligibility, and explains provenance accessibly', async () => {
    expect(() =>
      parseMarketplaceFeed(trustedFeed, {
        feedUrl: OFFICIAL_MARKETPLACE_SOURCE,
        trustedRoots: [OFFICIAL_MARKETPLACE_SOURCE],
        now: '2026-08-24T13:00:00Z',
      })
    ).not.toThrow()
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', {
      url: 'https://codex.local/',
    })
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
      for (
        let attempt = 0;
        attempt < 20 && dom.window.document.querySelectorAll('[data-marketplace-plugin]').length < 4;
        attempt += 1
      ) await settle()

      const rows = [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-plugin]')]
      expect(rows.map(row => row.dataset.marketplacePlugin)).toEqual([
        'official-only',
        'trusted',
        'community-certified',
        'exact-match',
      ])
      expect(dom.window.document.querySelector('[data-marketplace-plugin="blocked"]')).toBeNull()

      const trusted = dom.window.document.querySelector<HTMLElement>('[data-marketplace-plugin="trusted"]')!
      expect(trusted.dataset.marketplaceOfficial).toBe('true')
      expect(trusted.dataset.marketplaceCertified).toBe('true')
      expect(trusted.dataset.marketplaceRankingOfficialPriority).toBe('1')
      expect(trusted.dataset.marketplaceRankingTrustBoost).toBeUndefined()
      expect(trusted.querySelectorAll('[data-trust-dimension]')).toHaveLength(2)
      expect(trusted.querySelector('[data-trust-dimension="official"]')?.textContent).toContain('Official')
      expect(trusted.querySelector('[data-trust-dimension="certified"]')?.textContent).toContain('Certified')
      const trustedStatus = trusted.querySelector<HTMLElement>('.cxc-status')!
      expect(trustedStatus.getAttribute('aria-label')).toContain('Official、Certified')
      const trustedPrimary = trusted.querySelector<HTMLButtonElement>('.cxc-primary')!
      expect(trustedPrimary.getAttribute('aria-description')).toContain('Official、Certified')
      trustedPrimary.focus()
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent).toBe('Official、Certified')
      expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent).not.toContain('信任加权')
      expect(trustedPrimary.getAttribute('aria-describedby')).toMatch(/^cordisx-host-tooltip-/)
      trustedPrimary.blur()
      const community = dom.window.document.querySelector<HTMLElement>(
        '[data-marketplace-plugin="community-certified"]',
      )!
      expect(community.dataset.marketplaceOfficial).toBe('false')
      expect(community.dataset.marketplaceCertified).toBe('true')
      expect(community.querySelector('.cxc-status')?.getAttribute('aria-label')).toContain('Certified')

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="marketplace"]')!
      search.value = 'exact-match'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      const searched = [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-plugin]')]
      expect(searched.map(row => row.dataset.marketplacePlugin)).toEqual(['exact-match', 'trusted'])
      expect(searched[0]?.dataset.marketplaceRankingTier).toBe('exact-identity')
      expect(searched[1]?.dataset.marketplaceRankingTier).toBe('all-catalog-terms')
      expect(searched[1]?.dataset.marketplaceRankingExplanation).toContain('认证状态不参与排序')

      const filter = dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')!
      expect(filter.getAttribute('aria-pressed')).toBe('false')
      filter.click()
      expect(
        dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')?.getAttribute(
          'aria-pressed',
        ),
      ).toBe('true')
      expect(
        dom.window.document.querySelector('[data-marketplace-certified-only] svg')?.getAttribute(
          'data-host-icon-state',
        ),
      ).toBe('active')
      expect(
        dom.window.document.querySelector('[data-marketplace-certified-only] svg')?.getAttribute(
          'data-host-icon-variant',
        ),
      ).toBe('filled')
      expect(
        [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-plugin]')].map(row =>
          row.dataset.marketplacePlugin
        ),
      ).toEqual(['trusted'])

      const filteredSearch = dom.window.document.querySelector<HTMLInputElement>(
        '[data-collection-search="marketplace"]',
      )!
      filteredSearch.value = ''
      filteredSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin="trusted"] .cxc-primary')!.click()
      const officialDetail = dom.window.document.querySelector<HTMLElement>(
        '[data-marketplace-trust-dimension="official"]',
      )!
      const certifiedDetail = dom.window.document.querySelector<HTMLElement>(
        '[data-marketplace-trust-dimension="certified"]',
      )!
      expect(officialDetail.textContent).toContain('Created and maintained by CordisX.')
      expect(officialDetail.textContent).toContain('never changes PermissionBroker decisions')
      expect(officialDetail.textContent).not.toContain('DOM/render')
      expect(certifiedDetail.textContent).not.toContain(DIGEST)
      expect(certifiedDetail.textContent).toContain('interface capabilities')
      expect(certifiedDetail.textContent).toContain('current scope and runtime instance')
      expect(certifiedDetail.querySelector<HTMLAnchorElement>('a')?.href).toBe(EVIDENCE)
      const boundary = dom.window.document.querySelector<HTMLElement>('[data-marketplace-trust-boundary]')!
      expect(boundary.textContent).toBe('Certification is not an absolute safety guarantee.')
      expect([...dom.window.document.querySelectorAll<HTMLAnchorElement>('a')]
        .some(link => /docs|文档/iu.test(link.textContent ?? ''))).toBe(false)
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
