import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ManagerPluginSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { PluginManagementSnapshot } from '../packages/cli/src/management/contracts.js'
import type { ManagerPluginManagementBinding } from '../packages/cli/src/renderer/manager/model/plugin-management.js'
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

async function installLifecycleDialogHost(fixture: ReturnType<typeof reactManagerFixture>) {
  fixture.dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
  }
  fixture.dom.window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
  }
  const host = await import('../packages/cli/src/renderer/dialogs/host.js')
  return {
    center: host.dialogCenterForDocument,
    dispose: host.installDialogHost(fixture.document),
  }
}

function installedPlugin(source: string): ManagerPluginSnapshot {
  return {
    id: 'trusted',
    name: 'Trusted Booster',
    source,
    status: 'active',
    inject: [],
    config: {},
    configuration: {
      namespace: 'trusted',
      schemaKind: 'none',
      applies: 'live',
      writable: false,
      revision: 1,
      lastGoodRevision: 1,
      value: {},
      fields: [],
      secrets: [],
    },
    package: {
      version: '1.2.3',
      digest: DIGEST,
      moduleGeneration: 'installed',
      dependencies: [],
    },
  }
}

function managementSnapshot(hiddenCatalogEntries: PluginManagementSnapshot['hiddenCatalogEntries'] = []) {
  return {
    profileId: 'test',
    revision: 9,
    sources: [],
    hiddenCatalogEntries,
    migrations: { legacyBrowserSourcesV2: true },
    runtime: { kind: 'active' as const, runtimeGeneration: 'runtime' },
    activationRevision: 1,
    plugins: [],
  }
}

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

  it('keeps idle install controls enabled for an uninstalled artifact in list and detail views', async () => {
    const fixture = reactManagerFixture()
    const { MarketplacePage } = await import('../packages/cli/src/renderer/manager/pages/MarketplacePage.js')
    const { MarketplacePluginPage } = await import(
      '../packages/cli/src/renderer/manager/pages/MarketplacePluginPage.js'
    )
    fixture.dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([OFFICIAL_MARKETPLACE_SOURCE]))
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(trustedFeed) }),
    )
    await marketplace.reload()
    const state = managerSnapshot({
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    const model = managerModel(state, {
      inspectMarketplaceArtifact: vi.fn(),
      requestPluginLifecycle: vi.fn(),
    })
    const plugin = marketplace.snapshot().plugins.find(item => item.id === 'trusted')!
    try {
      await fixture.render(
        <MarketplacePage marketplace={marketplace} manager={model} snapshot={state} router={managerRouter()} />,
      )
      const listInstall = fixture.element('[data-marketplace-plugin="trusted"] [aria-label="Install"]')
      expect(listInstall.classList.contains('t-is-disabled')).toBe(false)
      expect(listInstall).toHaveProperty('disabled', false)

      await fixture.render(
        <MarketplacePluginPage
          marketplace={marketplace}
          manager={model}
          snapshot={state}
          router={managerRouter({ kind: 'marketplace-plugin', identity: plugin.identity })}
        />,
      )
      const detailInstall = fixture.element('[data-marketplace-plugin-detail="trusted"] [aria-label="Install"]')
      expect(detailInstall.classList.contains('t-is-disabled')).toBe(false)
      expect(detailInstall).toHaveProperty('disabled', false)
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('disables other Marketplace install actions while one installation is active', async () => {
    const fixture = reactManagerFixture()
    const { MarketplacePage } = await import('../packages/cli/src/renderer/manager/pages/MarketplacePage.js')
    fixture.dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([OFFICIAL_MARKETPLACE_SOURCE]))
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(trustedFeed) }),
    )
    await marketplace.reload()
    const state = managerSnapshot({
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    const inspect = vi.fn((_request, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    )
    try {
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(state, { inspectMarketplaceArtifact: inspect, requestPluginLifecycle: vi.fn() })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[data-marketplace-plugin="trusted"] [aria-label="Install"]')
      expect(fixture.document.querySelector('[data-marketplace-plugin="trusted"] [aria-label="Cancel installation"]'))
        .not.toBeNull()
      const competingInstall = fixture.element(
        '[data-marketplace-plugin="official-only"] [aria-label="Install"]',
      )
      expect(competingInstall.classList.contains('t-is-disabled')).toBe(true)
      expect(inspect).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('exposes installed lifecycle actions without conflating them with install or discovery state', async () => {
    const fixture = reactManagerFixture()
    const dialogs = await installLifecycleDialogHost(fixture)
    const { MarketplacePage } = await import('../packages/cli/src/renderer/manager/pages/MarketplacePage.js')
    fixture.dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([OFFICIAL_MARKETPLACE_SOURCE]))
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(trustedFeed) }),
    )
    await marketplace.reload()
    const installed = installedPlugin(TRUSTED_SOURCE)
    const request = vi.fn().mockResolvedValue({
      outcome: 'planned',
      impactToken: 'marketplace-uninstall-impact',
      affectedPluginIds: ['trusted'],
    })
    const state = managerSnapshot({
      plugins: [installed],
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    try {
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(state, { requestPluginLifecycle: request })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      const card = fixture.element(`[data-marketplace-plugin="trusted"]`)
      expect(card.textContent).toContain('Installed')
      expect(card.querySelector('[aria-label="Uninstall"]')).not.toBeNull()
      await fixture.click(`[data-marketplace-plugin="trusted"] [aria-label="Uninstall"]`)
      const confirmation = dialogs.center(fixture.document)!.visible()[0]!
      expect(confirmation.chrome.title).toBe('Uninstall plugin?')
      await act(async () => confirmation.handle.close('cancel'))
      expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'uninstall', pluginId: 'trusted', impactToken: '' })

      await fixture.click(`[data-marketplace-plugin="trusted"] [aria-haspopup="menu"]`)
      const menuItems = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
      const disable = menuItems.find(item => item.textContent?.includes('Disable'))
      expect(disable).toBeDefined()
      expect(menuItems.find(item => item.textContent?.includes('Uninstall'))).toBeUndefined()

      const disabledState = managerSnapshot({
        ...state,
        plugins: [{ ...installed, status: 'configured-disabled' }],
      })
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(disabledState, { requestPluginLifecycle: request })}
          snapshot={disabledState}
          router={managerRouter()}
        />,
      )
      await fixture.click(`[data-marketplace-plugin="trusted"] [aria-haspopup="menu"]`)
      expect([...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
        .find(item => item.textContent?.includes('Enable'))).toBeDefined()

      const outdatedState = managerSnapshot({
        ...state,
        plugins: [{ ...installed, package: { ...installed.package!, version: '1.0.0' } }],
      })
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(outdatedState, { requestPluginLifecycle: request })}
          snapshot={outdatedState}
          router={managerRouter()}
        />,
      )
      await fixture.click(`[data-marketplace-plugin="trusted"] [aria-haspopup="menu"]`)
      expect([...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
        .find(item => item.textContent?.includes('Update'))).toBeDefined()

      const developmentState = managerSnapshot({
        ...state,
        plugins: [{
          ...installed,
          development: {
            origin: 'local-dev',
            sourcePath: '/plugins/trusted',
            state: 'ready',
          },
        }],
      })
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel(developmentState, { requestPluginLifecycle: request })}
          snapshot={developmentState}
          router={managerRouter()}
        />,
      )
      expect(
        fixture.element(`[data-marketplace-plugin="trusted"] [aria-label="Installed"]`)
          .classList.contains('t-is-disabled'),
      ).toBe(true)
      expect(fixture.document.querySelector(`[data-marketplace-plugin="trusted"] [aria-label="Uninstall"]`))
        .toBeNull()
    } finally {
      await act(async () => dialogs.dispose())
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('filters hidden discovery identities and submits hide with the shared management revision', async () => {
    const fixture = reactManagerFixture()
    const { MarketplacePage } = await import('../packages/cli/src/renderer/manager/pages/MarketplacePage.js')
    fixture.dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([OFFICIAL_MARKETPLACE_SOURCE]))
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(trustedFeed) }),
    )
    await marketplace.reload()
    const visibleSnapshot = managementSnapshot()
    const mutate = vi.fn().mockImplementation(async request => ({
      status: 'applied' as const,
      request,
      snapshot: visibleSnapshot,
      pendingActivation: false,
    }))
    const binding: ManagerPluginManagementBinding = {
      query: vi.fn(async () => visibleSnapshot),
      subscribe: vi.fn(() => () => {}),
      mutate,
      migrateLegacySources: vi.fn(async () => ({
        migrated: false,
        clearLegacyStorage: false,
        snapshot: visibleSnapshot,
      })),
    }
    try {
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel()}
          snapshot={managerSnapshot()}
          router={managerRouter()}
          pluginManagement={binding}
          pluginManagementSnapshot={visibleSnapshot}
        />,
      )
      await fixture.click(`[data-marketplace-plugin="trusted"] [aria-haspopup="menu"]`)
      const hide = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
        .find(item => item.textContent?.includes('Hide from Marketplace'))
      expect(hide).toBeDefined()
      await act(async () => {
        hide!.click()
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      expect(mutate).toHaveBeenCalledWith({
        kind: 'catalog-hide',
        identity: { sourceUrl: OFFICIAL_MARKETPLACE_SOURCE, pluginId: 'trusted' },
      }, 9)
      const hiddenSnapshot = managementSnapshot([{ sourceUrl: OFFICIAL_MARKETPLACE_SOURCE, pluginId: 'trusted' }])
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={managerModel()}
          snapshot={managerSnapshot()}
          router={managerRouter()}
          pluginManagement={binding}
          pluginManagementSnapshot={hiddenSnapshot}
        />,
      )
      expect(fixture.document.querySelector('[data-marketplace-plugin="trusted"]')).toBeNull()
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })
})
