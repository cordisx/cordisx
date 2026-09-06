import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  type CordisXPluginBundleLifecycleResultV1,
} from '../packages/cli/src/plugin-bundle-contracts.js'
import {
  CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
  type CordisXPluginLifecycleResultV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { useManagerRouter } from '../packages/cli/src/renderer/manager/hooks/useManagerRouter.js'
import {
  normalizeManagerHistory,
  normalizeManagerRoute,
  primaryFor,
} from '../packages/cli/src/renderer/manager/model/routes.js'
import { inspectUnifiedLocalPluginSource } from '../packages/cli/src/renderer/manager/pages/PluginBundlesPage.js'
import { MarketplacePage } from '../packages/cli/src/renderer/manager/pages/MarketplacePage.js'
import { PluginsPage, unifiedPluginSections } from '../packages/cli/src/renderer/manager/pages/PluginsPage.js'
import type { MarketplaceModel, MarketplaceSnapshot } from '../packages/cli/src/renderer/marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'

vi.mock('tdesign-react', () => ({
  Button: ({ children, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly loading?: boolean
  }) => <button {...props}>{children}</button>,
}))

vi.mock('../packages/cli/src/renderer/host-ui/IconButton.js', () => ({
  IconButton: ({ label, description: _description, icon: _icon, loading: _loading, ...props }: {
    readonly label: string
    readonly description?: string
    readonly icon: string
    readonly loading?: boolean
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{label}</button>,
}))

vi.mock('../packages/cli/src/renderer/host-ui/MoreMenu.js', () => ({
  MoreMenu: ({ label }: { readonly label: string }) => <button type="button">{label}</button>,
}))

function pluginResult(
  operation: CordisXPluginLifecycleResultV1['operation'],
): CordisXPluginLifecycleResultV1 {
  return {
    $schema: CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
    schemaVersion: 1,
    requestId: 'plugin-request',
    profileId: 'test',
    operation,
    outcome: 'planned',
    revision: 1,
    runtimeGeneration: 'runtime-a',
    scope: 'plugin-generation',
    affectedPluginIds: ['notes'],
    candidateId: 'candidate-plugin',
    package: {
      id: 'notes',
      name: 'Notes',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      dependencies: [],
    },
  }
}

function bundleResult(errorCode?: 'invalid-bundle' | 'operation-unavailable'): CordisXPluginBundleLifecycleResultV1 {
  return {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-bundle-lifecycle-result.v1.schema.json',
    schemaVersion: 1,
    requestId: 'bundle-request',
    profileId: 'test',
    operation: 'inspect-source',
    outcome: errorCode === undefined ? 'planned' : 'rejected',
    revision: 1,
    pluginRevision: 1,
    runtimeGeneration: 'runtime-a',
    bundleId: 'workflow',
    candidateId: 'candidate-bundle',
    impactToken: 'impact',
    affectedPluginIds: ['notes'],
    retainedPluginIds: [],
    removedPluginIds: [],
    ...(errorCode === undefined ? {} : { error: { code: errorCode, message: errorCode } }),
  }
}

function managerSnapshot(): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [{
      id: 'notes',
      source: 'file:///plugins/notes',
      name: 'Notes',
      description: 'Installed note tools',
      inject: [],
      config: {},
      configuration: { revision: 1, fields: [] },
      status: 'active',
    }],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'test',
      hostName: 'Test',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
    permissions: [],
    pluginLifecycle: { profileId: 'test', revision: 1, runtimeGeneration: 'runtime-a', operationsAvailable: true },
    pluginBundles: {
      $schema: CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
      schemaVersion: 1,
      profileId: 'test',
      revision: 1,
      pluginRevision: 1,
      runtimeGeneration: 'runtime-a',
      operationsAvailable: true,
      bundles: [{
        id: 'workflow',
        name: 'Workflow Pack',
        version: '1.0.0',
        digest: `sha256:${'b'.repeat(64)}`,
        authors: ['CordisX'],
        sourceLabel: 'local bundle',
        installedAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        status: 'active',
        enabled: true,
        readme: 'README',
        availableOperations: ['disable'],
        members: [{
          pluginId: 'notes',
          requestedVersion: '1.0.0',
          installedVersion: '1.0.0',
          required: true,
          enabledByDefault: true,
          enabled: true,
          state: 'active',
          installedViaBundle: true,
          bundleIds: ['workflow'],
          directClaim: false,
          runtimeDependentIds: [],
        }],
        permissions: [],
        claims: [{ pluginId: 'notes', kind: 'bundle', claimantId: 'workflow' }],
        dependencies: [],
        records: [],
      }],
    },
  }
}

function marketplaceSnapshot(): MarketplaceSnapshot {
  return {
    sources: [],
    sourceRecords: [],
    sourceStates: [],
    duplicates: [],
    loading: false,
    revalidating: false,
    plugins: [
      {
        schemaVersion: 1,
        id: 'remote-notes',
        fallbackLocale: 'en',
        name: 'Remote Notes',
        description: 'Browse-only remote plugin',
        localizations: {},
        version: '2.0.0',
        source: 'https://plugins.example/remote-notes',
        license: 'MIT',
        compatibility: { cordisx: '*' },
        authors: [{ name: 'CordisX' }],
        keywords: [],
        identity: 'https://plugins.example/remote-notes\0remote-notes',
        feedUrl: 'https://plugins.example/feed.json',
        feedName: 'Example',
        feedFallbackLocale: 'en',
        feedLocalizations: {},
        feedHomepage: 'https://plugins.example/',
      },
      {
        schemaVersion: 1,
        id: 'notes',
        fallbackLocale: 'en',
        name: 'Installed Notes duplicate',
        description: 'Must be overlaid by the installed registry',
        localizations: {},
        version: '1.0.0',
        source: 'file:///plugins/notes',
        license: 'MIT',
        compatibility: { cordisx: '*' },
        authors: [{ name: 'CordisX' }],
        keywords: [],
        identity: 'file:///plugins/notes\0notes',
        feedUrl: 'https://plugins.example/feed.json',
        feedName: 'Example',
        feedFallbackLocale: 'en',
        feedLocalizations: {},
        feedHomepage: 'https://plugins.example/',
      },
    ],
  }
}

describe('unified Plugins information architecture', () => {
  it('normalizes all legacy primary aliases while retaining detail routes under Plugins', () => {
    expect(normalizeManagerRoute({ kind: 'primary', page: 'plugin-bundles' })).toEqual({
      kind: 'primary',
      page: 'plugins',
    })
    expect(normalizeManagerRoute({ kind: 'primary', page: 'marketplace' })).toEqual({
      kind: 'primary',
      page: 'plugins',
    })
    expect(normalizeManagerHistory([
      { kind: 'primary', page: 'marketplace' },
      { kind: 'marketplace-plugin', identity: 'plugin' },
    ])).toEqual([
      { kind: 'primary', page: 'plugins' },
      { kind: 'marketplace-plugin', identity: 'plugin' },
    ])
    expect(normalizeManagerHistory([
      { kind: 'primary', page: 'plugins' },
      { kind: 'primary', page: 'marketplace' },
      { kind: 'primary', page: 'plugin-bundles' },
    ])).toEqual([{ kind: 'primary', page: 'plugins' }])
    expect(primaryFor({ kind: 'plugin-bundle', bundleId: 'workflow', page: 'readme' })).toBe('plugins')
    expect(primaryFor({ kind: 'marketplace-sources' })).toBe('plugins')
  })

  it('normalizes persisted, navigate, replace, and restore history before exposing it', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://codex.local/',
    })
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      window: dom.window,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    dom.window.sessionStorage.setItem(
      'cordisx.playground.manager.history.v1',
      JSON.stringify([{ kind: 'primary', page: 'plugin-bundles' }]),
    )
    let router: ReturnType<typeof useManagerRouter> | undefined
    function Harness() {
      router = useManagerRouter(dom.window.sessionStorage)
      return null
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<Harness />))
      expect(router?.route).toEqual({ kind: 'primary', page: 'plugins' })
      await act(async () => router?.navigate({ kind: 'primary', page: 'marketplace' }))
      expect(router?.route).toEqual({ kind: 'primary', page: 'plugins' })
      await act(async () => router?.replace({ kind: 'primary', page: 'plugin-bundles' }))
      expect(router?.route).toEqual({ kind: 'primary', page: 'plugins' })
      await act(async () => router?.restore([{ kind: 'primary', page: 'marketplace' }]))
      expect(router?.capture()).toEqual([{ kind: 'primary', page: 'plugins' }])
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })

  it('falls through from bundle inspection only for an explicit invalid-bundle result', async () => {
    const plugin = vi.fn(async () => pluginResult('install'))
    const bundle = vi.fn(async () => bundleResult('invalid-bundle'))
    expect(
      await inspectUnifiedLocalPluginSource(
        { requestPluginBundleLifecycle: bundle, requestPluginLifecycle: plugin },
        '/tmp/plugin',
      ),
    )
      .toMatchObject({ kind: 'plugin' })
    expect(bundle).toHaveBeenCalledTimes(1)
    expect(plugin).toHaveBeenCalledTimes(1)

    plugin.mockClear()
    bundle.mockResolvedValueOnce(bundleResult('operation-unavailable'))
    expect(
      await inspectUnifiedLocalPluginSource(
        { requestPluginBundleLifecycle: bundle, requestPluginLifecycle: plugin },
        '/tmp/plugin',
      ),
    )
      .toMatchObject({ kind: 'bundle', result: { error: { code: 'operation-unavailable' } } })
    expect(plugin).not.toHaveBeenCalled()
  })

  it('renders installed, bundle-carrier, and Marketplace results from one query and filter state', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://codex.local/',
    })
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      HTMLElement: globalThis.HTMLElement,
      MutationObserver: globalThis.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      window: dom.window,
      HTMLElement: dom.window.HTMLElement,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperty(dom.window, 'matchMedia', {
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })
    const state = managerSnapshot()
    const marketState = marketplaceSnapshot()
    const manager: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: () => () => {},
    }
    const marketplace: MarketplaceModel = {
      snapshot: () => marketState,
      setSources: async () => {},
      setSourceRecords: async () => {},
      upsertSource: async () => {},
      removeSource: async () => {},
      setSourceEnabled: async () => {},
      moveSource: async () => {},
      importSource: async () => {
        throw new Error('not used')
      },
      reload: async () => {},
      subscribe: () => () => {},
      dispose: () => {},
    }
    const router = {
      route: { kind: 'primary', page: 'plugins' } as const,
      navigate: vi.fn(),
      replace: vi.fn(),
      openDetail: vi.fn(),
      back: vi.fn(),
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () =>
        root.render(
          <PluginsPage model={manager} marketplace={marketplace} snapshot={state} router={router} />,
        )
      )
      expect(dom.window.document.querySelector('[data-unified-plugins-page]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-unified-plugins-page]')?.getAttribute('aria-label')).toBe(
        'Plugins, plugin bundles, and Marketplace catalog',
      )
      expect(dom.window.document.querySelector('[data-plugin-id="notes"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-bundle-id="workflow"]')).not.toBeNull()
      expect(dom.window.document.querySelectorAll('[data-plugin-result-source="marketplace"]')).toHaveLength(1)
      expect(dom.window.document.querySelector('[data-marketplace-plugin="remote-notes"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-marketplace-plugin="notes"]')).toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-bundle-provenance="Workflow Pack"]')?.textContent)
        .toContain('From bundle')

      expect(dom.window.document.querySelector('input[type="search"]')?.getAttribute('placeholder')).toBe(
        'Search installed plugins, bundles, or Marketplace…',
      )
      expect(dom.window.document.querySelector('[data-plugin-source-filter]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-type-filter]')).not.toBeNull()
      expect(unifiedPluginSections('marketplace', 'all')).toEqual({
        plugins: false,
        bundles: false,
        marketplace: true,
      })
      expect(unifiedPluginSections('all', 'bundle')).toEqual({
        plugins: false,
        bundles: true,
        marketplace: false,
      })

      const official = dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-official-filter]')!
      expect(official.textContent).toBe('Marketplace: Official only')
      await act(async () => official.click())
      expect(dom.window.document.querySelector('[data-plugin-id="notes"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-result-source="marketplace"]')).toBeNull()

      await act(async () =>
        root.render(
          <MarketplacePage
            marketplace={marketplace}
            manager={manager}
            snapshot={state}
            router={router}
            query="Workflow Pack"
            officialOnly={false}
            certifiedOnly={false}
          />,
        )
      )
      expect(dom.window.document.querySelector('[data-plugin-result-source="marketplace"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
