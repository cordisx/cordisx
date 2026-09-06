import { JSDOM } from 'jsdom'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { buildRendererBundle } from '../../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../../packages/cli/src/launcher/config.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from '../helpers/dom-permission.js'
import { RuntimeHandle, settle } from './bundle.fixtures.js'

export async function bootSurfaces() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const sessionId = '01a02d54-8adf-7043-944c-0bc9bb41bfd9'
  const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
  const config = {
    ...baseConfig,
    plugins: [
      ...baseConfig.plugins.map(plugin => ({ ...plugin, config: { sessionId } })),
      {
        id: 'configured-off',
        entry: path.join(projectRoot, 'missing-disabled-plugin.ts'),
        enabled: false,
        config: {},
      },
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
          'app',
          'main',
          'session.content',
          'sidebar.footer.before-control',
          'sidebar.footer.after-control',
          'sidebar.footer.menu',
          'sidebar.account.menu',
          'sidebar.navigation.items',
          'workspace.toolbar.items',
          'session.header.actions',
          'composer.toolbar.items',
          'environment.panel.header-actions',
          'environment.panel.sections',
          'environment.section.actions',
          'environment.section.rows',
          'environment.row.trailing-actions',
        ],
      }]),
    },
  })
  const dom = new JSDOM(
    `
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
    `,
    { runScripts: 'dangerously', url: 'https://codex.local/native' },
  )
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  installPermissionPolicyBridge(dom.window)
  Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel', configurable: true })
  Object.defineProperty(dom.window, 'fetch', {
    value: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
          schemaVersion: 2,
          fallbackLocale: 'en',
          name: 'CordisX Community Marketplace',
          localizations: { 'zh-CN': { name: 'CordisX 社区插件商店' } },
          homepage: 'https://cordisx.github.io/marketplace/',
          plugins: [{
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json',
            schemaVersion: 2,
            id: 'slot-showcase',
            fallbackLocale: 'en',
            name: 'Slot Showcase Catalog',
            description: 'Marketplace hierarchy fixture',
            localizations: {
              'zh-CN': {
                name: '点位展示目录',
                description: '插件商店层级夹具',
                authors: ['CordisX 团队'],
                keywords: ['结构化界面', '演示'],
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
        }),
    }),
  })
  const native = dom.window.document.getElementById('native-conversation')!
  const nativeParent = native.parentElement
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect
  const getBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      if (
        this.dataset.cordisxSurfaceHost === 'toolbar.before' || this.dataset.cordisxSurfaceHost === 'toolbar.after'
      ) {
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
  Object.defineProperty(
    dom.window.document.querySelector('[data-app-shell-application-menu-bar]'),
    'getBoundingClientRect',
    { value: () => rect(0, 0, 1200, 46) },
  )
  Object.defineProperty(
    dom.window.document.querySelector('[data-testid="app-shell-header-context-menu-surface"]'),
    'getBoundingClientRect',
    { value: () => rect(240, 0, 960, 46) },
  )
  Object.defineProperty(dom.window.document.querySelector('[data-codex-composer-root]'), 'getBoundingClientRect', {
    value: () => rect(420, 700, 600, 120),
  })
  Object.defineProperty(
    dom.window.document.querySelector('[data-composer-footer-responsive]'),
    'getBoundingClientRect',
    { value: () => rect(440, 760, 560, 40) },
  )
  Object.defineProperty(dom.window.document.getElementById('native-summary-obstacle'), 'getBoundingClientRect', {
    value: () => rect(960, 46, 300, 654),
  })
  Object.defineProperty(dom.window.document.getElementById('native-summary-motion-shell'), 'getBoundingClientRect', {
    value: () => rect(960, 46, 300, 654),
  })
  Object.defineProperty(dom.window.document.getElementById('native-summary-column'), 'getBoundingClientRect', {
    value: () => rect(960, 46, 300, 654),
  })
  Object.defineProperty(dom.window.document.getElementById('native-summary-card'), 'getBoundingClientRect', {
    value: () => rect(960, 46, 300, 654),
  })
  Object.defineProperty(dom.window.document.getElementById('native-summary-scrollport'), 'getBoundingClientRect', {
    value: () => rect(960, 46, 300, 654),
  })
  Object.defineProperty(dom.window.document.getElementById('native-summary-section-stack'), 'getBoundingClientRect', {
    value: () => rect(960, 46, 300, 654),
  })
  let nativeBackgroundProcessesRect = rect(960, 56, 300, 94)
  Object.defineProperty(dom.window.document.getElementById('native-background-processes'), 'getBoundingClientRect', {
    value: () => nativeBackgroundProcessesRect,
  })
  Object.defineProperty(dom.window.document.body, 'getBoundingClientRect', { value: () => rect(0, 0, 1200, 900) })
  let mainRect = rect(240, 0, 960, 900)
  Object.defineProperty(
    dom.window.document.querySelector('[data-app-shell-main-content-layout]'),
    'getBoundingClientRect',
    { value: () => mainRect },
  )
  dom.window.history.replaceState({ usr: null, key: 'native-test', idx: 0 }, '')
  dom.window.eval(bundle)
  for (
    let attempt = 0;
    attempt < 30 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
    attempt += 1
  ) {
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
        fields: [
          expect.objectContaining({
            path: ['sessionId'],
            label: 'Native session ID',
            value: sessionId,
            max: 128,
          }),
          expect.objectContaining({
            path: ['welcomePage'],
            label: 'Branded welcome page',
            value: false,
          }),
        ],
      }),
    }),
    expect.objectContaining({ id: 'configured-off', status: 'configured-disabled' }),
  ])
  expect(snapshot.registrations).toHaveLength(15)
  expect(new Set(snapshot.registrations.map(item => item.surface))).toEqual(
    new Set([
      'sidebar.footer.before-control',
      'sidebar.footer.after-control',
      'sidebar.footer.menu',
      'sidebar.account.menu',
      'sidebar.navigation.items',
      'workspace.toolbar.items',
      'session.header.actions',
      'composer.toolbar.items',
      'environment.panel.header-actions',
      'environment.panel.sections',
      'environment.section.actions',
      'environment.section.rows',
      'environment.row.trailing-actions',
    ]),
  )
  expect(snapshot.registrations.every(item => item.valid && item.rendered)).toBe(true)
  expect(snapshot.commands).toHaveLength(6)
  expect(snapshot.commands).toContainEqual(expect.objectContaining({
    owner: 'slot-showcase',
    qualifiedId: 'slot-showcase:open-session',
  }))
  expect(snapshot.navigation.routes).toHaveLength(3)
  expect(snapshot.navigation.routes.every(item => item.valid)).toBe(true)
  expect(snapshot.navigation.pages).toHaveLength(3)
  expect(
    snapshot.navigation.routes.find(item => item.qualifiedId === 'slot-showcase:main.analytics')?.productMetadata,
  ).toEqual({
    title: 'Workspace analytics',
    description: 'Open workspace analytics from showcase navigation or the workspace toolbar.',
    diagnostics: [],
  })
  expect(
    snapshot.navigation.routes.find(item => item.qualifiedId === 'slot-showcase:session.analytics')?.productMetadata,
  ).toEqual({
    title: 'Session analytics',
    description:
      'Toggle analytics for the current session from its header, or open the configured session from showcase navigation.',
    diagnostics: [],
  })
  expect(
    snapshot.navigation.pages.find(item => item.qualifiedId === 'slot-showcase:session.analytics')?.productMetadata,
  ).toEqual({
    title: 'Session analytics',
    description: 'Presents analytics for the currently selected native session below its persistent session header.',
    diagnostics: [],
  })
  expect(snapshot.navigation.outlets).toHaveLength(5)
  expect(snapshot.extensionPoints.points).toHaveLength(40)
  expect(snapshot.extensionPoints.points.filter(item => item.kind === 'surface')).toHaveLength(33)
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
  expect(new Set(surfaceHosts.map(host => host.dataset.cordisxSurfaceHost))).toEqual(
    new Set([
      'sidebar.navigation',
      'sidebar.footer.before',
      'sidebar.footer.after',
      'toolbar.before',
      'toolbar.after',
      'session.header.actions',
      'composer.submit.before',
      'environment',
    ]),
  )
  expect(surfaceHosts.every(host => host.parentElement !== dom.window.document.body)).toBe(true)
  expect(dom.window.document.querySelector('.cordisx-structured')).toBeNull()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="sidebar.navigation"]')?.parentElement?.id)
    .toBe('native-navigation')
  expect(
    dom.window.document.querySelector('[data-cordisx-surface-host="sidebar.footer.before"]')?.nextElementSibling?.id,
  ).toBe('native-help')
  expect(
    dom.window.document.getElementById('native-help')?.nextElementSibling?.getAttribute('data-cordisx-surface-host'),
  ).toBe('sidebar.footer.after')
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="toolbar.before"]')?.nextElementSibling?.id)
    .toBe('native-toolbar-tooltip-trigger')
  expect(
    dom.window.document.getElementById('native-toolbar-tooltip-trigger')?.nextElementSibling?.getAttribute(
      'data-cordisx-surface-host',
    ),
  ).toBe('toolbar.after')
  expect(
    dom.window.document.getElementById('native-toolbar-tooltip-trigger')?.querySelector(
      '[data-cordisx-surface-host]',
    ),
  ).toBeNull()
  expect(
    dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')?.nextElementSibling?.id,
  ).toBe('native-session-tooltip-trigger')
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')?.parentElement?.id)
    .toBe('native-session-actions')
  expect(
    dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')?.nextElementSibling?.id,
  ).toBe('native-submit')
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')?.parentElement?.id)
    .toBe('native-composer-actions')
  const environmentSeat = dom.window.document.querySelector<HTMLElement>('[data-cordisx-surface-host="environment"]')!
  const environmentSection = environmentSeat.querySelector<HTMLElement>('.cordisx-env-section')!
  const environmentHeader = environmentSection.querySelector<HTMLElement>(':scope > .cordisx-env-header')!
  const environmentContent = environmentSection.querySelector<HTMLElement>(':scope > .cordisx-env-content')!
  const environmentRow = environmentContent.querySelector<HTMLElement>('.cordisx-env-row')!
  expect(environmentSeat.children).toHaveLength(1)
  expect(environmentSection.getAttribute('role')).toBe('presentation')
  expect(environmentHeader.querySelector('.cordisx-env-title')?.textContent).toBe('CordisX runtime')
  expect(
    [...environmentHeader.querySelectorAll<HTMLButtonElement>('button')].map(button =>
      button.getAttribute('aria-label')
    ),
  )
    .toEqual(['Refresh snapshot', 'Showcase settings'])
  expect(environmentContent.querySelector(':scope > .cordisx-shortcut-action')).toBeNull()
  expect(environmentContent.querySelector('.cordisx-env-description')?.textContent).toBe('Current runtime status.')
  const environmentLeading = environmentRow.querySelector<HTMLElement>('.cordisx-env-row-leading')!
  const environmentLabel = environmentRow.querySelector<HTMLElement>('.cordisx-env-row-label')!
  const environmentValue = environmentRow.querySelector<HTMLElement>('.cordisx-env-row-value')!
  const environmentRowAction = environmentRow.querySelector<HTMLButtonElement>(
    '.cordisx-env-row-actions .cordisx-shortcut-action',
  )!
  const environmentHeaderAction = environmentHeader.querySelector<HTMLButtonElement>(
    '.cordisx-env-header-actions .cordisx-shortcut-action',
  )!
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
  expect(dom.window.getComputedStyle(environmentRowAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe(
    '16px',
  )
  expect(dom.window.getComputedStyle(environmentHeaderAction).getPropertyValue('--cordisx-icon-only-glyph-size'))
    .toBe('18px')
  const nativeBackgroundProcesses = dom.window.document.getElementById('native-background-processes')!
  expect(environmentSeat.parentElement?.id).toBe('native-summary-section-stack')
  expect(nativeBackgroundProcesses.nextElementSibling).toBe(environmentSeat)
  expect(dom.window.document.getElementById('native-summary-obstacle')?.childElementCount).toBe(0)
  expect(environmentSection.getBoundingClientRect().top - nativeBackgroundProcesses.getBoundingClientRect().bottom)
    .toBeGreaterThanOrEqual(12)
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
  expect(
    runtime!.snapshot().registrations
      .filter(item => item.surface.startsWith('environment.'))
      .every(item => !item.rendered),
  ).toBe(true)
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
  Object.defineProperty(
    replacementMotionShell.querySelector('#native-summary-section-stack-rerendered'),
    'getBoundingClientRect',
    { value: () => rect(960, 46, 300, 654) },
  )
  Object.defineProperty(
    replacementMotionShell.querySelector('#native-background-processes-rerendered'),
    'getBoundingClientRect',
    { value: () => rect(960, 56, 300, 94) },
  )
  dom.window.document.getElementById('native-summary-motion-shell')?.replaceWith(replacementMotionShell)
  await settle()
  await settle()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="environment"]')).toBe(environmentSeat)
  expect(environmentSeat.parentElement?.id).toBe('native-summary-section-stack-rerendered')
  expect(dom.window.document.getElementById('native-background-processes-rerendered')?.nextElementSibling).toBe(
    environmentSeat,
  )
  expect(
    runtime!.snapshot().registrations
      .filter(item => item.surface.startsWith('environment.'))
      .every(item => item.rendered),
  ).toBe(true)
  expect(
    dom.window.document.getElementById('native-session-tooltip-trigger')?.querySelector(
      '[data-cordisx-surface-host]',
    ),
  ).toBeNull()
  expect(dom.window.document.getElementById('native-session-menu')?.parentElement?.id).toBe(
    'native-session-tooltip-trigger',
  )
  expect(dom.window.document.getElementById('native-submit')?.parentElement?.id).toBe('native-composer-actions')
  expect(surfaceHosts.every(host => host.dataset.cordisxNoDrag === 'true')).toBe(true)
  expect([...dom.window.document.querySelectorAll<HTMLElement>('.cordisx-action')]
    .every(button => button.dataset.cordisxNoDrag === 'true')).toBe(true)
  const setMainRect = (value: DOMRect) => {
    mainRect = value
  }

  return {
    sessionId,
    config,
    plugin,
    bundle,
    dom,
    native,
    nativeParent,
    rect,
    getBoundingClientRect,
    mainRect,
    runtime,
    snapshot,
    setMainRect,
  }
}
