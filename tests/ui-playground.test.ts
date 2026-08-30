import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { defaultUiPlaygroundConfig } from '../packages/cli/src/playground/defaults.js'
import { startUiPlayground } from '../packages/cli/src/playground/server.js'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { activatePlaygroundReviewNavigation } from '../packages/cli/src/playground/client/review-navigation.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { createSidebarItem } from '../packages/cli/src/renderer/host-ui/SidebarItem.js'

const defaultPluginIds = [
  'slot-showcase', 'hello-toolbar', 'form-schema-gallery', 'settings-tab-demo',
  'console-showcase', 'channel', 'cli-proxy-api',
]

describe('UI Playground', () => {
  it('enters an exact configured review navigation row without selecting a debug fixture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-review-navigation-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      playground: { name: 'External review', reviewNavigationItem: 'chatroom:chatroom' },
      plugins: [],
    }))
    const session = await createPlaygroundSession(configPath)
    expect(session.fixture).toEqual({
      name: 'External review',
      source: 'cordisx.config.json',
      reviewNavigationItem: 'chatroom:chatroom',
    })

    const dom = new JSDOM('<!doctype html><body><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></body>', { url: 'http://127.0.0.1/' })
    let exactActivations = 0
    let adjacentActivations = 0
    const dispose = activatePlaygroundReviewNavigation(dom.window.document, session.fixture.reviewNavigationItem!)
    const adjacent = createSidebarItem(dom.window.document, { id: 'chatroom:other', label: 'Other', onActivate: () => { adjacentActivations += 1 } })
    const exact = createSidebarItem(dom.window.document, { id: 'chatroom:chatroom', label: 'New room', onActivate: () => { exactActivations += 1 } })
    dom.window.document.querySelector('nav')?.append(adjacent.element, exact.element)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(exactActivations).toBe(1)
    expect(adjacentActivations).toBe(0)
    dispose()
    dom.window.close()
    await session.close()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a non-qualified Playground review navigation target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-review-navigation-invalid-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      playground: { reviewNavigationItem: 'chatroom' },
      plugins: [],
    }))
    await expect(createPlaygroundSession(configPath)).rejects.toThrow(
      'playground.reviewNavigationItem must be an exact owner-qualified contribution id',
    )
    await rm(root, { recursive: true, force: true })
  })

  it('renders the official Manager BrandMark through the same Host SidebarItem primitive', async () => {
    const [app, manager, styles] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/manager/ManagerApp.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
    ])

    expect(app).toContain('<span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true" />')
    expect(app.match(/data-cordisx-playground-manager-trigger/g)).toHaveLength(1)
    expect(app.indexOf('data-cordisx-playground-manager-trigger')).toBeLessThan(app.indexOf('action.new'))
    expect(manager).toContain("id: 'host.manager'")
    expect(manager).toContain("secondary: 'UI Playground'")
    expect(manager).toContain('iconElement: createBrandMarkElement')
    expect(manager).toContain('const item = createSidebarItem(')
    expect(styles).not.toContain('.pg-brand-row')
    expect(styles).toContain('.pg-sidebar .cxsi-brand-mark')
    expect(styles).not.toContain('.pg-sidebar-footer .cxr-trigger-seat')
    expect(styles).toContain('html[data-theme="light"] .pg-sidebar .cxsi-brand-mark > .cxr-brand-mark-light { display: block; }')
  })

  it('uses one Host sidebar primitive and one accessible sidebar environment menu', async () => {
    const [app, seats, styles, adapter, menu, environment] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/components/HostSeats.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/adapter.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/host-ui/HostMenu.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/environment.ts'), 'utf8'),
    ])
    expect(app).toContain("createSidebarItem(document")
    expect(adapter).toContain('createSidebarItem(this.document')
    expect(app).toContain('id="action.new"')
    expect(app).toContain('data-cordisx-playground-surface="sidebar.navigation.items"')
    expect(app).toContain('secondary={en ?')
    expect(styles).toContain('.pg-sidebar .cxsi-primary { display: grid; width: 100%;')
    expect(styles).toContain('.pg-sidebar .cxsi-copy, .pg-sidebar .cxsi-actions')
    expect(seats).not.toContain('pg-workspace-toolbar')
    expect(seats).toContain('AgentConversationRenderer')
    expect(seats).toContain('debugFixture')
    expect(seats).not.toContain('pg-session-header')
    expect(seats).not.toContain('pg-timeline')
    expect(seats).not.toContain('pg-composer')
    expect(styles).not.toContain('.pg-workspace-toolbar')
    expect(styles).not.toContain('.pg-session-header')
    expect(styles).not.toContain('.pg-timeline')
    expect(styles).not.toContain('.pg-composer')
    expect(app).not.toContain('pg-devtools')
    expect(styles).not.toContain('.pg-devtools')
    expect(app.match(/className="pg-sidebar-control"/g)).toHaveLength(1)
    expect(menu).toContain('aria-haspopup="menu"')
    expect(menu).toContain("event.key === 'Escape'")
    expect(menu).toContain("event.key === 'ArrowDown' || event.key === 'ArrowRight'")
    expect(environment).toContain('new HostThemeProjection(document)')
    expect(environment).toContain('new DocumentLocaleAdapter(document)')
  })

  it('renders brand, built-in, contributed, and recent rows with one readable semantic primitive', async () => {
    const styles = await readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8')
    const dom = new JSDOM(`<!doctype html><html data-theme="dark"><head><style>${styles}</style></head><body><aside class="pg-sidebar"></aside></body></html>`, { url: 'http://127.0.0.1/' })
    let activations = 0
    const brandMark = dom.window.document.createElement('span')
    brandMark.className = 'cxsi-brand-mark'
    const brand = createSidebarItem(dom.window.document, { id: 'brand', label: 'CordisX', secondary: 'UI Playground', iconElement: brandMark, onActivate: () => { activations += 1 } })
    const single = createSidebarItem(dom.window.document, { id: 'built-in', label: 'Playground', icon: 'host:playground', onActivate: () => { activations += 1 } })
    const recent = createSidebarItem(dom.window.document, { id: 'recent', label: 'Room', secondary: 'Latest task', icon: 'host:history', selected: true, onActivate: () => { activations += 1 } })
    dom.window.document.querySelector('.pg-sidebar')?.append(brand.element, single.element, recent.element)
    expect(brand.primary.classList.contains('cxsi-primary')).toBe(true)
    expect(single.primary.classList.contains('cxsi-primary')).toBe(true)
    expect(recent.primary.classList.contains('cxsi-primary')).toBe(true)
    expect(brand.element.dataset.variant).toBe('two-line')
    expect(single.element.dataset.variant).toBe('single-line')
    expect(recent.element.dataset.variant).toBe('two-line')
    expect(recent.element.dataset.selected).toBe('true')
    const darkUnselected = dom.window.getComputedStyle(single.primary).color
    const darkSelected = dom.window.getComputedStyle(recent.primary).color
    expect(darkUnselected).toBe('var(--pg-muted)')
    expect(darkSelected).toBe('var(--pg-text)')
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-muted').trim()).toBe('#999')
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-text').trim()).toBe('#ececec')
    expect(single.primary.querySelector('svg')?.getAttribute('fill') ?? '').not.toMatch(/black|#000(?:000)?/i)
    expect([...single.primary.querySelectorAll('[fill], [stroke]')].map(node => `${node.getAttribute('fill')} ${node.getAttribute('stroke')}`).join(' ')).not.toMatch(/black|#000(?:000)?/i)
    dom.window.document.documentElement.dataset.theme = 'light'
    expect(dom.window.getComputedStyle(single.primary).color).toBe('var(--pg-muted)')
    expect(dom.window.getComputedStyle(recent.primary).color).toBe('var(--pg-text)')
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-muted').trim()).toBe('#6f6f6b')
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-text').trim()).toBe('#202020')
    brand.primary.click()
    single.primary.click()
    recent.primary.click()
    expect(activations).toBe(3)
    recent.setSelected(true, true)
    expect(recent.primary.getAttribute('aria-current')).toBe('page')
    recent.setDisabled(true)
    expect(recent.primary.getAttribute('aria-disabled')).toBe('true')
    dom.window.close()
  })

  it('serves a loopback production renderer bundle and removes isolated state on close', async () => {
    const source = await readFile(defaultUiPlaygroundConfig, 'utf8')
    const playground = await startUiPlayground({ configPath: defaultUiPlaygroundConfig })
    try {
      expect(playground.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const page = await fetch(playground.url).then(response => response.text())
      expect(page).toContain('data-cordisx-playground-manager-trigger')
      expect(page).toContain('Comprehensive UI demos')
      expect(page).toContain('data-pg-plugin-count')
      expect(page).toContain('npm run dev:ui -- --config')
      expect(page).toContain('__cordisxServiceConfigRequestV1')
      expect(page).toContain('__cordisxChannelCredentialRequestV1')
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      expect(bundle).toContain('hostKind: "playground"')
      expect(bundle).toContain('installCordisX')
      const serviceConfigToken = /serviceConfigBridgeToken: "([a-f0-9]{64})"/.exec(bundle)?.[1]
      const generation = /generation: "(playground-[a-f0-9]+)"/.exec(bundle)?.[1]
      expect(serviceConfigToken).toBeDefined()
      expect(generation).toBeDefined()
      const serviceList = await fetch(`${playground.url}api/service-config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1, token: serviceConfigToken, requestId: 'playground-service-list', operation: 'list', pluginId: 'channel',
          scope: { profileId: 'playground', generation },
        }),
      }).then(response => response.json()) as { ok: boolean; value?: Array<{ writable?: boolean }> }
      expect(serviceList.ok).toBe(true)
      expect(serviceList.value?.[0]?.writable).toBe(true)
      const materialized = path.join(playground.homeDir, 'config', 'playground.config.json')
      const materializedInitial = await readFile(materialized, 'utf8')
      expect(JSON.parse(materializedInitial).plugins.map((plugin: { id: string }) => plugin.id)).toEqual(defaultPluginIds)
      await writeFile(materialized, '{"version":1,"plugins":[]}\n')
      await fetch(`${playground.url}api/reset`, { method: 'POST' }).then(response => expect(response.ok).toBe(true))
      expect(await readFile(materialized, 'utf8')).toBe(materializedInitial)
      expect(await readFile(defaultUiPlaygroundConfig, 'utf8')).toBe(source)
    } finally {
      const home = playground.homeDir
      await playground.close()
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 30_000)

  it('applies explicit narrow preview permissions without claiming an AgentLoop backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-permissions-'))
    const entry = path.resolve('tests/fixtures/agent-loop-runtime-plugin.ts')
    const identity = { source: pathToFileURL(entry).href, id: 'agent-loop-runtime' }
    const policies = (['tasks.create', 'tasks.content.read', 'turns.submit'] as const).map(capability => createPermissionPolicyRecord({
      profileId: 'playground', identity, capability, scope: { providers: ['gateway-a'] }, policy: 'allow',
    }))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, `${JSON.stringify({
      version: 1,
      plugins: [{ id: identity.id, entry, enabled: true, config: {} }],
      playground: { permissionPolicies: policies },
    })}\n`)
    const playground = await startUiPlayground({ configPath })
    try {
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      const dom = new JSDOM('<!doctype html><html><body><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></body></html>', {
        runScripts: 'dangerously', url: playground.url,
      })
      try {
        Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
        Object.defineProperty(dom.window, 'structuredClone', { value: globalThis.structuredClone })
        dom.window.eval(bundle)
        await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
        const snapshot = (dom.window as unknown as {
          __cordisxRuntime?: { snapshot(): {
            plugins: readonly { id: string; status: string; blockedReason?: string }[]
            permissions: readonly { capability: string; policy: string; availability: { status: string } }[]
          }; dispose(): Promise<void> }
        }).__cordisxRuntime?.snapshot()
        expect(snapshot?.plugins).toEqual([expect.objectContaining({ id: identity.id, status: 'active' })])
        expect(snapshot?.permissions.map(item => ({ capability: item.capability, policy: item.policy, availability: item.availability.status }))).toEqual([
          { capability: 'tasks.create', policy: 'allow', availability: 'unavailable' },
          { capability: 'tasks.content.read', policy: 'allow', availability: 'unavailable' },
          { capability: 'turns.submit', policy: 'allow', availability: 'unavailable' },
        ])
        await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
      } finally { dom.window.close() }
    } finally {
      await playground.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('boots, reloads, and disposes the comprehensive real plugin runtime with explicit Playground seats only', async () => {
    const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
    expect(config.plugins.map(plugin => plugin.id)).toEqual(defaultPluginIds)
    const bundle = await buildRendererBundle(config, { playground: true, generation: 'playground-test-1', profileId: 'playground' })
    const dom = new JSDOM(`<!doctype html><html data-theme="dark"><head></head><body>
      <aside>
        <nav data-cordisx-playground-surface="sidebar.navigation.items"></nav>
        <footer><span data-cordisx-playground-surface="sidebar.footer.before-control"></span><button data-cordisx-playground-template="sidebar.footer">Tools</button><span data-cordisx-playground-surface="sidebar.footer.after-control"></span></footer>
        <button data-cordisx-playground-manager-trigger>Manager</button>
      </aside>
      <main data-cordisx-playground-session-id="fixture-session">
        <header data-cordisx-playground-surface="session.header.actions"><button data-cordisx-playground-template="session.header">Session</button></header>
        <div data-cordisx-playground-surface="composer.toolbar.items"><button data-cordisx-playground-template="composer.toolbar">Composer</button></div>
        <input data-cordisx-playground-reasoning type="range" min="0" max="4" value="2">
      </main>
      <main data-cordisx-playground-seat="app"></main><main data-cordisx-playground-seat="main"></main><main data-cordisx-playground-seat="session.content"></main>
    </body></html>`, { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
    try {
      dom.window.eval(bundle)
      for (let attempt = 0; attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const runtime = dom.window as unknown as { __cordisxRuntime?: { snapshot(): { plugins: readonly { id: string; name: string; description?: string; icon?: string; status: string }[]; platform: { mode: string }; navigation: { outlets: readonly { id: string; activeRoute?: string; presentation: string }[] } }; dispose(): Promise<void> } }
      expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
        .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => plugin.name)).toEqual([
        'Slot Showcase', 'Hello Toolbar', 'Form Schema Gallery', 'Settings Navigation Demo',
        'Plugin Console Showcase', 'Channels', 'CLIProxy Providers',
      ])
      dom.window.document.documentElement.lang = 'zh-CN'
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => plugin.name)).toEqual([
        '点位展示', '工具栏问候', '表单结构展示', '设置导航演示',
        '插件控制台展示', '渠道', 'CLIProxy 提供方',
      ])
      expect(runtime.__cordisxRuntime?.snapshot().plugins.find(plugin => plugin.id === 'channel')?.description)
        .toBe('管理渠道账号、连接和会话。')
      expect(runtime.__cordisxRuntime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')?.icon)
        .toMatch(/^data:image\/png;base64,/)
      expect(runtime.__cordisxRuntime?.snapshot().platform.mode).toBe('unavailable')
      for (let attempt = 0; attempt < 100 && dom.window.document.querySelector('[data-cordisx-playground-surface="sidebar.navigation.items"] [data-cordisx-surface-host]') === null; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(dom.window.document.querySelector('[data-cordisx-playground-surface="sidebar.navigation.items"] [data-cordisx-surface-host]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-cordisx-playground-surface="session.header.actions"] [data-cordisx-surface-host]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-cordisx-playground-surface="composer.toolbar.items"] [data-cordisx-surface-host]')).not.toBeNull()
      const showcaseNavigation = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-cordisx-playground-surface="sidebar.navigation.items"] .cordisx-nav-primary')]
        .find(button => button.textContent?.includes('结构化 UI 演示'))
      expect(showcaseNavigation).toBeDefined()
      expect(showcaseNavigation?.closest('[data-sidebar-item]')).not.toBeNull()
      showcaseNavigation?.click()
      for (let attempt = 0; attempt < 100 && runtime.__cordisxRuntime?.snapshot().navigation.outlets.find(item => item.id === 'main')?.activeRoute !== 'slot-showcase:main.analytics'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(runtime.__cordisxRuntime?.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({
        activeRoute: 'slot-showcase:main.analytics', presentation: 'presented',
      })
      expect(dom.window.document.querySelector('[data-cordisx-page-outlet="main"]')?.hidden).toBe(false)
      const publicSnapshotJson = JSON.stringify(runtime.__cordisxRuntime?.snapshot())
      expect(publicSnapshotJson).not.toContain('extensionPointControls')
      expect(publicSnapshotJson).not.toContain('principalHandle')
      expect(publicSnapshotJson).not.toContain('principal:')
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      const reactManager = dom.window.document.querySelector('[data-cordisx-react-manager="true"]')
      expect(reactManager).not.toBeNull()
      const managerStyles = dom.window.document.getElementById('cordisx-react-manager-style')?.textContent ?? ''
      expect(managerStyles).toContain('.t-input {')
      expect(managerStyles).toContain('.t-textarea__inner {')
      expect(managerStyles).toContain('.cxr-root { position: relative; z-index: 2147483500;')
      expect(managerStyles).toContain('.cxr-backdrop { position: fixed; inset: 0; z-index: 2147483500;')
      expect(managerStyles).toContain('.cxr-tabs { display: flex; min-height: 38px; flex: none;')
      expect(managerStyles).toContain('.cxr-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));')
      expect(managerStyles).toContain('.cxr-plugin-actions { position: absolute; top: 50%;')
      expect(managerStyles).toContain('transform: translateY(-50%);')
      expect(managerStyles).toContain('.cxf-form-body { display: grid; min-width: 0; align-content: start; grid-auto-rows: max-content;')
      expect(managerStyles).toContain('.cxr-page[data-plugin-detail]:has(> .cxr-plugin-config-panel)')
      expect(managerStyles).not.toContain('.cxr-page[data-plugin-detail] { display: flex;')
      expect(trigger.closest('.cxr-trigger-seat')?.previousElementSibling).toBe(dom.window.document.querySelector('[data-cordisx-playground-manager-trigger]'))
      expect(trigger.closest('[data-sidebar-item="host.manager"]')?.querySelector('.cxsi-brand-mark img')).not.toBeNull()
      expect(trigger.classList.contains('cxsi-primary')).toBe(true)
      expect(trigger.querySelector('svg')).toBeNull()
      trigger.click()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')).not.toBeNull()
      expect(dom.window.document.querySelector<HTMLImageElement>('[data-plugin-id="cli-proxy-api"] .cxr-card-icon img')?.src)
        .toMatch(/^data:image\/png;base64,/)
      const internalAccents = new Map([
        ['slot-showcase', 'spectral'],
        ['hello-toolbar', 'solar'],
        ['form-schema-gallery', 'violet'],
        ['settings-tab-demo', 'polar'],
        ['console-showcase', 'ember'],
        ['channel', 'jade'],
      ])
      const gradientPhases = new Set<string>()
      for (const [pluginId, accent] of internalAccents) {
        const internalBadge = dom.window.document.querySelector(`[data-plugin-id="${pluginId}"] [data-internal-plugin-badge="${pluginId}"]`)
        expect(internalBadge?.getAttribute('data-accent')).toBe(accent)
        expect(internalBadge?.getAttribute('data-brand-geometry')).toBe('official-1440-segments')
        expect(internalBadge?.getAttribute('data-gradient-mode')).toBe('segment-depth')
        expect(internalBadge?.getAttribute('data-gradient-phase')).toMatch(/^\d+$/)
        gradientPhases.add(internalBadge?.getAttribute('data-gradient-phase') ?? '')
        const derivedMarks = internalBadge?.querySelectorAll<HTMLImageElement>('img') ?? []
        expect(derivedMarks).toHaveLength(2)
        for (const mark of derivedMarks) expect(mark.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
        expect(internalBadge?.textContent).toBe('')
      }
      expect(gradientPhases.size).toBe(internalAccents.size)
      for (const [index, id] of defaultPluginIds.entries()) {
        dom.window.document.querySelector<HTMLButtonElement>(`[data-plugin-id="${id}"]`)?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(dom.window.document.querySelector('[data-plugin-detail]')?.getAttribute('data-plugin-detail')).toBe(id)
        expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
        if (index < defaultPluginIds.length - 1) {
          dom.window.document.querySelector<HTMLButtonElement>('.cxr-breadcrumbs button')?.click()
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      const firstRuntime = runtime.__cordisxRuntime!
      let disposed = false
      const dispose = firstRuntime.dispose.bind(firstRuntime)
      firstRuntime.dispose = async () => { disposed = true; await dispose() }
      const reload = await buildRendererBundle(config, { playground: true, generation: 'playground-test-2', profileId: 'playground' })
      dom.window.eval(reload)
      for (let attempt = 0; attempt < 100 && runtime.__cordisxRuntime === firstRuntime; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(disposed).toBe(true)
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
        .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
      expect(dom.window.document.querySelector('[data-plugin-detail]')?.getAttribute('data-plugin-detail')).toBe('cli-proxy-api')
      expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
      await runtime.__cordisxRuntime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally { dom.window.close() }
  }, 30_000)
})
