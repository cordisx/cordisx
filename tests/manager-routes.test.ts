import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'

function snapshot(locale: 'en' | 'zh-CN'): ManagerSnapshot {
  const zh = locale === 'zh-CN'
  const product = (kind: 'documented' | 'legacy', resource: 'route' | 'page') => {
    if (kind === 'legacy') {
      return {
        ...(resource === 'page' ? { title: zh ? '旧页面' : 'Legacy page' } : {}),
        diagnostics: [
          ...(resource === 'route'
            ? [{
              code: 'metadata.missing-title' as const,
              field: 'title' as const,
              message: 'route demo:legacy should declare localized title metadata',
            }]
            : []),
          {
            code: 'metadata.missing-description' as const,
            field: 'description' as const,
            message: `${resource} demo:legacy should declare localized description metadata`,
          },
        ],
      }
    }
    return {
      title: resource === 'route'
        ? (zh ? '打开工作区分析' : 'Open workspace analytics')
        : (zh ? '工作区分析' : 'Workspace analytics'),
      description: resource === 'route'
        ? (zh
          ? '从插件导航进入，在主区域查看工作区分析。'
          : 'Open from plugin navigation to review workspace analytics in the main area.')
        : (zh ? '展示当前工作区的结构化分析内容。' : 'Shows structured analytics for the current workspace.'),
      diagnostics: [],
    }
  }
  return {
    version: 'test',
    plugins: [{
      id: 'demo',
      source: 'file:///plugins/demo/index.ts',
      name: 'Demo',
      inject: [],
      config: {},
      status: 'active',
      configuration: {
        namespace: 'demo',
        schemaKind: 'none',
        applies: 'plugin-restart',
        writable: false,
        revision: 0,
        lastGoodRevision: 0,
        value: {},
        fields: [],
        secrets: [],
      },
    }],
    registrations: [],
    commands: [],
    navigation: {
      routes: [
        {
          owner: 'demo',
          id: 'analytics',
          qualifiedId: 'demo:analytics',
          definition: { id: 'analytics', path: '/main/analytics/:workspaceId', outlet: 'main', page: 'analytics' },
          productMetadata: product('documented', 'route'),
          valid: true,
          authorized: true,
          pointPolicy: 'inherit',
          effectivePointPolicy: 'allow',
        },
        {
          owner: 'demo',
          id: 'legacy',
          qualifiedId: 'demo:legacy',
          definition: { id: 'legacy', path: '/legacy', outlet: 'app', page: 'legacy' },
          productMetadata: product('legacy', 'route'),
          valid: true,
          authorized: true,
          pointPolicy: 'inherit',
          effectivePointPolicy: 'allow',
        },
      ],
      pages: [
        {
          owner: 'demo',
          id: 'analytics',
          qualifiedId: 'demo:analytics',
          metadata: {
            id: 'analytics',
            title: { key: 'page.analytics.title' },
            description: { key: 'page.analytics.description' },
          },
          productMetadata: product('documented', 'page'),
        },
        {
          owner: 'demo',
          id: 'legacy',
          qualifiedId: 'demo:legacy',
          metadata: { id: 'legacy', title: { key: 'page.legacy.title' }, chrome: 'body-only' },
          productMetadata: product('legacy', 'page'),
        },
      ],
      outlets: [],
    },
    localization: { locale, direction: 'ltr', version: zh ? 2 : 1 },
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

describe('Manager route and page catalog', () => {
  it('projects compact route/page cards, searches the live locale, and diagnoses legacy omissions', () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', {
      url: 'https://codex.local/',
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
      dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')!.hidden = false
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="routes"]')!.click()
      const catalog = dom.window.document.querySelector<HTMLElement>('.cxm-content')!
      expect(dom.window.document.querySelector('.cxm-heading-leading')?.getAttribute('data-host-icon-key')).toBe(
        'routes',
      )
      expect(dom.window.document.querySelector('.cxm-heading .cxm-back')).toBeNull()
      const visibleCount = (selector: string): number =>
        [...dom.window.document.querySelectorAll<HTMLElement>(selector)]
          .filter(item => !item.closest<HTMLElement>('[data-collection-item]')?.hidden).length
      expect(catalog.querySelector('[data-host-collection="routes"]')).not.toBeNull()
      expect(catalog.querySelector<HTMLElement>('[data-host-collection="routes"]')?.dataset.density).toBe('compact')
      expect(catalog.querySelectorAll('[data-route-product-row]')).toHaveLength(2)
      expect(catalog.querySelectorAll('[data-page-product-row]')).toHaveLength(2)
      expect(
        catalog.querySelectorAll(
          '[data-route-product-row] .cxc-icon-seat button, [data-page-product-row] .cxc-icon-seat button',
        ),
      ).toHaveLength(0)
      const catalogSearch = catalog.querySelector<HTMLInputElement>('[data-collection-search="routes"]')!
      expect(catalogSearch.placeholder).toBe('搜索标题、说明、位置、页面或插件…')
      expect(catalogSearch.placeholder).not.toContain('outlet')
      catalogSearch.value = 'Shows structured analytics'
      catalogSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(visibleCount('[data-route-product-row]')).toBe(0)
      expect(visibleCount('[data-page-product-row]')).toBe(0)
      const localeSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="routes"]')!
      localeSearch.value = '展示当前工作区'
      localeSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(visibleCount('[data-route-product-row]')).toBe(0)
      expect(visibleCount('[data-page-product-row]')).toBe(1)
      const resetCatalog = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="routes"]')!
      resetCatalog.value = ''
      resetCatalog.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      dom.window.document.querySelector<HTMLButtonElement>('[data-route-product-row="demo:analytics"]')!.click()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-back')).not.toBeNull()
      const routeDetailIcons = [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-route-card-icon')]
      expect(routeDetailIcons.map(icon => icon.dataset.hostIconKey)).toEqual(['routes', 'document'])
      expect(routeDetailIcons.every(icon => icon.tagName === 'SPAN' && icon.getAttribute('aria-hidden') === 'true'))
        .toBe(true)
      expect(routeDetailIcons.every(icon => icon.querySelector('button') === null)).toBe(true)
      expect(dom.window.document.querySelectorAll('.cxm-route-card button')).toHaveLength(0)
      expect(dom.window.document.querySelector('.cxm-heading > p')).toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')!.click()

      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="demo"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="routes"]')!.click()

      const panel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="路由"]')!
      expect(panel.querySelector('[data-host-collection="plugin-routes-demo"]')).not.toBeNull()
      expect(panel.querySelectorAll('[data-route-product-row]')).toHaveLength(2)
      expect(panel.querySelectorAll('[data-page-product-row]')).toHaveLength(2)
      expect(panel.querySelector('[data-route-product-row="demo:analytics"] .cxc-title')?.textContent).toBe(
        '打开工作区分析',
      )
      expect(panel.querySelector('[data-route-product-row="demo:analytics"] .cxc-description')?.textContent)
        .toContain('从插件导航进入')
      expect(panel.querySelector('[data-page-product-row="demo:analytics"] .cxc-description')?.textContent)
        .toBe('展示当前工作区的结构化分析内容。')
      expect(panel.textContent).not.toContain('/main/analytics/:workspaceId')
      expect(panel.textContent).not.toContain('body-only')
      expect(panel.querySelector('.cxm-kind-badge')).toBeNull()
      expect(panel.querySelector('.cxm-chevron')).toBeNull()
      expect(panel.textContent).not.toContain('受控页面 mount')
      expect(panel.querySelector('[data-route-product-row="demo:legacy"] .cxc-title')?.textContent).toBe('demo:legacy')
      expect(panel.querySelector('[data-route-product-row="demo:legacy"] .cxc-description')?.textContent).toBe(
        '未提供说明',
      )
      expect(panel.querySelector('[data-route-product-row="demo:legacy"] .cxc-status')?.getAttribute('aria-label'))
        .toBe('内容信息待补充')
      expect(panel.querySelector('[data-page-product-row="demo:legacy"] .cxc-status')?.getAttribute('aria-label')).toBe(
        '内容信息待补充',
      )
      expect(panel.querySelectorAll('[role="list"]')).toHaveLength(1)
      expect([...panel.querySelectorAll('[role="listitem"]')].every(item => item.closest('[role="list"]') !== null))
        .toBe(true)

      const search = panel.querySelector<HTMLInputElement>('[data-collection-search="plugin-routes-demo"]')!
      expect(search.placeholder).toBe('搜索标题、说明、位置、页面或 id…')
      expect(search.placeholder).not.toContain('outlet')
      search.value = '主区域查看工作区'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(visibleCount('[data-route-product-row]')).toBe(1)
      expect(visibleCount('[data-page-product-row]')).toBe(0)
      const projectedSearch = dom.window.document.querySelector<HTMLInputElement>(
        '[data-collection-search="plugin-routes-demo"]',
      )!
      projectedSearch.value = '找不到的页面'
      projectedSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="路由"] .cxc-empty')?.textContent).toBe(
        '没有匹配的路由或页面',
      )

      const clearSearch = dom.window.document.querySelector<HTMLInputElement>(
        '[data-collection-search="plugin-routes-demo"]',
      )!
      clearSearch.value = ''
      clearSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      state = snapshot('en')
      for (const listener of listeners) listener()
      const enPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="Routes"]')!
      expect(enPanel.querySelector('[data-route-product-row="demo:analytics"] .cxc-title')?.textContent).toBe(
        'Open workspace analytics',
      )
      expect(enPanel.querySelector('[data-page-product-row="demo:analytics"] .cxc-description')?.textContent)
        .toBe('Shows structured analytics for the current workspace.')
      expect(enPanel.querySelector('[data-route-product-row="demo:legacy"] .cxc-description')?.textContent).toBe(
        'No description provided',
      )

      const styles = dom.window.document.getElementById('cordisx-manager-style')?.textContent ?? ''
      expect(styles).toContain('repeat(auto-fit, minmax(min(100%, 220px), 1fr))')
      expect(styles).toContain('.cxc-machine-id')
      expect(styles).toContain(
        '.cxm-route-card-icon { display: grid; place-items: center; width: var(--cx-compact-list-icon-seat);',
      )
      expect(styles).toContain(
        '.cxm-route-card-icon svg { width: var(--cx-compact-list-icon-glyph); height: var(--cx-compact-list-icon-glyph); }',
      )
      expect(styles).toContain('--cx-manager-header-leading-seat: 26px;')
      expect(styles).toContain('--cx-manager-header-leading-glyph: 18px;')
      expect(styles).toContain('--cx-manager-header-title-size: 16px;')
      expect(styles).toContain('--cx-manager-header-title-line-height: 26px;')
      expect(styles).toContain(
        '.cxm-breadcrumb-list { display: flex; min-width: 0; min-height: var(--cx-manager-header-leading-seat);',
      )
      expect(styles).toContain('line-height: calc(var(--cx-manager-header-title-line-height) - 4px);')
      expect(styles).toContain('.cxm-close { background: transparent; color: var(--cx-text); }')
      expect(styles).toContain('.cxm-close:hover { background: var(--cx-hover); color: var(--cx-text); }')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
