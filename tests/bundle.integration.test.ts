import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { managerCopy } from '../packages/cli/src/renderer/ui-copy.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

type TestTDesignSelect = HTMLElement & {
  disabled: boolean
  options: readonly { readonly value: string; readonly label: string }[]
  setSelectedValue(value: string | undefined, notify?: boolean): void
}

interface RuntimeSnapshot {
  plugins: readonly {
    id: string
    source: string
    status: string
    readme?: string
    description?: string
    configuration: {
      schemaKind: string
      applies: string
      fields: readonly { path: readonly string[]; label?: string; description?: string; value?: unknown; min?: number; max?: number }[]
    }
  }[]
  registrations: readonly { owner: string; surface: string; valid: boolean; authorized: boolean; rendered: boolean; item: unknown }[]
  commands: readonly { owner: string; qualifiedId: string }[]
  navigation: {
    routes: readonly {
      owner: string
      qualifiedId: string
      valid: boolean
      authorized: boolean
      productMetadata: { title?: string; description?: string; diagnostics: readonly unknown[] }
    }[]
    pages: readonly {
      owner: string
      qualifiedId: string
      productMetadata: { title?: string; description?: string; diagnostics: readonly unknown[] }
    }[]
    outlets: readonly { id: string; available: boolean; error?: string; contextKey?: string; activeRoute?: string; mounted: boolean; presentation: 'inactive' | 'presented' | 'suspended'; suspendedBy?: string }[]
  }
  localization: { locale: string; direction: string; version: number }
  localeCatalogs: readonly { owner: string; namespace: string; locale: string }[]
  localizationDiagnostics: readonly unknown[]
  platform: { mode: string; secondConnectionCreated: boolean; rawBridgeExposed: boolean; diagnostics: readonly { code: string }[] }
  permissions: readonly { capability: string; policy: string; reasonText: string; required: boolean }[]
  extensionPoints: {
    points: readonly {
      id: string
      kind: string
      titleProjection: { text: string }
      usingPluginCount: number
      activePluginCount: number
    }[]
    policies: readonly { identity: { source: string; pluginId: string; pointId: string }; policy: string }[]
    descriptorDiagnostics: readonly unknown[]
    accessDiagnostics: readonly { request: { generation: string; operation: string; identity: { source: string; pluginId: string; pointId: string } }; authorized: boolean }[]
  }
}

