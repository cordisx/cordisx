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
import { Navigation } from '../packages/cli/src/renderer/manager/components/Navigation.js'
import { MarketplacePage } from '../packages/cli/src/renderer/manager/pages/MarketplacePage.js'
import { PluginsPage } from '../packages/cli/src/renderer/manager/pages/PluginsPage.js'
import type { MarketplaceModel, MarketplaceSnapshot } from '../packages/cli/src/renderer/marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { reactManagerFixture } from './helpers/react-manager.js'

vi.mock('tdesign-react', () => ({
  Button: ({ children, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly loading?: boolean
  }) => <button {...props}>{children}</button>,
  Input: ({ prefixIcon, clearable: _clearable, onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {
    readonly prefixIcon?: React.ReactNode
    readonly clearable?: boolean
    readonly onChange?: (value: string) => void
  }) => (
    <label>
      {prefixIcon}
      <input {...props} onChange={event => onChange?.(event.currentTarget.value)} />
    </label>
  ),
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

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span aria-hidden="true">CordisX</span>,
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

async function renderFixture() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://codex.local/',
    pretendToBeVisual: true,
  })
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
    scrollIntoView: { configurable: true, value() {} },
  })
  const router = {
    route: { kind: 'primary', page: 'plugins' } as const,
    navigate: vi.fn(),
    replace: vi.fn(),
    openDetail: vi.fn(),
    back: vi.fn(),
  }
  const root = createRoot(dom.window.document.getElementById('root')!)
  return {
    document: dom.window.document,
    router,
    manager: (state: ManagerSnapshot): ManagerModel => ({
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: () => () => {},
    }),
    marketplace: (state: MarketplaceSnapshot): MarketplaceModel => ({
      snapshot: () => state,
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
    }),
    render: async (element: React.ReactNode) =>
      act(async () => {
        root.render(element)
        await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      }),
    type: async (selector: string, value: string) =>
      act(async () => {
        const input = dom.window.document.querySelector<HTMLInputElement>(selector)!
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      }),
    dispose: async () => {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    },
  }
}

describe('unified Plugins information architecture', () => {
  it('keeps Plugins and Plugin Store as separate primary routes while redirecting only plugin bundles', () => {
    expect(normalizeManagerRoute({ kind: 'primary', page: 'plugin-bundles' })).toEqual({
      kind: 'primary',
      page: 'plugins',
    })
    expect(normalizeManagerRoute({ kind: 'primary', page: 'marketplace' })).toEqual({
      kind: 'primary',
      page: 'marketplace',
    })
    expect(normalizeManagerHistory([
      { kind: 'primary', page: 'plugins' },
      { kind: 'primary', page: 'marketplace' },
      { kind: 'primary', page: 'plugin-bundles' },
    ])).toEqual([
      { kind: 'primary', page: 'plugins' },
      { kind: 'primary', page: 'marketplace' },
      { kind: 'primary', page: 'plugins' },
    ])
    expect(primaryFor({ kind: 'plugin-bundle', bundleId: 'workflow', page: 'readme' })).toBe('plugins')
    expect(primaryFor({ kind: 'marketplace-sources' })).toBe('marketplace')
  })

  it('normalizes the legacy bundle route without collapsing the Plugin Store route', async () => {
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
      expect(router?.route).toEqual({ kind: 'primary', page: 'marketplace' })
      await act(async () => router?.replace({ kind: 'primary', page: 'plugin-bundles' }))
      expect(router?.route).toEqual({ kind: 'primary', page: 'plugins' })
      await act(async () => router?.restore([{ kind: 'primary', page: 'marketplace' }]))
      expect(router?.capture()).toEqual([{ kind: 'primary', page: 'marketplace' }])
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
    ).toMatchObject({ kind: 'plugin' })
    expect(bundle).toHaveBeenCalledTimes(1)
    expect(plugin).toHaveBeenCalledTimes(1)

    plugin.mockClear()
    bundle.mockResolvedValueOnce(bundleResult('operation-unavailable'))
    expect(
      await inspectUnifiedLocalPluginSource(
        { requestPluginBundleLifecycle: bundle, requestPluginLifecycle: plugin },
        '/tmp/plugin',
      ),
    ).toMatchObject({ kind: 'bundle', result: { error: { code: 'operation-unavailable' } } })
    expect(plugin).not.toHaveBeenCalled()
  })

  it('renders installed plugins with bundle provenance and one global empty state', async () => {
    const fixture = reactManagerFixture()
    const state = managerSnapshot()
    const manager: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: () => () => {},
    }
    const router = {
      route: { kind: 'primary', page: 'plugins' } as const,
      navigate: vi.fn(),
      replace: vi.fn(),
      openDetail: vi.fn(),
      back: vi.fn(),
    }
    try {
      await fixture.render(<PluginsPage model={manager} snapshot={state} router={router} />)
      const page = fixture.document.querySelector('[data-unified-plugins-page]')
      expect(page?.getAttribute('aria-label')).toBe('Installed plugins')
      expect(page?.querySelector('[data-plugin-id="notes"]')).not.toBeNull()
      expect(page?.querySelector('[data-plugin-bundle-provenance="Workflow Pack"]')?.textContent).toContain(
        'From bundle',
      )
      expect(page?.querySelector('[data-plugin-type-badge="plugin"]')).not.toBeNull()
      expect(page?.querySelector('[data-plugin-status-badge="active"]')).not.toBeNull()
      expect(page?.querySelector('[data-plugin-bundle-id]')).toBeNull()
      expect(page?.textContent).not.toContain('No matching plugin bundles')
      expect(page?.querySelector('[data-plugin-source-filter]')).toBeNull()
      expect(page?.querySelector('[data-plugin-type-filter]')).toBeNull()
      expect(page?.querySelector('[data-unified-local-install]')).toBeNull()
      expect(page?.querySelector('.cxr-plugins-toolbar .cxr-search')).not.toBeNull()
      expect(page?.querySelector('.cxr-plugins-results')).not.toBeNull()

      await fixture.type('input[type="search"]', 'nothing-matches')
      expect(page?.querySelectorAll('.cxr-empty')).toHaveLength(1)
      expect(page?.textContent).toContain('No matching plugins')
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps Plugin Store discovery independent and overlays exact installed identity', async () => {
    const fixture = await renderFixture()
    const state = managerSnapshot()
    const marketplace = fixture.marketplace(marketplaceSnapshot())
    try {
      await fixture.render(
        <MarketplacePage
          marketplace={marketplace}
          manager={fixture.manager(state)}
          snapshot={state}
          router={fixture.router}
        />,
      )
      expect(fixture.document.querySelector('[data-marketplace-discovery-page] input')).not.toBeNull()
      expect(fixture.document.querySelector('[data-marketplace-plugin="remote-notes"]')).not.toBeNull()
      expect(fixture.document.querySelector('[data-marketplace-installed="true"]')?.textContent).toBe('Installed')
      expect(fixture.document.querySelector('[data-unified-plugins-page]')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })

  it('renders exactly Plugins and Plugin Store as core resource destinations', async () => {
    const fixture = await renderFixture()
    const state = managerSnapshot()
    try {
      await fixture.render(<Navigation snapshot={state} router={fixture.router} />)
      const resources = fixture.document.querySelector('[data-navigation-group="resources"]')!
      expect([...resources.querySelectorAll('[data-tab]')].map(item => item.getAttribute('data-tab'))).toEqual([
        'plugins',
        'marketplace',
      ])
      expect(resources.querySelector('[data-tab="plugin-bundles"]')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
})
