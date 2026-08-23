import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../src/launcher/bundle.js'
import { loadConfig } from '../src/launcher/config.js'

interface RuntimeSnapshot {
  plugins: readonly { id: string; source: string; status: string; readme?: string }[]
  registrations: readonly { owner: string; surface: string; valid: boolean; rendered: boolean; item: unknown }[]
  commands: readonly { owner: string; qualifiedId: string }[]
  navigation: {
    routes: readonly { owner: string; qualifiedId: string; valid: boolean }[]
    pages: readonly { owner: string; qualifiedId: string }[]
    outlets: readonly { id: string; contextKey?: string; activeRoute?: string; mounted: boolean }[]
  }
  localization: { locale: string; direction: string; version: number }
  localeCatalogs: readonly { owner: string; locale: string }[]
  localizationDiagnostics: readonly unknown[]
  platform: { mode: string; secondConnectionCreated: boolean; rawBridgeExposed: boolean; diagnostics: readonly { code: string }[] }
  permissions: readonly { capability: string; policy: string; reasonText: string; required: boolean }[]
}

interface RuntimeHandle {
  readonly version: string
  snapshot(): RuntimeSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  execute(owner: string, reference: { id: string }): Promise<unknown>
  navigate(owner: string, reference: { id: string; params?: Record<string, string> }): Promise<void>
  dispose(): Promise<void>
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('renderer bundle', () => {
  it('boots the structured demo, routes all outlets, reprojects locale, and disposes one generation', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const config = {
      ...baseConfig,
      plugins: [
        ...baseConfig.plugins,
        { id: 'configured-off', entry: path.join(projectRoot, 'missing-disabled-plugin.ts'), enabled: false, config: {} },
      ],
    }
    const bundle = await buildRendererBundle(config)
    const sessionId = '01a02d54-8adf-7043-944c-0bc9bb41bfd9'
    const dom = new JSDOM(`
      <html lang="en" dir="ltr"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
        <header data-app-shell-application-menu-bar style="position:relative"></header>
        <aside><div data-app-action-sidebar-scroll style="position:relative">
          <div data-app-action-sidebar-project-list-id="project-one">
            <button data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-id="local:${sessionId}"></button>
          </div>
        </div></aside>
        <main data-app-shell-main-content-layout="thread-edge-scroll" style="position:relative">
          <section data-codex-thread-reference-drop-target style="position:relative">
            <div id="native-conversation" data-thread-find-target="conversation" data-response-annotation-conversation="${sessionId}">native data</div>
            <div data-above-composer-conversation-id="${sessionId}"></div>
            <div data-codex-thread-reference-drop-target></div>
          </section>
        </main>
        <aside data-pip-home-surface="thread-summary-panel" style="position:relative"></aside>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json',
        schemaVersion: 1,
        name: 'CordisX Community Marketplace',
        homepage: 'https://cordisx.github.io/marketplace/',
        plugins: [{
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json',
          schemaVersion: 1,
          id: 'slot-showcase',
          name: 'Slot Showcase Catalog',
          description: 'Marketplace hierarchy fixture',
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
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 30 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
    expect(runtime?.version).toBe('0.1.0')
    const snapshot = runtime!.snapshot()
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({ id: 'slot-showcase', status: 'active', readme: expect.stringContaining('# Slot Showcase') }),
      expect.objectContaining({ id: 'configured-off', status: 'configured-disabled' }),
    ])
    expect(snapshot.registrations).toHaveLength(12)
    expect(new Set(snapshot.registrations.map(item => item.surface))).toEqual(new Set([
      'sidebar.footer.before-control', 'sidebar.footer.after-control', 'sidebar.footer.menu', 'sidebar.navigation.items',
      'workspace.toolbar.items', 'environment.panel.header-actions', 'environment.panel.sections',
      'environment.section.actions', 'environment.section.rows', 'environment.row.trailing-actions',
    ]))
    expect(snapshot.registrations.every(item => item.valid && item.rendered)).toBe(true)
    expect(snapshot.commands).toHaveLength(5)
    expect(snapshot.navigation.routes).toHaveLength(3)
    expect(snapshot.navigation.routes.every(item => item.valid)).toBe(true)
    expect(snapshot.navigation.pages).toHaveLength(3)
    expect(snapshot.navigation.outlets).toHaveLength(3)
    expect(snapshot.localeCatalogs).toHaveLength(2)
    expect(snapshot.localizationDiagnostics).toEqual([])
    expect(dom.window.document.querySelectorAll('[data-cordisx-surface-host]')).toHaveLength(3)

    const trailing = dom.window.document.querySelector<HTMLButtonElement>('.cordisx-nav-actions button')!
    trailing.click()
    await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.activeRoute).toBeUndefined()
    dom.window.document.querySelector<HTMLElement>('.cordisx-nav-row')!.click()
    await settle()
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ activeRoute: 'slot-showcase:main.analytics', mounted: true })
    expect(dom.window.document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"]')).not.toBeNull()

    await runtime!.navigate('slot-showcase', { id: 'app.overview' })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({ activeRoute: 'slot-showcase:app.overview', mounted: true })
    await runtime!.navigate('slot-showcase', { id: 'session.analytics', params: { sessionId } })
    expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({ activeRoute: 'slot-showcase:session.analytics', mounted: true, contextKey: `session:${sessionId}` })
    await expect(runtime!.navigate('slot-showcase', { id: 'session.analytics', params: { sessionId: 'stale' } })).rejects.toThrow(/does not match native session/)
    expect(dom.window.location.href).toBe('https://codex.local/native')

    dom.window.document.documentElement.lang = 'zh-CN'
    await settle()
    await settle()
    expect(runtime!.snapshot().localization.locale).toBe('zh-CN')
    expect(dom.window.document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"]')?.textContent).toContain('主区域 outlet')

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
    expect(restoredSnapshot.commands.length).toBe(5)
    expect(restoredSnapshot.registrations.filter(item => item.rendered).length).toBe(12)
    expect(restoredSnapshot.platform).toMatchObject({
      mode: 'unavailable',
      secondConnectionCreated: false,
      rawBridgeExposed: false,
      diagnostics: [expect.objectContaining({ code: 'current-connection-client-unavailable' })],
    })
    expect(restoredSnapshot.permissions).toEqual([
      expect.objectContaining({ capability: 'models.read', policy: 'ask', required: false }),
    ])

    const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')
    expect(managerTrigger?.getAttribute('aria-label')).toBe('管理 CordisX 插件')
    expect(managerTrigger?.querySelector('svg')).toBeNull()
    const triggerMark = managerTrigger?.querySelector<HTMLElement>('[data-color-scheme="current-color"]')
    const mask = triggerMark?.style.getPropertyValue('--cordisx-brand-mask') ?? ''
    expect(mask).toMatch(/^url\("data:image\/svg\+xml;charset=utf-8,/)
    expect(decodeURIComponent(mask.slice(mask.indexOf(',') + 1, -2))).toContain('stroke="#030303"')
    expect(dom.window.document.getElementById('cordisx-manager-style')?.textContent).toContain('background: currentColor')
    managerTrigger?.click()
    const managerModal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')
    expect(managerModal?.hidden).toBe(false)
    expect(managerModal?.querySelectorAll('[data-cordisx-brand-mark]')).toHaveLength(1)
    const managerMark = managerModal?.querySelector<HTMLPictureElement>('[data-color-scheme="dark"]')
    expect(managerMark?.querySelectorAll('source')).toHaveLength(0)
    expect(decodeURIComponent(managerMark?.querySelector('img')?.src.split(',')[1] ?? '')).toContain('stroke="#fcfcfc"')
    const managerHeadings = (): string[] => [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-heading h2, .cxm-section-title')]
      .map(element => element.textContent?.trim() ?? '')
    const primaryLeading = dom.window.document.querySelector<HTMLElement>('.cxm-heading-leading')
    expect(primaryLeading?.classList.contains('cxm-heading-icon')).toBe(true)
    expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).width).toBe('26px')
    expect(primaryLeading?.textContent).toBe('◈')
    expect(managerModal?.textContent).toContain('宿主语言')
    expect(managerHeadings()).toEqual(['关于 CordisX', '运行边界'])
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="slots"]')?.click()
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('⊞')
    expect(managerModal?.textContent).toContain('sidebar.footer.before-control')
    expect(managerModal?.textContent).toContain('slot-showcase')
    expect(managerHeadings()).toEqual(['贡献与路由', 'Commands', 'Routes / Pages', 'Host Outlets'])
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
    const search = dom.window.document.querySelector<HTMLInputElement>('.cxm-search')
    if (search !== null) {
      search.value = 'workspace.toolbar.items'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    expect(managerModal?.textContent).toContain('slot-showcase')
    expect(managerModal?.textContent).not.toContain('插件配置')
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('◫')
    expect(managerHeadings()).toEqual(['插件'])

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')?.click()
    const back = dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')
    expect(back?.textContent).toBe('')
    expect(back?.getAttribute('aria-label')).toBe('返回')
    expect(back?.classList.contains('cxm-heading-leading')).toBe(true)
    expect(dom.window.getComputedStyle(back as HTMLElement).width).toBe('26px')
    expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('插件/Slot Showcase')
    expect(dom.window.document.querySelector('.cxm-readme h1')?.textContent).toBe('Slot Showcase')
    expect(managerModal?.textContent).toContain('结构化 UI 端到端演示插件')
    expect(managerModal?.textContent).not.toContain('插件配置')
    expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(5)

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
    expect(managerModal?.textContent).not.toContain('插件配置')
    expect(managerModal?.textContent).toContain('{}')
    expect(managerHeadings()).toEqual(['插件/Slot Showcase'])
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="配置管理"]')).not.toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.click()
    const permissionsPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="权限"]')
    expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
    expect(managerHeadings()).toEqual(['插件/Slot Showcase', '能力声明', '宿主连接'])
    expect(managerHeadings()).not.toContain('Platform 权限')
    expect(permissionsPanel?.textContent).not.toContain('Platform 权限')
    expect(permissionsPanel?.querySelector('.cxm-detail')).toBeNull()
    expect(permissionsPanel?.querySelector('.cxm-slot-card')).toBeNull()
    expect(permissionsPanel?.querySelector('[role="list"][data-manager-group="capability-declarations"]')).not.toBeNull()
    expect(permissionsPanel?.querySelector('[role="listitem"][data-permission-item="models.read"]')?.getAttribute('aria-label')).toBe('Capability models.read')
    expect(managerModal?.textContent).toContain('models.read')
    expect(managerModal?.textContent).toContain('显示当前宿主连接实际可用的模型')
    expect(managerModal?.textContent).toContain('current-connection-client-unavailable')
    expect(managerModal?.textContent).toContain('trusted renderer code 不是安全沙箱')
    expect(permissionsPanel?.textContent?.match(/二次连接/g)).toHaveLength(1)
    expect(permissionsPanel?.textContent?.match(/原始 bridge 暴露/g)).toHaveLength(1)
    expect(permissionsPanel?.textContent?.match(/不是安全沙箱/g)).toHaveLength(1)
    dom.window.document.documentElement.lang = 'zh-CN'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(managerModal?.textContent).toContain('显示当前宿主连接实际可用的模型')
    const permissionPolicy = dom.window.document.querySelector<HTMLSelectElement>('[data-permission-capability="models.read"]')
    if (permissionPolicy !== null) {
      permissionPolicy.value = 'deny'
      permissionPolicy.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    }
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().permissions[0]?.policy !== 'deny'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().permissions[0]?.policy).toBe('deny')
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.click()
    expect(managerModal?.textContent).toContain('注入服务')
    expect(managerHeadings()).toEqual(['插件/Slot Showcase', '本地化', '结构化运行时'])
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"] .cxm-detail-id')?.textContent).toBe('slot-showcase')
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"]')?.textContent?.match(/Slot Showcase/g) ?? []).toHaveLength(0)

    dom.window.document.querySelector<HTMLButtonElement>('.cxm-plugin-runtime-action')?.click()
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'blocked'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().plugins[0]?.status).toBe('blocked')
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toContain('slot-showcase')
    expect(runtime!.snapshot().commands).toEqual([])
    expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-plugin-runtime-action')?.click()
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'active'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toEqual([])
    expect(dom.window.document.querySelector('.cordisx-nav-row')).not.toBeNull()

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="slots"]')?.click()
    expect(managerModal?.textContent).toContain('workspace.toolbar.items')
    expect(managerModal?.textContent).toContain('已渲染')
    expect(managerHeadings()).toEqual(['插件/Slot Showcase'])

    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
    const restoredSearch = dom.window.document.querySelector<HTMLInputElement>('.cxm-search')
    expect(restoredSearch?.value).toBe('workspace.toolbar.items')
    expect(managerModal?.textContent).not.toContain('插件配置')

    if (restoredSearch !== null) {
      restoredSearch.value = ''
      restoredSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="configured-off"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.click()
    const emptyPermissionsPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="权限"]')
    expect(emptyPermissionsPanel?.textContent).toContain('该插件没有声明 capability；宿主连接状态仍在下方显示。')
    expect(emptyPermissionsPanel?.textContent).toContain('当前连接：')
    expect(emptyPermissionsPanel?.querySelector('[role="list"]')).toBeNull()
    expect(emptyPermissionsPanel?.querySelector('section section')).toBeNull()
    expect(managerHeadings().slice(-2)).toEqual(['能力声明', '宿主连接'])
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()

    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')?.click()
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('◇')
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(managerModal?.textContent).toContain('CordisX Community Marketplace')
    expect(managerModal?.textContent).toContain('Slot Showcase Catalog')
    expect(managerModal?.textContent).not.toContain('查看源码')
    expect(managerHeadings()).toEqual(['插件商店'])
    dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin="slot-showcase"]')?.click()
    expect(managerHeadings()).toEqual(['插件商店/Slot Showcase Catalog', '关键词'])
    expect(managerModal?.textContent?.match(/Slot Showcase Catalog/g)).toHaveLength(1)
    expect(managerModal?.textContent).toContain('Marketplace hierarchy fixture')
    expect(managerModal?.textContent).toContain('查看源码')
    expect(managerModal?.querySelector('.cxm-detail')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()

    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')?.click()
    expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('配置')
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('⚙')
    expect(dom.window.document.querySelectorAll('[data-settings-tab]')).toHaveLength(3)
    expect(managerModal?.textContent).not.toContain('插件商店来源')
    expect(managerModal?.textContent).toContain('https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
    expect(managerModal?.textContent).toContain('CordisX Community Marketplace')
    expect(managerModal?.textContent).not.toContain('启动器配置')
    expect(managerHeadings()).toEqual(['配置'])
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="插件商店"]')).not.toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="runtime"]')?.click()
    expect(managerModal?.textContent).not.toContain('插件运行状态')
    expect(managerModal?.textContent).toContain('当前隔离 Chromium profile')
    expect(managerHeadings()).toEqual(['配置'])
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"]')).not.toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="launcher"]')?.click()
    expect(managerModal?.textContent).not.toContain('启动器配置')
    expect(managerHeadings()).toEqual(['配置'])
    expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="启动器"]')).not.toBeNull()

    await runtime?.dispose()
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-page-outlet]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-brand-mark]')).toBeNull()
    expect(dom.window.document.getElementById('cordisx-manager-style')).toBeNull()
    expect(native.parentElement).toBe(nativeParent)
    dom.window.close()
  })
})