interface RuntimeHandle {
  readonly version: string
  snapshot(): RuntimeSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  execute(owner: string, reference: { id: string }): Promise<unknown>
  navigate(owner: string, reference: { id: string; params?: Record<string, string> }): Promise<void>
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: 'inherit' | 'allow' | 'deny'): Promise<void>
  dispose(): Promise<void>
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('renderer bundle', () => {
  it('boots the structured demo, routes all outlets, reprojects locale, and disposes one generation', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const sessionId = '01a02d54-8adf-7043-944c-0bc9bb41bfd9'
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const config = {
      ...baseConfig,
      plugins: [
        ...baseConfig.plugins.map(plugin => ({ ...plugin, config: { sessionId } })),
        { id: 'configured-off', entry: path.join(projectRoot, 'missing-disabled-plugin.ts'), enabled: false, config: {} },
      ],
    }
    const plugin = config.plugins[0]!
    const bundle = await buildRendererBundle(config, {
      permission: {
        profileId: 'development',
        bridgeToken: '1'.repeat(64),
        policies: exactDomPermissionPolicies('development', [{
          id: plugin.id,
          entry: plugin.entry,
          pointIds: [
            'app', 'main', 'session.content', 'sidebar.footer.before-control',
            'sidebar.footer.after-control', 'sidebar.footer.menu', 'sidebar.account.menu',
            'sidebar.navigation.items', 'workspace.toolbar.items', 'session.header.actions',
            'composer.toolbar.items', 'environment.panel.header-actions',
            'environment.panel.sections', 'environment.section.actions',
            'environment.section.rows', 'environment.row.trailing-actions',
          ],
        }]),
      },
    })
    const dom = new JSDOM(`
      <html lang="en" dir="ltr" class="electron-dark"><head><style>
        .codex-toolbar-button { width: 28px; height: 28px; }
        .codex-footer-button, .codex-composer-button { width: 32px; height: 32px; }
      </style></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
        <header data-app-shell-application-menu-bar style="position:relative">
          <div data-test-id="header-shell-slot"><div><div><button>left native</button></div></div></div>
          <div data-test-id="header-shell-slot" style="width:0px;min-width:70px"><div><div id="native-toolbar-controls" style="display:flex">
            <span id="native-toolbar-tooltip-trigger" style="display:contents"><button id="native-toolbar-primary" class="codex-toolbar-button">native primary</button></span><button class="codex-toolbar-button">native secondary</button>
          </div></div></div>
        </header>
        <aside><div data-app-action-sidebar-scroll style="position:relative">
          <div id="native-navigation" style="display:flex;flex-direction:column">
            <button>New conversation</button><button>Pull requests</button>
          </div>
          <div data-app-action-sidebar-project-list-id="project-one">
            <button data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-id="local:${sessionId}"></button>
          </div>
        </div><div id="native-footer-controls" style="display:flex"><button id="native-account" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded="false">Profile</button><button id="native-help" class="codex-footer-button" aria-label="Help" aria-haspopup="menu" aria-expanded="false">Help</button></div></aside>
        <main data-app-shell-main-content-layout="thread-edge-scroll" style="position:relative">
          <header data-testid="app-shell-header-context-menu-surface" style="display:flex">
            <div id="native-session-title">Current session</div>
            <div id="native-session-actions" style="display:flex"><span id="native-session-tooltip-trigger" style="display:contents"><button id="native-session-menu" class="codex-toolbar-button" title="Toggle pinned summary">Session menu</button></span></div>
          </header>
          <section id="native-thread" data-codex-thread-reference-drop-target style="position:relative">
            <div id="native-session-content" data-pip-anchor-host="codex-main-thread" data-app-action-timeline-scroll style="position:relative">
              <div id="native-conversation" data-thread-find-target="conversation" data-response-annotation-conversation="${sessionId}">native data</div>
              <div data-codex-composer-root data-composer-placement="thread">
                <div data-above-composer-conversation-id="${sessionId}"></div>
                <div data-composer-footer-responsive style="display:flex">
                  <button id="native-composer-leading">Attach</button>
                  <div id="native-composer-actions" style="display:flex"><button id="native-submit" class="codex-composer-button">Send</button></div>
                </div>
              </div>
              <div id="unmatched-session-content" data-pip-anchor-host="codex-main-thread" data-app-action-timeline-scroll></div>
            </div>
          </section>
        </main>
        <aside id="native-summary-frame" style="position:relative">
          <div
            id="native-summary-obstacle"
            data-pip-home-surface="thread-summary-panel"
            data-pip-obstacle="thread-summary-panel"
            aria-hidden="true"
            style="position:absolute"
          ></div>
          <div id="native-summary-motion-shell">
            <div id="native-summary-column" style="display:flex;flex-direction:column;gap:12px;width:300px">
              <div id="native-summary-card" style="display:flex;flex-direction:column;overflow:hidden">
                <div id="native-summary-scrollport" style="display:flex;flex-direction:column;overflow-y:auto">
                  <div id="native-summary-section-stack" style="display:flex;flex-direction:column;gap:12px">
                    <section id="native-background-processes" role="presentation">
                      <header><button aria-expanded="true"><span>Background processes</span><span>1</span></button></header>
                      <div data-slot="thread-summary-panel-item">
                        <button data-slot="thread-summary-panel-item-trigger">sleep 999</button>
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    installPermissionPolicyBridge(dom.window)
    Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel', configurable: true })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
        schemaVersion: 2,
        fallbackLocale: 'en',
        name: 'CordisX Community Marketplace',
        localizations: { 'zh-CN': { name: 'CordisX 社区插件商店' } },
        homepage: 'https://cordisx.github.io/marketplace/',
        plugins: [{
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json',
          schemaVersion: 2,
          id: 'slot-showcase',
          fallbackLocale: 'en',
          name: 'Slot Showcase Catalog',
          description: 'Marketplace hierarchy fixture',
          localizations: {
            'zh-CN': {
              name: '点位展示目录', description: '插件商店层级夹具', authors: ['CordisX 团队'], keywords: ['结构化界面', '演示'],
            },
          },
          version: '0.1.0',
          source: 'https://github.com/cordisx/slot-showcase',
          homepage: 'https://github.com/cordisx/slot-showcase',
          license: 'MIT',
          compatibility: { cordisx: '^0.1.0' },
          authors: [{ name: 'CordisX' }],
          keywords: ['structured-ui', 'demo'],
        }],
      }) }),
    })
    const native = dom.window.document.getElementById('native-conversation')!
    const nativeParent = native.parentElement
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
      toJSON: () => ({}),
    }) as DOMRect
    const getBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      value(this: HTMLElement) {
        if (this.dataset.cordisxSurfaceHost === 'toolbar.before' || this.dataset.cordisxSurfaceHost === 'toolbar.after') {
          return rect(0, 0, 28, 28)
        }
        if (this.classList.contains('cordisx-env-section')) {
          return this.parentElement?.parentElement?.id === 'native-summary-section-stack'
            ? rect(960, 162, 300, 180)
            : rect(960, 140, 300, 180)
        }
        return getBoundingClientRect.call(this)
      },
    })
    Object.defineProperty(dom.window.document.querySelector('[data-app-shell-application-menu-bar]'), 'getBoundingClientRect', { value: () => rect(0, 0, 1200, 46) })
    Object.defineProperty(dom.window.document.querySelector('[data-testid="app-shell-header-context-menu-surface"]'), 'getBoundingClientRect', { value: () => rect(240, 0, 960, 46) })
    Object.defineProperty(dom.window.document.querySelector('[data-codex-composer-root]'), 'getBoundingClientRect', { value: () => rect(420, 700, 600, 120) })
    Object.defineProperty(dom.window.document.querySelector('[data-composer-footer-responsive]'), 'getBoundingClientRect', { value: () => rect(440, 760, 560, 40) })
    Object.defineProperty(dom.window.document.getElementById('native-summary-obstacle'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(dom.window.document.getElementById('native-summary-motion-shell'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(dom.window.document.getElementById('native-summary-column'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(dom.window.document.getElementById('native-summary-card'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(dom.window.document.getElementById('native-summary-scrollport'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(dom.window.document.getElementById('native-summary-section-stack'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    let nativeBackgroundProcessesRect = rect(960, 56, 300, 94)
    Object.defineProperty(dom.window.document.getElementById('native-background-processes'), 'getBoundingClientRect', { value: () => nativeBackgroundProcessesRect })
    Object.defineProperty(dom.window.document.body, 'getBoundingClientRect', { value: () => rect(0, 0, 1200, 900) })
    let mainRect = rect(240, 0, 960, 900)
    Object.defineProperty(dom.window.document.querySelector('[data-app-shell-main-content-layout]'), 'getBoundingClientRect', { value: () => mainRect })
    dom.window.history.replaceState({ usr: null, key: 'native-test', idx: 0 }, '')
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 30 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
    expect(runtime?.version).toBe('0.1.0-beta.2')
    const snapshot = runtime!.snapshot()
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({
        id: 'slot-showcase',
        status: 'active',
        readme: expect.stringContaining('# Slot Showcase'),
        description: 'Demonstrates CordisX extension points, navigation, pages, and state interactions.',
        configuration: expect.objectContaining({
          schemaKind: 'schemastery',
          applies: 'plugin-restart',
          fields: [expect.objectContaining({
            path: ['sessionId'], label: 'Native session ID', value: sessionId, max: 128,
          })],
        }),
      }),
      expect.objectContaining({ id: 'configured-off', status: 'configured-disabled' }),
    ])
    expect(snapshot.registrations).toHaveLength(15)
    expect(new Set(snapshot.registrations.map(item => item.surface))).toEqual(new Set([
      'sidebar.footer.before-control', 'sidebar.footer.after-control', 'sidebar.footer.menu', 'sidebar.account.menu', 'sidebar.navigation.items',
      'workspace.toolbar.items', 'session.header.actions', 'composer.toolbar.items', 'environment.panel.header-actions', 'environment.panel.sections',
      'environment.section.actions', 'environment.section.rows', 'environment.row.trailing-actions',
    ]))
    expect(snapshot.registrations.every(item => item.valid && item.rendered)).toBe(true)
    expect(snapshot.commands).toHaveLength(6)
    expect(snapshot.commands).toContainEqual(expect.objectContaining({
      owner: 'slot-showcase', qualifiedId: 'slot-showcase:open-session',
    }))
    expect(snapshot.navigation.routes).toHaveLength(3)
    expect(snapshot.navigation.routes.every(item => item.valid)).toBe(true)
    expect(snapshot.navigation.pages).toHaveLength(3)
    expect(snapshot.navigation.routes.find(item => item.qualifiedId === 'slot-showcase:main.analytics')?.productMetadata).toEqual({
      title: 'Workspace analytics',
      description: 'Open workspace analytics from showcase navigation or the workspace toolbar.',
      diagnostics: [],
    })
    expect(snapshot.navigation.routes.find(item => item.qualifiedId === 'slot-showcase:session.analytics')?.productMetadata).toEqual({
      title: 'Session analytics',
      description: 'Toggle analytics for the current session from its header, or open the configured session from showcase navigation.',
      diagnostics: [],
    })
    expect(snapshot.navigation.pages.find(item => item.qualifiedId === 'slot-showcase:session.analytics')?.productMetadata).toEqual({
      title: 'Session analytics',
      description: 'Presents analytics for the currently selected native session below its persistent session header.',
      diagnostics: [],
    })
    expect(snapshot.navigation.outlets).toHaveLength(5)
    expect(snapshot.extensionPoints.points).toHaveLength(39)
    expect(snapshot.extensionPoints.points.filter(item => item.kind === 'surface')).toHaveLength(32)
    expect(snapshot.extensionPoints.points.filter(item => item.kind === 'outlet')).toHaveLength(7)
    expect(snapshot.extensionPoints.descriptorDiagnostics).toEqual([])
    expect(snapshot.localeCatalogs).toHaveLength(8)
    expect(snapshot.localeCatalogs.filter(item => item.owner === 'host')).toHaveLength(6)
    expect(snapshot.localeCatalogs.filter(item => item.owner === 'host')).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'host:cordisx.manager.capability-availability', locale: 'en' }),
      expect.objectContaining({ namespace: 'host:cordisx.manager.capability-availability', locale: 'zh-CN' }),
      expect.objectContaining({ namespace: 'host:permission', locale: 'en' }),
      expect.objectContaining({ namespace: 'host:permission', locale: 'zh-CN' }),
    ]))
    expect(snapshot.localizationDiagnostics).toEqual([])
    const surfaceHosts = [...dom.window.document.querySelectorAll<HTMLElement>('[data-cordisx-surface-host]')]
    expect(new Set(surfaceHosts.map(host => host.dataset.cordisxSurfaceHost))).toEqual(new Set([
      'sidebar.navigation', 'sidebar.footer.before', 'sidebar.footer.after',
      'toolbar.before', 'toolbar.after', 'session.header.actions', 'composer.submit.before', 'environment',
    ]))
    expect(surfaceHosts.every(host => host.parentElement !== dom.window.document.body)).toBe(true)
    expect(dom.window.document.querySelector('.cordisx-structured')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="sidebar.navigation"]')?.parentElement?.id).toBe('native-navigation')
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="sidebar.footer.before"]')?.nextElementSibling?.id).toBe('native-help')
    expect(dom.window.document.getElementById('native-help')?.nextElementSibling?.getAttribute('data-cordisx-surface-host')).toBe('sidebar.footer.after')
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="toolbar.before"]')?.nextElementSibling?.id).toBe('native-toolbar-tooltip-trigger')
    expect(dom.window.document.getElementById('native-toolbar-tooltip-trigger')?.nextElementSibling?.getAttribute('data-cordisx-surface-host')).toBe('toolbar.after')
    expect(dom.window.document.getElementById('native-toolbar-tooltip-trigger')?.querySelector('[data-cordisx-surface-host]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')?.nextElementSibling?.id).toBe('native-session-tooltip-trigger')
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')?.parentElement?.id).toBe('native-session-actions')
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')?.nextElementSibling?.id).toBe('native-submit')
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')?.parentElement?.id).toBe('native-composer-actions')
    const environmentSeat = dom.window.document.querySelector<HTMLElement>('[data-cordisx-surface-host="environment"]')!
    const environmentSection = environmentSeat.querySelector<HTMLElement>('.cordisx-env-section')!
    const environmentHeader = environmentSection.querySelector<HTMLElement>(':scope > .cordisx-env-header')!
    const environmentContent = environmentSection.querySelector<HTMLElement>(':scope > .cordisx-env-content')!
    const environmentRow = environmentContent.querySelector<HTMLElement>('.cordisx-env-row')!
    expect(environmentSeat.children).toHaveLength(1)
    expect(environmentSection.getAttribute('role')).toBe('presentation')
    expect(environmentHeader.querySelector('.cordisx-env-title')?.textContent).toBe('CordisX runtime')
    expect([...environmentHeader.querySelectorAll<HTMLButtonElement>('button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['Refresh snapshot', 'Showcase settings'])
    expect(environmentContent.querySelector(':scope > .cordisx-shortcut-action')).toBeNull()
    expect(environmentContent.querySelector('.cordisx-env-description')?.textContent).toBe('Current runtime status.')
    const environmentLeading = environmentRow.querySelector<HTMLElement>('.cordisx-env-row-leading')!
    const environmentLabel = environmentRow.querySelector<HTMLElement>('.cordisx-env-row-label')!
    const environmentValue = environmentRow.querySelector<HTMLElement>('.cordisx-env-row-value')!
    const environmentRowAction = environmentRow.querySelector<HTMLButtonElement>('.cordisx-env-row-actions .cordisx-shortcut-action')!
    const environmentHeaderAction = environmentHeader.querySelector<HTMLButtonElement>('.cordisx-env-header-actions .cordisx-shortcut-action')!
    expect(environmentRow.firstElementChild).toBe(environmentLeading)
    expect(environmentLeading.querySelector('.cordisx-host-icon')).not.toBeNull()
    expect(environmentLabel.querySelector('.cordisx-host-icon')).toBeNull()
    expect(environmentRow.querySelector('.cordisx-env-row-copy')?.textContent).toBe('Snapshot revision')
    expect(environmentValue.tagName).toBe('SPAN')
    expect(environmentValue.textContent).toBe('1')
    expect(dom.window.getComputedStyle(environmentSeat).display).toBe('contents')
    expect(dom.window.getComputedStyle(environmentSection).display).toBe('flex')
    expect(dom.window.getComputedStyle(environmentSection).paddingBottom).toBe('0px')
    expect(dom.window.getComputedStyle(environmentHeader).height).toBe('28px')
    expect(dom.window.getComputedStyle(environmentHeader).justifyContent).toBe('flex-start')
    expect(dom.window.getComputedStyle(environmentContent).paddingLeft).toBe('14px')
    expect(dom.window.getComputedStyle(environmentRow).paddingTop).toBe('4px')
    expect(dom.window.getComputedStyle(environmentRow).gap).toBe('4px')
    expect(dom.window.getComputedStyle(environmentLeading).width).toBe('18px')
    expect(dom.window.getComputedStyle(environmentLeading).marginInlineEnd).toBe('8px')
    expect(dom.window.getComputedStyle(environmentLeading.querySelector('svg')!).width).toBe('18px')
    expect(dom.window.getComputedStyle(environmentValue).maxWidth).toBe('50%')
    expect(dom.window.getComputedStyle(environmentRowAction).width).toBe('24px')
    expect(dom.window.getComputedStyle(environmentRowAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
    expect(dom.window.getComputedStyle(environmentHeaderAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('18px')
    const nativeBackgroundProcesses = dom.window.document.getElementById('native-background-processes')!
    expect(environmentSeat.parentElement?.id).toBe('native-summary-section-stack')
    expect(nativeBackgroundProcesses.nextElementSibling).toBe(environmentSeat)
    expect(dom.window.document.getElementById('native-summary-obstacle')?.childElementCount).toBe(0)
    expect(environmentSection.getBoundingClientRect().top - nativeBackgroundProcesses.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(12)
    nativeBackgroundProcessesRect = rect(960, -200, 300, 94)
    nativeBackgroundProcesses.dataset.state = 'scrolled-out-of-view'
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="environment"]')).toBe(environmentSeat)
    nativeBackgroundProcessesRect = rect(960, 56, 300, 94)

    const environmentMarker = dom.window.document.getElementById('native-summary-obstacle')!
    environmentMarker.removeAttribute('data-pip-home-surface')
    environmentMarker.removeAttribute('data-pip-obstacle')
    await settle()
    await settle()
    expect(environmentSeat.isConnected).toBe(false)
    environmentMarker.dataset.pipHomeSurface = 'thread-summary-panel'
    environmentMarker.dataset.pipObstacle = 'thread-summary-panel'
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="environment"]')).toBe(environmentSeat)

    const ambiguousMotionShell = dom.window.document.createElement('div')
    ambiguousMotionShell.id = 'ambiguous-summary-motion-shell'
    Object.defineProperty(ambiguousMotionShell, 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    dom.window.document.getElementById('native-summary-frame')?.append(ambiguousMotionShell)
    await settle()
    await settle()
    expect(environmentSeat.isConnected).toBe(false)
    expect(runtime!.snapshot().registrations
      .filter(item => item.surface.startsWith('environment.'))
      .every(item => !item.rendered)).toBe(true)
    ambiguousMotionShell.remove()
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="environment"]')).toBe(environmentSeat)

    const transitioningMotionShell = dom.window.document.createElement('div')
    transitioningMotionShell.id = 'transitioning-summary-motion-shell'
    Object.defineProperty(transitioningMotionShell, 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    dom.window.document.getElementById('native-summary-frame')?.append(transitioningMotionShell)
    await settle()
    await settle()
    expect(environmentSeat.isConnected).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(environmentSeat.isConnected).toBe(false)
    transitioningMotionShell.style.display = 'none'
    for (let attempt = 0; attempt < 20 && !environmentSeat.isConnected; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="environment"]')).toBe(environmentSeat)
    transitioningMotionShell.remove()

    const replacementMotionShell = dom.window.document.createElement('div')
    replacementMotionShell.id = 'native-summary-motion-shell-rerendered'
    replacementMotionShell.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;width:300px">
        <div style="display:flex;flex-direction:column;overflow:hidden">
          <div style="display:flex;flex-direction:column;overflow-y:auto">
            <div id="native-summary-section-stack-rerendered" style="display:flex;flex-direction:column;gap:12px">
              <section id="native-background-processes-rerendered" role="presentation">
                <header><button aria-expanded="true"><span>后台进程</span><span>1</span></button></header>
                <div data-slot="thread-summary-panel-item"><button data-slot="thread-summary-panel-item-trigger">sleep 999</button></div>
              </section>
            </div>
          </div>
        </div>
      </div>
    `
    Object.defineProperty(replacementMotionShell, 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(replacementMotionShell.querySelector('#native-summary-section-stack-rerendered'), 'getBoundingClientRect', { value: () => rect(960, 46, 300, 654) })
    Object.defineProperty(replacementMotionShell.querySelector('#native-background-processes-rerendered'), 'getBoundingClientRect', { value: () => rect(960, 56, 300, 94) })
    dom.window.document.getElementById('native-summary-motion-shell')?.replaceWith(replacementMotionShell)
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="environment"]')).toBe(environmentSeat)
    expect(environmentSeat.parentElement?.id).toBe('native-summary-section-stack-rerendered')
    expect(dom.window.document.getElementById('native-background-processes-rerendered')?.nextElementSibling).toBe(environmentSeat)
    expect(runtime!.snapshot().registrations
      .filter(item => item.surface.startsWith('environment.'))
      .every(item => item.rendered)).toBe(true)
    expect(dom.window.document.getElementById('native-session-tooltip-trigger')?.querySelector('[data-cordisx-surface-host]')).toBeNull()
    expect(dom.window.document.getElementById('native-session-menu')?.parentElement?.id).toBe('native-session-tooltip-trigger')
    expect(dom.window.document.getElementById('native-submit')?.parentElement?.id).toBe('native-composer-actions')
    expect(surfaceHosts.every(host => host.dataset.cordisxNoDrag === 'true')).toBe(true)
    expect([...dom.window.document.querySelectorAll<HTMLElement>('.cordisx-action')]
      .every(button => button.dataset.cordisxNoDrag === 'true')).toBe(true)
    const structuredStyles = dom.window.document.getElementById('cordisx-structured-styles')?.textContent ?? ''
    expect(structuredStyles).toContain('[data-cordisx-no-drag="true"], [data-cordisx-no-drag="true"] *')
    expect(structuredStyles).toContain('.cordisx-icon-only-control { --cordisx-icon-only-glyph-size: 16px; }')
    expect(structuredStyles).toContain('.cordisx-icon-only-control.cordisx-shortcut-action { --cordisx-icon-only-glyph-size: 12px; }')
    expect(dom.window.document.querySelector('details[data-cordisx-no-drag]')).toBeNull()
    expect(dom.window.document.body.textContent).not.toContain('CX')
    const toolbarAction = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-surface-host="toolbar.before"] button')!
    expect(toolbarAction.className).not.toContain('codex-toolbar-button')
    expect(toolbarAction.className).toContain('cordisx-toolbar-action')
    expect(toolbarAction.className).toContain('cordisx-icon-only-control')
    expect(toolbarAction.dataset.cordisxIconControlVariant).toBe('toolbar')
    const toolbarSeat = toolbarAction.closest<HTMLElement>('[data-cordisx-surface-host="toolbar.before"]')!
    expect(dom.window.getComputedStyle(toolbarSeat).getPropertyValue('--cordisx-toolbar-action-target-size')).toBe('28px')
    expect(dom.window.getComputedStyle(toolbarSeat).getPropertyValue('--cordisx-toolbar-action-corner-radius')).toBe('8px')
    expect(dom.window.getComputedStyle(toolbarAction).width).toBe('var(--cordisx-toolbar-action-target-size)')
    expect(dom.window.getComputedStyle(toolbarAction).height).toBe('var(--cordisx-toolbar-action-target-size)')
    expect(dom.window.getComputedStyle(toolbarSeat).getPropertyValue('--cordisx-toolbar-action-target-size')).toBe(dom.window.getComputedStyle(dom.window.document.getElementById('native-toolbar-primary')!).width)
    expect(dom.window.getComputedStyle(toolbarAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
    const toolbarIcon = toolbarAction.querySelector<HTMLElement>('.cordisx-host-icon')!
    const toolbarGlyph = toolbarIcon.querySelector<SVGElement>('svg')!
    const toolbarIconStyle = dom.window.getComputedStyle(toolbarIcon)
    expect(toolbarIconStyle.display).toBe('inline-flex')
    expect(toolbarIconStyle.alignItems).toBe('center')
    expect(toolbarIconStyle.justifyContent).toBe('center')
    expect(toolbarIconStyle.width).toBe('20px')
    expect(toolbarIconStyle.height).toBe('20px')
    expect(dom.window.getComputedStyle(toolbarGlyph).width).toBe('var(--cordisx-icon-only-glyph-size)')
    expect(dom.window.getComputedStyle(toolbarGlyph).height).toBe('var(--cordisx-icon-only-glyph-size)')
    expect(toolbarAction.textContent).toBe('')
    expect(toolbarAction.getAttribute('aria-label')).toBe('Open main page')
    expect(toolbarAction.dataset.cordisxTooltip).toBe('Open main page')
    expect(toolbarAction.querySelector('[data-host-icon="host:open"] svg')).not.toBeNull()
    expect(toolbarAction.closest<HTMLElement>('[data-test-id="header-shell-slot"]')?.style.width).toBe('126px')
    const sessionHeaderAction = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-surface-host="session.header.actions"] button')!
    expect(sessionHeaderAction.className).not.toContain('codex-toolbar-button')
    expect(sessionHeaderAction.className).toContain('cordisx-toolbar-action')
    expect(dom.window.getComputedStyle(sessionHeaderAction).width).toBe('var(--cordisx-toolbar-action-target-size)')
    expect(dom.window.getComputedStyle(sessionHeaderAction).height).toBe('var(--cordisx-toolbar-action-target-size)')
    expect(dom.window.getComputedStyle(sessionHeaderAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
    expect(sessionHeaderAction.getAttribute('aria-label')).toBe('Toggle session analytics')
    expect(sessionHeaderAction.dataset.cordisxTooltip).toBe('Toggle session analytics')
    expect(sessionHeaderAction.querySelector('[data-host-icon="host:analytics"] svg')).not.toBeNull()
    expect(sessionHeaderAction.getAttribute('aria-pressed')).toBe('false')
    expect(sessionHeaderAction.dataset.cordisxRouteState).toBe('inactive')
    expect(sessionHeaderAction.draggable).toBe(false)
    sessionHeaderAction.click()
    for (let attempt = 0; attempt < 20 && runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')?.presentation !== 'presented'; attempt += 1) await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      activeRoute: 'slot-showcase:session.analytics',
      contextKey: `session:${sessionId}`,
      mounted: true,
      presentation: 'presented',
    })
    const presentedSessionHeaderAction = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-surface-host="session.header.actions"] button')!
    expect(presentedSessionHeaderAction.getAttribute('aria-pressed')).toBe('true')
    expect(presentedSessionHeaderAction.dataset.cordisxRouteState).toBe('presented')
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-cordisx-demo-marker="session.content"]') === null; attempt += 1) await settle()
    expect(dom.window.document.querySelector('[data-cordisx-demo-marker="session.content"]')?.textContent)
      .toContain(`Session content page for native session ${sessionId}.`)
    presentedSessionHeaderAction.click()
    for (let attempt = 0; attempt < 20 && runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')?.presentation !== 'inactive'; attempt += 1) await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({ mounted: false, presentation: 'inactive' })
    const restoredSessionHeaderAction = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-surface-host="session.header.actions"] button')!
    expect(restoredSessionHeaderAction.getAttribute('aria-pressed')).toBe('false')
    expect(restoredSessionHeaderAction.dataset.cordisxRouteState).toBe('inactive')
    const composerAction = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-surface-host="composer.submit.before"] button')!
    expect(composerAction.className).toContain('cordisx-composer-action')
    expect(composerAction.className).not.toContain('codex-composer-button')
    expect(composerAction.dataset.cordisxIconControlVariant).toBe('composer')
    expect(composerAction.classList.contains('cordisx-icon-only-control')).toBe(false)
    expect(dom.window.getComputedStyle(composerAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('')
    expect(dom.window.getComputedStyle(composerAction.querySelector('.cordisx-host-icon')!).width).toBe('16px')
    expect(dom.window.getComputedStyle(composerAction.querySelector('svg')!).width).toBe('16px')
    expect(composerAction.getAttribute('aria-label')).toBe('Refresh snapshot')
    expect(composerAction.dataset.cordisxTooltip).toBe('Refresh snapshot')
    expect(composerAction.textContent).toBe('')
    expect(composerAction.querySelector('[data-host-icon="host:refresh"] svg')).not.toBeNull()
    const composerStyle = dom.window.getComputedStyle(composerAction)
    expect(composerStyle.width).toBe('28px')
    expect(composerStyle.minWidth).toBe('28px')
    expect(composerStyle.height).toBe('28px')
    expect(composerStyle.padding).toBe('0px')
    expect(composerStyle.borderRadius).toBe('9999px')
    expect(composerStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(composerAction.querySelector<HTMLElement>('.cordisx-host-icon')?.getBoundingClientRect).toBeTypeOf('function')
    expect(structuredStyles).toContain('.cordisx-composer-action:hover:not(:disabled)')
    expect(structuredStyles).toContain('.cordisx-composer-action:focus-visible')
    expect(structuredStyles).toContain('.cordisx-composer-action:disabled')
    expect(structuredStyles).toContain('.cordisx-composer-submit-before > .cordisx-surface-overflow > summary')
    composerAction.disabled = true
    expect(dom.window.getComputedStyle(composerAction).opacity).toBe('0.4')
    composerAction.disabled = false
    const composerSeat = composerAction.closest<HTMLElement>('[data-cordisx-surface-host="composer.submit.before"]')!
    const replacementSubmit = dom.window.document.createElement('button')
    replacementSubmit.id = 'native-stop'
    replacementSubmit.className = 'codex-composer-stop bg-primary-solid'
    replacementSubmit.textContent = 'Stop'
    dom.window.document.getElementById('native-submit')?.replaceWith(replacementSubmit)
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')).toBe(composerSeat)
    expect(composerSeat.nextElementSibling?.id).toBe('native-stop')
    expect(replacementSubmit.parentElement?.id).toBe('native-composer-actions')
    expect(composerSeat.querySelector('button')?.className).toContain('cordisx-composer-action')
    expect(composerSeat.querySelector('button')?.className).not.toContain('bg-primary-solid')
    const replacementCluster = dom.window.document.createElement('div')
    replacementCluster.id = 'native-composer-actions-rerendered'
    replacementCluster.style.display = 'flex'
    replacementCluster.innerHTML = '<button id="native-submit-rerendered" class="codex-composer-button bg-primary-solid">Send</button>'
    dom.window.document.getElementById('native-composer-actions')?.replaceWith(replacementCluster)
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')).toBe(composerSeat)
    expect(composerSeat.parentElement).toBe(replacementCluster)
    expect(composerSeat.nextElementSibling?.id).toBe('native-submit-rerendered')
    expect(composerSeat.querySelector('button')?.className).toContain('cordisx-composer-action')
    expect(composerSeat.querySelector('button')?.className).not.toContain('bg-primary-solid')
    const sameToolbarAction = toolbarAction
    const nativeTooltip = dom.window.document.createElement('div')
    nativeTooltip.setAttribute('role', 'tooltip')
    dom.window.document.body.append(nativeTooltip)
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="toolbar.before"] button')).toBe(sameToolbarAction)
    nativeTooltip.remove()

    const help = dom.window.document.getElementById('native-help')!
    const footerAction = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-surface-host="sidebar.footer.before"] button')!
    expect(footerAction.className).toContain('codex-footer-button')
    expect(dom.window.getComputedStyle(footerAction).width).toBe(dom.window.getComputedStyle(help).width)
    expect(dom.window.getComputedStyle(footerAction).height).toBe(dom.window.getComputedStyle(help).height)
    expect(dom.window.getComputedStyle(footerAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
    help.setAttribute('aria-expanded', 'true')
    const helpMenu = dom.window.document.createElement('div')
    helpMenu.setAttribute('role', 'menu')
    helpMenu.setAttribute('aria-labelledby', 'native-help')
    helpMenu.innerHTML = '<div role="menuitem" class="codex-menu-item">Native feature</div><div role="separator"></div><div role="menuitem" class="codex-menu-item">Native help</div>'
    dom.window.document.body.append(helpMenu)
    await settle()
    await settle()
    const helpInsertion = helpMenu.querySelector<HTMLElement>('[data-cordisx-surface-host="sidebar.footer.menu"]')!
    expect(helpInsertion).not.toBeNull()
    expect(helpInsertion.previousElementSibling?.getAttribute('role')).toBe('separator')
    expect(helpInsertion.querySelector('[role="menuitem"]')?.className).toContain('codex-menu-item')
    expect(helpInsertion.querySelector('.cordisx-icon-only-control')).toBeNull()
    expect(dom.window.getComputedStyle(helpInsertion.querySelector('.cordisx-host-icon')!).width).toBe('20px')
    expect(helpInsertion.textContent).toBe('Refresh snapshot')

    help.setAttribute('aria-expanded', 'false')
    helpMenu.remove()
    const account = dom.window.document.getElementById('native-account')!
    account.setAttribute('aria-expanded', 'true')
    const accountMenu = dom.window.document.createElement('div')
    accountMenu.setAttribute('role', 'menu')
    accountMenu.setAttribute('aria-labelledby', 'native-account')
    accountMenu.innerHTML = '<div>Account header</div><div role="separator"></div><div role="menuitem" class="codex-menu-item">Native settings</div>'
    dom.window.document.body.append(accountMenu)
    await settle()
    await settle()
    expect(accountMenu.querySelector('[data-cordisx-surface-host="sidebar.account.menu"]')?.textContent).toBe('Showcase settings')

    const navigationSeat = dom.window.document.querySelector<HTMLElement>('[data-cordisx-surface-host="sidebar.navigation"]')!
    const replacementNavigation = dom.window.document.createElement('div')
    replacementNavigation.id = 'native-navigation'
    replacementNavigation.style.cssText = 'display:flex;flex-direction:column'
    replacementNavigation.innerHTML = '<button>New conversation</button><button>Pull requests</button>'
    dom.window.document.getElementById('native-navigation')?.replaceWith(replacementNavigation)
    await settle()
    await settle()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="sidebar.navigation"]')).toBe(navigationSeat)
    expect(navigationSeat.parentElement).toBe(replacementNavigation)

    const trailing = dom.window.document.querySelector<HTMLButtonElement>('.cordisx-nav-actions button')!
    expect(trailing.className).toContain('cordisx-icon-only-control')
    expect(dom.window.getComputedStyle(trailing).width).toBe('24px')
    expect(dom.window.getComputedStyle(trailing).height).toBe('24px')
    expect(dom.window.getComputedStyle(trailing).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('12px')
    expect(dom.window.getComputedStyle(trailing.querySelector('.cordisx-host-icon')!).width).toBe('16px')
    const environmentAction = dom.window.document.querySelector<HTMLButtonElement>('.cordisx-env-header button')!
    expect(environmentAction.className).toContain('cordisx-icon-only-control')
    expect(dom.window.getComputedStyle(environmentAction).width).toBe('24px')
    expect(dom.window.getComputedStyle(environmentAction).height).toBe('24px')
    expect(dom.window.getComputedStyle(environmentAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('18px')
    trailing.click()
    await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.activeRoute).toBeUndefined()
    dom.window.document.querySelector<HTMLButtonElement>('.cordisx-nav-primary')!.click()
    await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ activeRoute: 'slot-showcase:main.analytics', mounted: true, presentation: 'presented' })
    const mainPage = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="slot-showcase:main.analytics"]')!
    expect(mainPage).not.toBeNull()
    expect(dom.window.document.querySelector('.cordisx-nav-primary')?.getAttribute('aria-current')).toBe('page')
    expect(dom.window.document.querySelector('[data-cordisx-page-outlet="main"]')?.parentElement).toBe(dom.window.document.body)
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.placement).toBe('portal')
    expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.top).toBe('0px')
    expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.getPropertyValue('--cordisx-page-chrome-safe-left')).toBe('0px')
    expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="slot-showcase:main.analytics"]')?.dataset.cordisxNoDrag).toBe('true')
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-cordisx-demo-marker="main"]') === null; attempt += 1) await settle()
    const mainDemo = dom.window.document.querySelector<HTMLElement>('[data-cordisx-demo-marker="main"]')!
    expect(mainDemo.classList.contains('cxr-ui-card')).toBe(true)
    expect(mainDemo.getAttribute('style') ?? '').not.toMatch(/#8b5cf6|#c4b5fd|linear-gradient/)
    const mainChrome = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="slot-showcase:main.analytics"] [data-cordisx-page-chrome]')!
    expect(mainChrome.querySelector('[data-cordisx-page-leading] [data-host-icon="host:analytics"]')).toBeNull()
    expect(mainChrome.querySelector('button[aria-label="Back"]')).not.toBeNull()
    const mainHeaderAction = mainChrome.querySelector<HTMLButtonElement>('[data-cordisx-page-header-action="refresh"]')!
    expect(mainHeaderAction.textContent).toBe('')
    expect(mainHeaderAction.getAttribute('aria-label')).toBe('Refresh snapshot')
    expect(mainHeaderAction.querySelector('[data-host-icon="host:refresh"]')).not.toBeNull()
    expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-cordisx-page-chrome] button')]
      .every(button => button.dataset.cordisxNoDrag === 'true')).toBe(true)

    mainRect = rect(0, 0, 1200, 900)
    dom.window.document.querySelector('[data-app-shell-main-content-layout]')?.setAttribute('data-sidebar-collapsed', 'true')
    await settle()
    await settle()
    expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.left).toBe('0px')
    expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.getPropertyValue('--cordisx-page-chrome-safe-left')).toBe('88px')
    expect(mainChrome.style.paddingLeft).toContain('--cordisx-page-chrome-safe-left')

    await runtime!.navigate('slot-showcase', { id: 'app.overview' })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({ activeRoute: 'slot-showcase:app.overview', mounted: true, presentation: 'presented' })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ mounted: false, presentation: 'inactive' })
    expect(mainPage.isConnected).toBe(false)
    expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.hidden).toBe(true)
    expect(dom.window.document.querySelector('.cordisx-nav-primary')?.hasAttribute('aria-current')).toBe(false)
    const appOutlet = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="app"]')!
    expect(appOutlet.style.top).toBe('0px')
    expect(appOutlet.style.getPropertyValue('--cordisx-page-chrome-safe-left')).toBe('88px')
    const appChrome = appOutlet.querySelector<HTMLElement>('[data-cordisx-page-chrome]')!
    expect(appChrome.dataset.cordisxDrag).toBe('true')
    expect(appChrome.style.paddingLeft).toContain('--cordisx-page-chrome-safe-left')
    expect(appChrome.querySelector('[data-cordisx-page-leading] [data-host-icon="host:layers"]')).toBeNull()
    expect(appChrome.querySelector('button[aria-label="Back"]')).not.toBeNull()
    expect(appChrome.querySelectorAll('[data-cordisx-page-header-action="refresh"]')).toHaveLength(1)
    expect(appOutlet.querySelectorAll('[role="tab"] [data-host-icon]')).toHaveLength(2)
    expect(appOutlet.querySelector('[data-cordisx-page-body]')?.closest('header')).toBeNull()
    appChrome.querySelector<HTMLButtonElement>('[data-cordisx-page-header-action="refresh"]')!.click()
    await settle()
    expect(runtime!.snapshot().extensionPoints.accessDiagnostics.at(-1)).toMatchObject({
      request: {
        generation: expect.not.stringMatching(/^generation-legacy$/),
        operation: 'outlet.page.command.invoke',
        routeId: 'slot-showcase:app.overview',
        pageId: 'slot-showcase:app.overview',
        actionId: 'refresh',
        commandId: 'slot-showcase:refresh',
      },
      authorized: true,
    })
    const ambiguousSessionSeat = dom.window.document.createElement('section')
    ambiguousSessionSeat.dataset.pipAnchorHost = 'codex-main-thread'
    ambiguousSessionSeat.dataset.appActionTimelineScroll = ''
    ambiguousSessionSeat.innerHTML = `<div data-response-annotation-conversation="${sessionId}"></div><div data-above-composer-conversation-id="${sessionId}"></div>`
    dom.window.document.querySelector('[data-app-shell-main-content-layout]')?.append(ambiguousSessionSeat)
    await settle()
    await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      available: false,
      error: 'semantic anchor is unavailable',
    })
    ambiguousSessionSeat.remove()
    await settle()
    await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      available: true,
      contextKey: `session:${sessionId}`,
    })
    await runtime!.execute('slot-showcase', { id: 'open-session' })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({ activeRoute: 'slot-showcase:session.analytics', mounted: true, contextKey: `session:${sessionId}`, presentation: 'presented' })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({ mounted: false, presentation: 'inactive' })
    expect(dom.window.document.getElementById('native-thread')?.hasAttribute('data-codex-thread-reference-drop-target')).toBe(true)
    expect(dom.window.document.querySelector('[data-cordisx-page-outlet="session.content"]')?.parentElement?.id).toBe('native-session-content')
    await expect(runtime!.navigate('slot-showcase', { id: 'session.analytics', params: { sessionId: 'stale' } })).rejects.toThrow(/does not match native session/)
    expect(dom.window.location.href).toBe('https://codex.local/native')

    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-page="slot-showcase:session.analytics"] button[aria-label="Close"]')!.click()
    for (let attempt = 0; attempt < 20 && runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')?.presentation !== 'presented'; attempt += 1) await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({ presentation: 'presented' })
    expect(appOutlet.hidden).toBe(false)
    const restoredAppChrome = appOutlet.querySelector<HTMLElement>('[data-cordisx-page-chrome]')!
    expect(restoredAppChrome).not.toBe(appChrome)
    restoredAppChrome.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    for (let attempt = 0; attempt < 20 && runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.presentation !== 'presented'; attempt += 1) await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ presentation: 'presented' })
    const restoredMainPage = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="slot-showcase:main.analytics"]')!
    expect(restoredMainPage).not.toBe(mainPage)
    expect(restoredMainPage.inert).toBe(false)
    expect(restoredMainPage.hasAttribute('aria-hidden')).toBe(false)
    expect(dom.window.document.querySelector('.cordisx-nav-primary')?.getAttribute('aria-current')).toBe('page')

    dom.window.document.documentElement.lang = 'zh-CN'
    await settle()
    await settle()
    expect(runtime!.snapshot().localization.locale).toBe('zh-CN')
    expect(runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'slot-showcase:main.analytics')?.productMetadata).toEqual({
      title: '工作区分析',
      description: '从演示导航或工作区工具栏打开工作区分析。',
      diagnostics: [],
    })
    expect(runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'slot-showcase:session.analytics')?.productMetadata).toEqual({
      title: '会话分析',
      description: '从会话页头切换当前会话分析，或从演示导航打开已配置会话的分析内容。',
      diagnostics: [],
    })
    expect(runtime!.snapshot().navigation.pages.find(item => item.qualifiedId === 'slot-showcase:session.analytics')?.productMetadata).toEqual({
      title: '会话分析',
      description: '在保留当前原生会话页头的前提下，于会话正文区域展示该会话的分析内容。',
      diagnostics: [],
    })
    expect(runtime!.snapshot().extensionPoints.points.find(item => item.id === 'sidebar.navigation.items')?.titleProjection.text).toBe('侧边栏导航')
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"] button')?.getAttribute('aria-label')).toBe('切换会话分析')
    expect(dom.window.document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"]')?.textContent).toContain('工作区分析')

    expect(native.parentElement).toBe(nativeParent)
    expect(native.textContent).toBe('native data')
    expect(dom.window.getComputedStyle(native).display).not.toBe('none')
    native.textContent = 'native data updated'
    expect(native.textContent).toBe('native data updated')

    await runtime!.setPluginBlocked('slot-showcase', true)
    const blockedSnapshot = runtime!.snapshot()
    expect(blockedSnapshot.plugins[0]?.status).toBe('blocked')
    expect(blockedSnapshot.commands).toEqual([])
    expect(blockedSnapshot.navigation.routes).toEqual([])
    expect(blockedSnapshot.navigation.pages).toEqual([])
    expect(blockedSnapshot.registrations.every(item => !item.rendered)).toBe(true)
    expect(dom.window.document.querySelector('[data-cordisx-page]')).toBeNull()

    await runtime!.setPluginBlocked('slot-showcase', false)
    await settle()
    const restoredSnapshot = runtime!.snapshot()
    expect(restoredSnapshot.plugins[0]?.status).toBe('active')
    expect(restoredSnapshot.commands.length).toBe(6)
    expect(restoredSnapshot.registrations.filter(item => item.rendered).length).toBe(15)
    expect(restoredSnapshot.platform).toMatchObject({
      mode: 'unavailable',
      secondConnectionCreated: false,
      rawBridgeExposed: false,
      diagnostics: [expect.objectContaining({ code: 'current-connection-client-unavailable' })],
    })
    expect(restoredSnapshot.permissions.filter(permission => permission.capability !== 'ui.extension-points.render')).toEqual([
      expect.objectContaining({ capability: 'models.read', policy: 'ask', required: false }),
    ])

    const pluginSource = restoredSnapshot.plugins[0]!.source
    await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'sidebar.navigation.items', 'deny')
    await settle()
    const deniedSurface = runtime!.snapshot()
    expect(deniedSurface.commands).toHaveLength(6)
    expect(deniedSurface.registrations.find(item => item.surface === 'sidebar.navigation.items')).toMatchObject({ authorized: false, rendered: false })
    expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
    await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'sidebar.navigation.items', 'allow')
    await settle()
    expect(dom.window.document.querySelector('.cordisx-nav-row')).not.toBeNull()

    await runtime!.navigate('slot-showcase', { id: 'main.analytics' })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ mounted: true })
    await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'main', 'deny')
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ mounted: false })
    expect(runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'slot-showcase:main.analytics')).toMatchObject({ valid: true, authorized: false })
    expect(native.parentElement).toBe(nativeParent)
    expect(native.isConnected).toBe(true)
    await expect(runtime!.navigate('slot-showcase', { id: 'main.analytics' })).rejects.toThrow(/denied/)
    await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'main', 'allow')

    const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')
    expect(managerTrigger?.getAttribute('aria-label')).toBe('管理 CordisX 插件')
    expect(managerTrigger?.classList.contains('cordisx-icon-only-control')).toBe(false)
    expect(dom.window.getComputedStyle(managerTrigger!).display).toBe('inline-flex')
    expect(dom.window.getComputedStyle(managerTrigger!).alignItems).toBe('center')
    expect(dom.window.getComputedStyle(managerTrigger!).justifyContent).toBe('center')
    expect(managerTrigger?.querySelector('svg')).toBeNull()
    const triggerMark = managerTrigger?.querySelector<HTMLElement>('.cxr-trigger-mark')
    const triggerDark = triggerMark?.querySelector<HTMLImageElement>('.cxr-brand-mark-dark')
    const triggerLight = triggerMark?.querySelector<HTMLImageElement>('.cxr-brand-mark-light')
    expect(dom.window.getComputedStyle(triggerMark!).width).toBe('20px')
    expect(dom.window.getComputedStyle(triggerMark!).height).toBe('20px')
    expect(decodeURIComponent(triggerDark?.src ?? '')).toContain('for dark backgrounds')
    expect(decodeURIComponent(triggerDark?.src ?? '')).toContain('stroke="#fcfcfc"')
    expect(dom.window.document.getElementById('cordisx-react-manager-style')?.textContent).not.toContain('mask-image')
    dom.window.document.documentElement.className = 'electron-light'
    await settle()
    expect(dom.window.getComputedStyle(triggerDark!).display).toBe('none')
    expect(dom.window.getComputedStyle(triggerLight!).display).toBe('block')
    expect(decodeURIComponent(triggerLight?.src ?? '')).toContain('for light backgrounds')
    expect(decodeURIComponent(triggerLight?.src ?? '')).toContain('stroke="#030303"')
    dom.window.document.documentElement.className = 'electron-dark'
    await settle()
    managerTrigger?.click()
    await settle()
    const managerModal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')
    expect(managerModal?.hidden).toBe(false)
    expect(managerModal?.querySelector('.cxr-dialog')).not.toBeNull()
    expect(managerModal?.querySelector('.cxr-nav')?.getAttribute('aria-label')).toBe('CordisX 管理器页面')
    expect([...managerModal!.querySelectorAll<HTMLElement>('.cxr-nav [data-tab]')].map(item => item.dataset.tab)).toEqual(['plugins', 'extension-points', 'routes', 'marketplace', 'about'])
    const pluginRow = managerModal?.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')
    expect(pluginRow?.querySelector('[data-icon-kind="derived"]')).not.toBeNull()
    expect(pluginRow?.textContent).toContain('点位展示')
    pluginRow?.click()
    await settle()
    expect(managerModal?.querySelector('[data-plugin-detail-tab="readme"]')).not.toBeNull()
    expect(managerModal?.querySelector('[data-plugin-detail-tab="config"]')).not.toBeNull()
    expect(managerModal?.querySelector('[role="tabpanel"][aria-label="README"] .cxm-readme')).not.toBeNull()
    await runtime?.dispose()
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
    expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    expect(dom.window.document.querySelector('.cxr-brand-mark')).toBeNull()
    expect(dom.window.document.getElementById('cordisx-react-manager-style')).toBeNull()
    expect(native.parentElement).toBe(nativeParent)
    dom.window.close()
    return undefined
    expect(managerModal?.querySelector('.cxm-brand')).toBeNull()
    expect(managerModal?.querySelector('.cxm-eyebrow')).toBeNull()
    expect(managerModal?.querySelector('.cxm-brand-title')).toBeNull()
    expect(managerModal?.querySelector('.cxm-version')).toBeNull()
    expect(managerModal?.querySelector('.cxm-sidebar')?.firstElementChild?.classList.contains('cxm-nav')).toBe(true)
    const navigation = managerModal?.querySelector<HTMLElement>('.cxm-nav')
    expect(navigation?.tagName).toBe('NAV')
    expect(navigation?.getAttribute('aria-label')).toBe('CordisX 管理器页面')
    const primaryNavigation = [...(navigation?.querySelectorAll<HTMLElement>('.cxm-nav-button') ?? [])]
    expect(primaryNavigation.map(item => item.dataset.tab)).toEqual(['plugins', 'extension-points', 'routes', 'marketplace', 'about'])
    expect(primaryNavigation.map(item => item.tabIndex)).toEqual([0, -1, -1, -1, -1])
    expect(primaryNavigation.map(item => item.getAttribute('aria-current'))).toEqual(['page', null, null, null, null])
    expect(primaryNavigation.slice(0, 4).map(item => item.querySelector('[data-host-icon-key]')?.getAttribute('data-host-icon-key'))).toEqual([
      'plugins', 'contributions', 'routes', 'marketplace',
    ])
    expect(primaryNavigation.at(0)?.textContent).toContain('插件')
    expect(primaryNavigation.at(-1)?.textContent).toContain('关于 CordisX')
    expect(managerModal?.querySelector('.cxm-close [data-host-icon-key="close"]')).not.toBeNull()
    const initialMaterialIcons = [...(managerModal?.querySelectorAll<HTMLElement>('[data-host-icon-key]') ?? [])]
    expect(initialMaterialIcons.length).toBeGreaterThan(6)
    expect(initialMaterialIcons.every(icon => icon.getAttribute('aria-hidden') === 'true' && icon.draggable === false)).toBe(true)
    expect(initialMaterialIcons.every(icon => icon.querySelector('svg path') !== null)).toBe(true)
    expect(initialMaterialIcons.every(icon => icon.querySelector('svg')?.getAttribute('focusable') === 'false')).toBe(true)
    const aboutNavigationMark = primaryNavigation.at(-1)?.querySelector<HTMLImageElement>('img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]')
    expect(aboutNavigationMark?.getAttribute('aria-hidden')).toBe('true')
    expect(aboutNavigationMark?.alt).toBe('')
    expect(aboutNavigationMark?.style.getPropertyValue('--cordisx-brand-mask')).toBe('')
    expect(primaryNavigation.find(item => item.dataset.tab === 'marketplace')?.nextElementSibling?.getAttribute('data-tab')).toBe('about')
    const managerStyles = dom.window.document.getElementById('cordisx-manager-style')?.textContent ?? ''
    expect(managerStyles).toContain('.cxm-nav-button[data-tab="about"] { margin-top: auto; }')
    expect(managerStyles).toContain('grid-template-columns: var(--cx-manager-header-leading-seat) minmax(0, 1fr)')
    expect(managerStyles).toContain('grid-template-columns: 248px minmax(0, 1fr)')
    expect(managerStyles).toContain('width: min(1440px, calc(100vw - 40px))')
    expect(managerStyles).toContain('height: min(960px, calc(100vh - 40px))')
    expect(managerStyles).toContain('.cxm-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }')
    expect(managerStyles).toContain('flex: 1 1 0%')
    expect(managerStyles).toContain('overflow-y: auto')
    expect(managerStyles).toContain('border-radius: 9px;')
    expect(managerStyles).toContain('.cxm-nav-button[aria-current="page"]')
    expect(managerStyles).toContain('grid-template-columns: 18px minmax(0, 1fr)')
    expect(managerStyles).toContain('.cxm-manager-content-root { min-width: 0; max-width: 100%; }')
    expect(managerStyles).toContain('.cxm-tab[aria-selected="true"] { background: rgba(199, 204, 212, .14);')
    expect(managerStyles).not.toContain('.cxm-tab[aria-selected="true"]::after')
    expect(managerStyles).toContain('.cxm-heading p { grid-column: 1 / -1; margin: 3px 0 0;')
    expect(managerStyles).toContain('.cxm-heading-leading {')
    expect(managerStyles).toContain('min-height: var(--cx-manager-header-leading-seat)')
    expect(managerStyles).toContain('transform: translateY(-.5px)')
    expect(managerStyles).toContain('-webkit-user-select: none')
    expect(managerStyles).toContain('user-select: none')
    expect(managerStyles).toContain('-webkit-user-drag: none')
    expect(managerStyles).toContain('border: 0;\n    background: transparent;')
    expect(managerStyles).toContain('.cxm-back:hover { background: rgba(199, 204, 212, .14);')
    expect(managerStyles).toContain('.cxm-back:focus-visible { outline: 2px solid #c7ccd4;')
    expect(managerStyles).toContain('.cxm-breadcrumb-menu')
    expect(managerStyles).toContain('background: #4ade80')
    expect(managerStyles).not.toMatch(/#8b5cf6|#a78bfa|#ddd6fe|#b9a6ff|#c4b5fd|139, 92, 246|167, 139, 250/)
    expect(managerStyles).toContain('background: #4ade80')
    expect(managerStyles).toContain('background: #fbbf24')
    expect(managerStyles).toContain('background: #fb7185')
    expect(managerStyles).not.toContain('.cxm-result-count')
    expect(managerStyles).not.toContain('.cxm-feed-summary')
    expect(managerStyles).toContain('.cxm-about-identity-copy { min-width: 0; white-space: nowrap; }')
    const pluginCard = managerModal?.querySelector<HTMLElement>('[data-plugin-card="slot-showcase"]')
    expect(pluginCard?.querySelector('.cxc-description')?.textContent).toBe('查看插件、导航、页面与状态。')
    expect(pluginCard?.querySelector('.cxc-machine-id')?.textContent).toBe('slot-showcase')
    expect(pluginCard?.querySelector('.cxc-status')?.getAttribute('data-tone')).toBe('success')
    expect(pluginCard?.querySelector('[data-plugin-primary]')?.getAttribute('aria-description')).toBe('运行中')
    expect(pluginCard?.textContent).not.toContain('运行中')
    const importButton = managerModal?.querySelector<HTMLButtonElement>('[data-import-local-plugin]')
    expect(importButton?.textContent).toBe('')
    expect(importButton?.getAttribute('aria-label')).toBe('导入本地插件')
    expect(importButton?.querySelector('[data-host-icon-key="import-plugin"]')).not.toBeNull()
    expect(managerStyles).toContain('.cxc-card:hover .cxc-actions')
    expect(managerStyles).toContain('.cxc-card:focus-within .cxc-actions')
    expect(managerStyles).toContain('.cxc-card[data-action-menu-open="true"] .cxc-actions')
    const expectLocalTabLeadingSeat = (selector: string): void => {
      const firstTab = dom.window.document.querySelector<HTMLElement>(`${selector}:first-child`)
      const icon = firstTab?.querySelector<HTMLElement>('.cxm-tab-icon')
      const visibleContent = firstTab?.querySelector<HTMLElement>('.cxm-tab-content')
      expect(firstTab).not.toBeNull()
      expect(dom.window.getComputedStyle(firstTab!).paddingLeft).toBe('9px')
      expect(dom.window.getComputedStyle(firstTab!).borderRadius).toBe('9px')
      expect(dom.window.getComputedStyle(icon!).width).toBe('18px')
      expect(dom.window.getComputedStyle(icon!).height).toBe('18px')
      expect(dom.window.getComputedStyle(visibleContent!).gridTemplateColumns).toBe('18px minmax(0, 1fr)')
    }
    const managerHeadings = (): string[] => [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-heading h2, .cxm-section-title')]
      .map(element => element.textContent?.trim() ?? '')
    const breadcrumbLabels = (): string[] => [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-breadcrumb-list > .cxm-breadcrumb-item')]
      .flatMap(item => [...item.querySelectorAll<HTMLElement>(':scope > .cxm-breadcrumb-action, :scope > .cxm-breadcrumb-current')])
      .map(element => element.textContent?.trim() ?? '')
    const primaryLeading = dom.window.document.querySelector<HTMLElement>('.cxm-heading-leading')
    expect(primaryLeading?.classList.contains('cxm-heading-icon')).toBe(true)
    expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).width).toBe('var(--cx-manager-header-leading-seat)')
    expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).borderTopWidth).toBe('0px')
    expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(primaryLeading?.dataset.hostIconKey).toBe('plugins')
    expect(primaryLeading?.textContent).toBe('')
    expect(primaryLeading?.querySelector('svg')?.getAttribute('focusable')).toBe('false')
    expect(primaryLeading?.draggable).toBe(false)
    expect(managerHeadings()).toEqual(['插件'])
    const pluginList = managerModal?.querySelector<HTMLElement>('[role="list"][aria-label="当前 bundle 插件"]')
    const pluginOpen = pluginList?.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')
    expect(pluginList).not.toBeNull()
    expect(pluginOpen).not.toBeNull()
    expect(pluginOpen?.querySelector('.cxm-chevron')).toBeNull()
    expect(pluginOpen?.closest('[role="listitem"]')).not.toBeNull()
    const pluginActions = [...(pluginOpen?.closest('.cxc-card')?.querySelectorAll<HTMLButtonElement>('[data-plugin-action]') ?? [])]
    expect(pluginActions.map(action => action.dataset.pluginAction)).toEqual(['disable', 'favorite', 'reload'])
    expect(pluginActions.find(action => action.dataset.pluginAction === 'disable')).toMatchObject({ disabled: true })
    expect(pluginActions.find(action => action.dataset.pluginAction === 'reload')).toMatchObject({ disabled: true })
    expect(pluginActions.find(action => action.dataset.pluginAction === 'reload')?.getAttribute('aria-label')).toBe('重载插件：当前不可用')
    expect(pluginActions.every(action => action.querySelector('[data-host-icon-key]') !== null)).toBe(true)
    expect(pluginActions.find(action => action.dataset.pluginAction === 'favorite')?.getAttribute('aria-pressed')).toBe('false')
    pluginActions.find(action => action.dataset.pluginAction === 'favorite')?.click()
    expect(managerHeadings()).toEqual(['插件'])
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.favoritePlugins.v1:development') ?? '[]')).toEqual(['slot-showcase'])
    const overflow = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-menu="slot-showcase"] .cxc-menu-trigger')!
    overflow.click()
    const overflowMenu = dom.window.document.querySelector<HTMLElement>('body > .cxc-menu-popup')
    expect(overflow.getAttribute('aria-expanded')).toBe('true')
    expect(overflowMenu?.getAttribute('role')).toBe('menu')
    expect([...overflowMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []].map(item => [item.dataset.collectionAction, item.disabled])).toEqual([
      ['diagnostics', false],
    ])
    overflowMenu?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
    expect(overflow.getAttribute('aria-expanded')).toBe('false')
    const aboutTab = dom.window.document.querySelector<HTMLButtonElement>('[data-tab="about"]')
    aboutTab?.focus()
    aboutTab?.click()
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('')
    expect(dom.window.document.querySelector('.cxm-heading-icon [data-cordisx-brand-mark]')).toBeNull()
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.matches('[data-cordisx-brand-mark]')).toBe(true)
    const aboutDirectMarks = [...(managerModal?.querySelectorAll<HTMLImageElement>('img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]') ?? [])]
    const currentAboutMarks = () => [...(managerModal?.querySelectorAll<HTMLImageElement>('img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]') ?? [])]
    expect(aboutDirectMarks).toHaveLength(3)
    expect(dom.window.document.querySelectorAll('[data-brand-rendering="direct-host"]')).toHaveLength(4)
    expect(aboutDirectMarks.every(mark => mark.getAttribute('aria-hidden') === 'true' && mark.alt === '')).toBe(true)
    expect(aboutDirectMarks.every(mark => mark.style.getPropertyValue('--cordisx-brand-mask') === '')).toBe(true)
    const directSvg = decodeURIComponent(aboutDirectMarks[0]?.src.slice(aboutDirectMarks[0].src.indexOf(',') + 1) ?? '')
    expect(directSvg).toContain('CordisX mark for dark backgrounds')
    expect(new Set([...directSvg.matchAll(/stroke="(#[0-9a-f]{6})"/gi)].map(match => match[1])).size).toBeGreaterThan(10)
    dom.window.document.documentElement.className = 'electron-light'
    await settle()
    expect(currentAboutMarks().every(mark => mark.dataset.hostBackground === 'light')).toBe(true)
    expect(currentAboutMarks().every(mark => decodeURIComponent(mark.src).includes('CordisX mark for light backgrounds'))).toBe(true)
    expect(dom.window.getComputedStyle(primaryNavigation[0]!.querySelector<HTMLElement>('.cxm-nav-icon')!).color).toBe('var(--cx-muted)')
    expect(managerModal?.style.getPropertyValue('--cx-muted')).toBe('#526071')
    expect(dom.window.getComputedStyle(dom.window.document.querySelector<HTMLElement>('.cxm-heading-leading')!).color).toBe('var(--cx-text)')
    expect(managerModal?.style.getPropertyValue('--cx-text')).toBe('#18212f')
    dom.window.document.documentElement.className = 'electron-dark'
    await settle()
    expect(currentAboutMarks().every(mark => mark.dataset.hostBackground === 'dark')).toBe(true)
    expect(dom.window.document.querySelector('.cxm-about-name')?.textContent).toBe('CordisX')
    expect(dom.window.document.querySelector('.cxm-about-version')?.textContent).toBe('v0.1.0-beta.2')
    expect(dom.window.document.querySelector('.cxm-about-identity [data-cordisx-brand-mark]')).not.toBeNull()
    expect([...dom.window.document.querySelector('.cxm-about-identity')?.children ?? []].map(item => item.className)).toEqual([
      'cxm-brand-mark cxm-about-mark', 'cxm-about-identity-copy',
    ])
    expect(dom.window.document.querySelector('.cxm-about-actions')?.getAttribute('role')).toBe('list')
    expect(dom.window.document.querySelectorAll('.cxm-about-action-item[role="listitem"]')).toHaveLength(4)
    const aboutActions = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.cxm-about-action')]
    expect(aboutActions.map(link => link.querySelector('.cxm-about-action-title')?.textContent)).toEqual([
      '反馈问题', '参与建设', '查看文档', '项目主页',
    ])
    expect(aboutActions.map(link => link.href)).toEqual([
      'https://github.com/cordisx/cordisx/issues/new',
      'https://github.com/cordisx/cordisx',
      'https://cordisx.github.io/docs/',
      'https://cordisx.github.io/',
    ])
    expect(aboutActions.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true)
    expect(aboutActions.every(link => link.getAttribute('role') === null)).toBe(true)
    expect(aboutActions.every(link => link.querySelector('.cxm-about-action-arrow')?.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(aboutActions.every(link => link.querySelector('.cxm-about-action-arrow')?.getAttribute('data-host-icon-key') === 'external-link')).toBe(true)
    expect(aboutActions.every(link => link.children.length === 2
      && link.children[0]?.classList.contains('cxm-about-action-body')
      && link.children[1]?.classList.contains('cxm-about-action-arrow'))).toBe(true)
    expect(aboutActions.every(link => link.parentElement?.matches('.cxm-about-action-item[role="listitem"]'))).toBe(true)
    expect(aboutActions.every(link => [...(link.querySelector('.cxm-about-action-body')?.children ?? [])]
      .map(child => child.className).join(' ') === 'cxm-about-action-title cxm-about-action-copy')).toBe(true)
    expect(aboutActions.every(link => dom.window.getComputedStyle(link).display === 'flex')).toBe(true)
    expect(aboutActions.every(link => dom.window.getComputedStyle(link).padding === '14px 12px')).toBe(true)
    const transparentBackgrounds = new Set(['transparent', 'rgba(0, 0, 0, 0)'])
    expect(aboutActions.every(link => transparentBackgrounds.has(dom.window.getComputedStyle(link.querySelector<HTMLElement>('.cxm-about-action-title')!).backgroundColor))).toBe(true)
    expect(aboutActions.every(link => transparentBackgrounds.has(dom.window.getComputedStyle(link.querySelector<HTMLElement>('.cxm-about-action-copy')!).backgroundColor))).toBe(true)
    const aboutStyles = [...dom.window.document.querySelectorAll('style')].map(style => style.textContent ?? '').join('\n')
    expect(aboutStyles).toMatch(/\.cxm-about-action\s*\{[^}]*width:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*border-radius:\s*9px;[^}]*background:\s*transparent;/)
    expect(aboutStyles).toMatch(/\.cxm-about-actions\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid[^}]*border-radius:\s*12px;/)
    expect(aboutStyles).toContain('.cxm-about-action-item + .cxm-about-action-item { border-top: 1px solid rgba(255, 255, 255, .08); }')
    expect(aboutStyles).toContain('.cxm-about-action:hover, .cxm-about-action:focus-visible { background: var(--cx-hover); color: var(--cx-text); }')
    expect(aboutStyles).toContain('.cxm-about-action-title, .cxm-about-action-copy { background: transparent; }')
    expect(aboutStyles).not.toMatch(/\.cxm-about-action:hover \.cxm-about-action-title\s*\{[^}]*background:/)
    aboutActions[0]?.focus()
    expect(dom.window.document.activeElement).toBe(aboutActions[0])
    const externalClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
    expect(aboutActions[0]?.dispatchEvent(externalClick)).toBe(true)
    expect(externalClick.defaultPrevented).toBe(false)
    expect(managerModal?.hidden).toBe(true)
    expect(managerTrigger?.getAttribute('aria-expanded')).toBe('false')
    expect(dom.window.document.activeElement).not.toBe(managerTrigger)
    managerTrigger?.click()
    expect(managerModal?.textContent).not.toContain('CordisX 版本')
    expect(managerModal?.textContent).not.toContain('运行插件')
    expect(managerModal?.textContent).not.toContain('结构化 surfaces')
    expect(managerModal?.textContent).not.toContain('宿主语言')
    expect(managerModal?.textContent).not.toContain('运行边界')
    expect(managerModal?.textContent).not.toContain('管理器里的“屏蔽”')
    expect(managerModal?.querySelector('.cxm-card-grid')).toBeNull()
    expect(managerHeadings()).toEqual(['关于 CordisX'])
    expect(managerModal?.querySelector('.cxm-result-count')).toBeNull()
    expect(managerModal?.querySelector('.cxm-feed-summary')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="extension-points"]')?.click()
    expect(dom.window.document.querySelector<HTMLElement>('.cxm-heading-icon')?.dataset.hostIconKey).toBe('contributions')
    expect(managerModal?.textContent).toContain('sidebar.footer.before-control')
    expect(managerModal?.textContent).toContain('侧边栏底部前置操作')
    expect(managerHeadings()).toEqual(['扩展点'])
    expect(dom.window.document.querySelector('[role="list"] [role="listitem"] button[data-extension-point-id]')).not.toBeNull()
    expect(managerModal?.textContent).not.toContain('个活跃贡献')
    expect(managerModal?.textContent).not.toContain('Routes / Pages')
    const extensionPointSearch = dom.window.document.querySelector<HTMLInputElement>('[aria-label="搜索 CordisX 扩展点"]')
    extensionPointSearch!.value = '侧边栏导航'
    extensionPointSearch!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const managerContent = dom.window.document.querySelector<HTMLElement>('.cxm-content')!
    managerContent.scrollTop = 37
    dom.window.document.querySelector<HTMLButtonElement>('[data-extension-point-id="sidebar.navigation.items"]')?.click()
    expect(managerHeadings()).toEqual(['使用情况'])
    expect(breadcrumbLabels()).toEqual(['扩展点', '侧边栏导航', '使用情况'])
    const pointTabs = [...dom.window.document.querySelectorAll<HTMLElement>('[data-extension-point-detail-tab]')]
    expect(pointTabs.map(tab => tab.textContent)).toEqual(['使用情况', '点位信息', '诊断'])
    expect(pointTabs.map(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('data-host-icon-key'))).toEqual(['plugins', 'point-info', 'diagnostics'])
    expectLocalTabLeadingSeat('[data-extension-point-detail-tab]')
    expect(dom.window.document.querySelector('[data-list-search^="extension-point-usage-"]')).not.toBeNull()
    const navigationContribution = dom.window.document.querySelector<HTMLElement>('[data-contribution-id="main-page"]')
    expect(navigationContribution?.querySelector('.cxm-resource-title')?.textContent).toBe('结构化 UI 演示')
    expect(navigationContribution?.querySelector('.cxm-resource-description')?.textContent).toContain('打开演示页面。')
    expect(navigationContribution?.querySelector('.cxm-resource-id')?.textContent).toBe('main-page')
    expect(navigationContribution?.querySelector('.cxm-slot-card, .cxm-kind-badge, .cxm-chevron')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-extension-point-detail-tab="information"]')?.click()
    expect(breadcrumbLabels()).toEqual(['扩展点', '侧边栏导航', '点位信息'])
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
    expect(breadcrumbLabels()).toEqual(['扩展点', '侧边栏导航', '使用情况'])
    const pointPolicy = dom.window.document.querySelector<TestTDesignSelect>('t-select[aria-label="Slot Showcase使用侧边栏导航的策略"]')
    expect(pointPolicy).not.toBeNull()
    pointPolicy!.setSelectedValue('deny', true)
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().extensionPoints.policies.find(item => item.identity.pointId === 'sidebar.navigation.items')?.policy !== 'deny'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().extensionPoints.policies.find(item => item.identity.pointId === 'sidebar.navigation.items')?.policy).toBe('deny')
    const deniedPointPolicy = dom.window.document.querySelector<TestTDesignSelect>('t-select[aria-label="Slot Showcase使用侧边栏导航的策略"]')
    deniedPointPolicy!.setSelectedValue('allow', true)
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().extensionPoints.policies.find(item => item.identity.pointId === 'sidebar.navigation.items')?.policy !== 'allow'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
    expect(dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="extension-points"]')?.value).toBe('侧边栏导航')
    expect(managerContent.scrollTop).toBe(37)
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="routes"]')?.click()
    expect(managerHeadings()).toEqual(['路由'])
    expect(dom.window.document.querySelectorAll('[data-route-id]')).toHaveLength(3)
    expect(dom.window.document.querySelectorAll('[data-page-product-row]')).toHaveLength(3)
    expect(managerModal?.querySelector('[data-host-collection="routes"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[role="list"] [role="listitem"] button[data-route-id]')).not.toBeNull()
    expect(managerModal?.textContent).not.toContain('/main/showcase')
    expect(managerModal?.querySelector('[data-route-product-row="slot-showcase:main.analytics"] .cxc-title')?.textContent).toBe('工作区分析')
    expect(managerModal?.querySelector('[data-route-product-row="slot-showcase:main.analytics"] .cxc-description')?.textContent)
      .toContain('从演示导航或工作区工具栏打开工作区分析')
    expect(managerModal?.querySelector('[data-route-product-row="slot-showcase:session.analytics"] .cxc-machine-id')?.textContent).toBe('slot-showcase:session.analytics')
    expect(managerModal?.querySelector('.cxm-kind-badge')).toBeNull()
    const catalogRouteSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="routes"]')!
    catalogRouteSearch.value = '/sessions/:sessionId/analytics'
    catalogRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-route-product-row]')]
      .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(1)
    expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-page-product-row]')]
      .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(1)
    const resetCatalogRouteSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="routes"]')!
    resetCatalogRouteSearch.value = ''
    resetCatalogRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    dom.window.document.querySelector<HTMLButtonElement>('[data-route-id="slot-showcase:main.analytics"]')?.click()
    expect(managerHeadings()).toEqual(['工作区分析'])
    expect(breadcrumbLabels()).toEqual(['路由', '工作区分析'])
    expect(managerModal?.textContent).toContain('slot-showcase:main.analytics')
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
    const search = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="plugins"]')
    if (search !== null) {
      search.value = 'workspace.toolbar.items'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    expect(managerModal?.textContent).toContain('slot-showcase')
    expect(managerModal?.textContent).not.toContain('插件配置')
    expect(dom.window.document.querySelector<HTMLElement>('.cxm-heading-icon')?.dataset.hostIconKey).toBe('plugins')
    expect(managerHeadings()).toEqual(['插件'])

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')?.click()
    const back = dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')
    expect(back?.textContent).toBe('')
    expect(back?.getAttribute('aria-label')).toBe('返回')
    expect(back?.classList.contains('cxm-heading-leading')).toBe(true)
    expect(back?.querySelector('[data-host-icon-key="back"]')).not.toBeNull()
    expect(dom.window.getComputedStyle(back as HTMLElement).width).toBe('var(--cx-manager-header-leading-seat)')
    expect(dom.window.getComputedStyle(back as HTMLElement).borderTopWidth).toBe('0px')
    expect(dom.window.getComputedStyle(back as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', 'README'])
    expect(dom.window.document.querySelector('.cxm-readme h1')?.textContent).toBe('Slot Showcase')
    expect(managerModal?.textContent).toContain('结构化 UI 端到端演示插件')
    expect(managerModal?.textContent).not.toContain('插件配置')
    expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
    const pluginDetailTabs = [...dom.window.document.querySelectorAll<HTMLElement>('[data-plugin-detail-tab]')]
    expect(pluginDetailTabs.every(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(pluginDetailTabs.every(tab => tab.querySelector('.cxm-tab-icon svg') !== null)).toBe(true)
    expect(pluginDetailTabs.map(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('data-host-icon-key'))).toEqual([
      'document', 'configuration', 'permissions', 'runtime', 'diagnostics', 'outlets', 'routes',
    ])
    expect(pluginDetailTabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
    expect(pluginDetailTabs.map(tab => tab.textContent)).toEqual(['README', '配置管理', '权限', '运行状态', '日志与诊断', '扩展点位', '路由'])
    expectLocalTabLeadingSeat('[data-plugin-detail-tab]')

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
    expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('config')
    expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-plugin-detail-tab]')].map(tab => tab.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1])
    expect(managerModal?.textContent).not.toContain('插件配置')
    const configPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="配置管理"]')
    const sessionField = configPanel?.querySelector<HTMLElement>('[data-config-path="sessionId"]')
    expect(sessionField?.querySelector('.cxf-label')?.textContent).toBe('原生会话 ID')
    expect(sessionField?.querySelector('.cxf-help')?.textContent)
      .toBe('可选导航快捷操作使用的原生会话 ID；留空时隐藏该快捷操作。')
    expect(sessionField?.querySelector<HTMLElement & { value: string }>('t-input')?.value).toBe(sessionId)
    expect(configPanel?.querySelector('t-button[data-variant="primary"]')).toBeNull()
    expect(configPanel?.textContent).not.toContain('此插件未提供可编辑设置。')
    expect(configPanel?.textContent).not.toContain('{}')
    expect(configPanel?.textContent).not.toContain('Schema')
    expect(configPanel?.textContent).not.toContain('Revision')
    expect(configPanel?.textContent).not.toContain('应用方式')
    expect(configPanel?.querySelector('.cxm-detail-grid')).toBeNull()
    expect(configPanel?.querySelector('.cxm-config-path')).toBeNull()
    expect(managerHeadings()).toEqual(['配置管理'])
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '配置管理'])
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="配置管理"]')).not.toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('permissions')
    const permissionsPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="权限"]')
    expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
    expect(managerHeadings()).toEqual(['权限'])
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '权限'])
    expect(managerHeadings()).not.toContain('Platform 权限')
    expect(permissionsPanel?.textContent).not.toContain('Platform 权限')
    expect(permissionsPanel?.querySelector('.cxm-detail')).toBeNull()
    expect(permissionsPanel?.querySelector('.cxm-slot-card')).toBeNull()
    expect(permissionsPanel?.querySelector('[role="list"][data-manager-group="capability-declarations"]')).not.toBeNull()
    expect(permissionsPanel?.querySelector('[role="listitem"][data-permission-item="models.read"]')?.getAttribute('aria-label')).toBe('读取可用模型')
    expect(permissionsPanel?.textContent).not.toContain('models.read')
    expect(permissionsPanel?.textContent).toContain('读取可用模型')
    expect(managerModal?.textContent).toContain('显示当前宿主连接实际可用的模型')
    expect(permissionsPanel?.textContent).not.toContain('current-connection-client-unavailable')
    expect(permissionsPanel?.textContent).not.toContain('trusted renderer code 不是安全沙箱')
    expect(permissionsPanel?.textContent).not.toContain('二次连接')
    expect(permissionsPanel?.textContent).not.toContain('原始 bridge 暴露')
    expect(permissionsPanel?.textContent).not.toContain('不是安全沙箱')
    expect(permissionsPanel?.querySelector('[data-permission-availability="models.read"]')).toBeNull()
    expect(permissionsPanel?.querySelector('[data-permission-capability="models.read"]')).not.toBeNull()
    dom.window.document.documentElement.lang = 'zh-CN'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(managerModal?.textContent).toContain('显示当前宿主连接实际可用的模型')
    dom.window.document.querySelector<HTMLButtonElement>('[data-permission-open="models.read"]')?.click()
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '权限', '读取可用模型'])
    expect(dom.window.document.querySelector('[data-breadcrumb-current]')?.textContent).toBe('读取可用模型')
    expect(dom.window.document.querySelector('[data-breadcrumb-current]')?.matches('button, a')).toBe(false)
    expect([...dom.window.document.querySelectorAll('[data-breadcrumb-target]')].map(item => item.textContent)).toEqual(['插件', 'Slot Showcase', '权限'])
    expect(dom.window.history.length).toBe(1)
    expect(dom.window.location.href).toBe('https://codex.local/native')
    expect(dom.window.document.querySelector('[data-permission-detail="models.read"]')?.textContent).toContain('models.read')
    expect(dom.window.document.querySelector('[data-permission-provider="desktop-current-connection"]')).not.toBeNull()
    const permissionPolicy = dom.window.document.querySelector<TestTDesignSelect>('t-select[data-permission-capability="models.read"]')
    expect(permissionPolicy!.options.map(option => option.label)).toEqual(['不可用'])
    expect(permissionPolicy!.disabled).toBe(true)
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
    expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('routes')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="routes"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('readme')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="readme"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('routes')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('runtime')
    expect(dom.window.document.querySelector('[data-plugin-runtime-status="slot-showcase"]')?.textContent).toContain('运行中')
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"]')?.textContent).not.toContain('slot-showcase:main.analytics')
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"]')?.textContent).not.toContain('controlled mount')
    expect(managerHeadings()).toContain('运行状态')
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '运行状态'])
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="logs"]')?.click()
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="日志与诊断"] [data-runtime-lifecycle]')).toBeNull()
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="日志与诊断"] [data-runtime-console-summary]')).toBeNull()
    const platformDiagnostics = dom.window.document.querySelector<HTMLDetailsElement>('details[data-runtime-diagnostics="platform"]')
    expect(platformDiagnostics?.open).toBe(false)
    expect(platformDiagnostics?.querySelector('summary')?.textContent).toBe('诊断')
    expect(platformDiagnostics?.querySelector('[data-config-diagnostics="slot-showcase"]')?.textContent)
      .toBe('配置: Schemastery · plugin-restart · 版本 0 · 最后可用 0 · 写入器 不可用')
    expect(platformDiagnostics?.textContent).toContain('current-connection-client-unavailable')
    expect(platformDiagnostics?.textContent).not.toContain('当前权限仅适用于 Host API 调用。')
    expect(platformDiagnostics?.textContent).not.toContain('查看权限说明')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))
    await settle()
    const runtimeAction = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-runtime-action="slot-showcase"]')
    expect(runtimeAction).not.toBeNull()
    runtimeAction?.click()
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'blocked'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().plugins[0]?.status).toBe('blocked')
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toContain('slot-showcase')
    expect(runtime!.snapshot().commands).toEqual([])
    expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-runtime-action="slot-showcase"]')?.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    dom.window.document.querySelector<HTMLButtonElement>('[data-authorization-decision="allow"]')?.click()
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'active'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settle()
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toEqual([])
    expect(runtime?.snapshot().extensionPoints.points.find(item => item.id === 'sidebar.navigation.items')).toMatchObject({
      adapterSupport: 'supported',
      effectiveAdapterSupport: 'supported',
      currentContext: 'not-mounted',
      availabilityCode: 'context.not-mounted',
    })
    expect(runtime?.snapshot().registrations.find(item => item.surface === 'sidebar.navigation.items')).toMatchObject({
      currentContext: 'not-mounted',
      availabilityCode: 'context.not-mounted',
      valid: true,
      authorized: true,
      pending: true,
      rendered: false,
    })
    expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-close')?.click()
    await settle()
    expect(runtime?.snapshot().extensionPoints.points.find(item => item.id === 'sidebar.navigation.items')).toMatchObject({
      adapterSupport: 'supported',
      effectiveAdapterSupport: 'supported',
      currentContext: 'active',
    })
    expect(runtime?.snapshot().registrations.find(item => item.surface === 'sidebar.navigation.items')).toMatchObject({
      currentContext: 'active',
      pending: false,
      rendered: true,
    })
    expect(dom.window.document.querySelector('.cordisx-nav-row')).not.toBeNull()
    managerTrigger?.click()
    await settle()

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="extension-points"]')?.click()
    expect(dom.window.document.querySelector('[data-host-collection="plugin-extension-points-slot-showcase"]')).not.toBeNull()
    expect(managerModal?.textContent).toContain('workspace.toolbar.items')
    expect(managerModal?.textContent).toContain('工作区工具栏')
    expect(managerModal?.textContent).not.toContain('/main/analytics')
    expect(managerHeadings()).toEqual(['扩展点位'])
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '扩展点位'])
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="routes"]')?.click()
    expect(dom.window.document.querySelector('[data-host-collection="plugin-routes-slot-showcase"]')).not.toBeNull()
    expect(managerModal?.textContent).not.toContain('/main/showcase')
    expect(managerModal?.textContent).toContain('slot-showcase:main.analytics')
    const pluginRoutePanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="路由"]')!
    expect(pluginRoutePanel.querySelector('[data-host-collection="plugin-routes-slot-showcase"]')).not.toBeNull()
    expect(pluginRoutePanel.querySelectorAll('[data-route-product-row]')).toHaveLength(3)
    expect(pluginRoutePanel.querySelectorAll('[data-page-product-row]')).toHaveLength(3)
    expect(pluginRoutePanel.querySelector('[data-route-product-row="slot-showcase:app.overview"] .cxc-description')?.textContent)
      .toContain('从侧栏底部或演示设置打开应用概览')
    expect(pluginRoutePanel.querySelector('[data-page-product-row="slot-showcase:session.analytics"] .cxc-description')?.textContent)
      .toContain('当前原生会话页头')
    expect(pluginRoutePanel.querySelector('.cxm-kind-badge')).toBeNull()
    expect(pluginRoutePanel.textContent).not.toContain('受控页面 mount')
    const pluginRouteSearch = pluginRoutePanel.querySelector<HTMLInputElement>('[data-collection-search="plugin-routes-slot-showcase"]')!
    pluginRouteSearch.value = '当前原生会话页头'
    pluginRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect([...pluginRoutePanel.querySelectorAll<HTMLElement>('[data-route-product-row]')]
      .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(0)
    expect([...pluginRoutePanel.querySelectorAll<HTMLElement>('[data-page-product-row]')]
      .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(1)
    const resetPluginRouteSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="plugin-routes-slot-showcase"]')!
    resetPluginRouteSearch.value = ''
    resetPluginRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '路由'])

    dom.window.document.querySelector<HTMLButtonElement>('[data-breadcrumb-target="primary:plugins"]')?.click()
    const restoredSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="plugins"]')
    expect(restoredSearch?.value).toBe('workspace.toolbar.items')
    expect(managerModal?.textContent).not.toContain('插件配置')

    if (restoredSearch !== null) {
      restoredSearch.value = ''
      restoredSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="configured-off"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.click()
    const emptyPermissionsPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="权限"]')
    expect(emptyPermissionsPanel?.textContent).toContain('该插件没有申请任何权限。')
    expect(emptyPermissionsPanel?.textContent).not.toContain('当前连接：')
    expect(emptyPermissionsPanel?.querySelector('[role="list"]')).toBeNull()
    expect(emptyPermissionsPanel?.querySelector('section section')).toBeNull()
    expect(managerHeadings()).toHaveLength(1)
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()

    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')?.click()
    expect(dom.window.document.querySelector<HTMLElement>('.cxm-heading-icon')?.dataset.hostIconKey).toBe('marketplace')
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(managerModal?.textContent).toContain('发现插件')
    expect(managerModal?.textContent).toContain('点位展示目录')
    expect(managerModal?.textContent).not.toContain('Marketplace hierarchy fixture')
    expect(managerModal?.querySelector('.cxm-feed-summary')).toBeNull()
    expect(managerModal?.querySelector('.cxm-result-count')).toBeNull()
    expect(managerHeadings()).toEqual(['插件商店'])
    dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin="slot-showcase"] .cxc-primary')?.click()
    expect(managerHeadings()).toEqual(['概览', '关键词'])
    expect(breadcrumbLabels()).toEqual(['插件商店', '点位展示目录', '概览'])
    expect(managerModal?.textContent?.match(/点位展示目录/g)).toHaveLength(1)
    expect(managerModal?.textContent).toContain('插件商店层级夹具')
    const marketplaceTabs = [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-detail-tab]')]
    expect(marketplaceTabs.map(tab => tab.textContent)).toEqual(['概览', '作者与来源'])
    expect(marketplaceTabs.map(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('data-host-icon-key'))).toEqual(['overview', 'authors-source'])
    expect(marketplaceTabs.map(tab => tab.tabIndex)).toEqual([0, -1])
    expectLocalTabLeadingSeat('[data-marketplace-detail-tab]')
    expect(managerModal?.textContent).not.toContain('运行状态')
    expect(managerModal?.textContent).not.toContain('安装')
    dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-detail-tab="authors-source"]')?.click()
    expect(dom.window.document.activeElement?.getAttribute('data-marketplace-detail-tab')).toBe('authors-source')
    expect(breadcrumbLabels()).toEqual(['插件商店', '点位展示目录', '作者与来源'])
    const marketplaceLinks = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('[role="tabpanel"][aria-label="作者与来源"] a')]
    expect(marketplaceLinks.length).toBeGreaterThan(2)
    expect(marketplaceLinks.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true)
    const marketplaceExternalClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
    expect(marketplaceLinks[0]?.dispatchEvent(marketplaceExternalClick)).toBe(true)
    expect(marketplaceExternalClick.defaultPrevented).toBe(false)
    expect(managerModal?.hidden).toBe(true)
    expect(managerTrigger?.getAttribute('aria-expanded')).toBe('false')
    managerTrigger?.click()
    expect(dom.window.document.querySelector('[data-marketplace-detail-tab="authors-source"]')?.getAttribute('aria-selected')).toBe('true')
    expect(managerModal?.querySelector('.cxm-detail')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-breadcrumb-target="primary:marketplace"]')?.click()

    const sourceMenu = dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!
    sourceMenu.click()
    expect(dom.window.document.querySelector(`[data-manager-action-menu="${managerCopy('zh-CN', 'marketplace.source-menu-label')}"]`)?.parentElement).toBe(dom.window.document.body)
    dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="manage"]')!.click()
    expect(dom.window.document.querySelector('[data-marketplace-source-page="index"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[data-host-collection="marketplace-sources"]')).not.toBeNull()
    expect(managerModal?.textContent).not.toContain('重新加载')
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()

    expect(dom.window.document.querySelector('[data-tab="settings"]')).toBeNull()
    expect(dom.window.document.querySelector('[data-settings-tab]')).toBeNull()
    expect(managerModal?.textContent).not.toContain('启动器配置由 cordisx.config.json 管理。')

    await runtime?.dispose()
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-page-outlet]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-brand-mark]')).toBeNull()
    expect(dom.window.document.querySelectorAll<HTMLElement>('[data-test-id="header-shell-slot"]')[1]?.style.width).toBe('0px')
    expect(dom.window.document.getElementById('cordisx-manager-style')).toBeNull()
    expect(native.parentElement).toBe(nativeParent)
    dom.window.close()
  }, 90_000)
})
