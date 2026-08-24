import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'

function snapshot(locale: 'en' | 'zh-CN'): ManagerSnapshot {
  const zh = locale === 'zh-CN'
  const product = (kind: 'documented' | 'legacy', resource: 'route' | 'page') => {
    if (kind === 'legacy') return {
      ...(resource === 'page' ? { title: zh ? '旧页面' : 'Legacy page' } : {}),
      diagnostics: [
        ...(resource === 'route' ? [{
          code: 'metadata.missing-title' as const,
          field: 'title' as const,
          message: 'route demo:legacy should declare localized title metadata',
        }] : []),
        {
          code: 'metadata.missing-description' as const,
          field: 'description' as const,
          message: `${resource} demo:legacy should declare localized description metadata`,
        },
      ],
    }
    return {
      title: resource === 'route'
        ? (zh ? '打开工作区分析' : 'Open workspace analytics')
        : (zh ? '工作区分析' : 'Workspace analytics'),
      description: resource === 'route'
        ? (zh ? '从插件导航进入，在主区域查看工作区分析。' : 'Open from plugin navigation to review workspace analytics in the main area.')
        : (zh ? '展示当前工作区的结构化分析内容。' : 'Shows structured analytics for the current workspace.'),
      diagnostics: [],
    }
  }
  return {
    version: 'test',
    plugins: [{
      id: 'demo', source: 'file:///plugins/demo/index.ts', name: 'Demo', inject: [], config: {}, status: 'active',
      configuration: {
        namespace: 'demo', schemaKind: 'none', applies: 'restart', writable: false,
        revision: 0, lastGoodRevision: 0, value: {}, fields: [], secrets: [],
      },
    }],
    registrations: [],
    commands: [],
    navigation: {
      routes: [
        {
          owner: 'demo', id: 'analytics', qualifiedId: 'demo:analytics',
          definition: { id: 'analytics', path: '/main/analytics/:workspaceId', outlet: 'main', page: 'analytics' },
          productMetadata: product('documented', 'route'),
          valid: true, authorized: true, pointPolicy: 'inherit', effectivePointPolicy: 'allow',
        },
        {
          owner: 'demo', id: 'legacy', qualifiedId: 'demo:legacy',
          definition: { id: 'legacy', path: '/legacy', outlet: 'app', page: 'legacy' },
          productMetadata: product('legacy', 'route'),
          valid: true, authorized: true, pointPolicy: 'inherit', effectivePointPolicy: 'allow',
        },
      ],
      pages: [
        {
          owner: 'demo', id: 'analytics', qualifiedId: 'demo:analytics',
          metadata: { id: 'analytics', title: { key: 'page.analytics.title' }, description: { key: 'page.analytics.description' } },
          productMetadata: product('documented', 'page'),
        },
        {
          owner: 'demo', id: 'legacy', qualifiedId: 'demo:legacy',
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
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable', supportedCapabilities: [],
      diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
  }
}

describe('Manager route and page catalog', () => {
  it('groups route/page product metadata, searches the live locale, and diagnoses legacy omissions', () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
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
      dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')!.hidden = false
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="routes"]')!.click()
      const catalog = dom.window.document.querySelector<HTMLElement>('.cxm-content')!
      expect([...catalog.querySelectorAll('.cxm-route-section-heading')].map(item => item.textContent)).toEqual(['路由', '页面'])
      expect(catalog.querySelectorAll('[data-route-product-row]')).toHaveLength(2)
      expect(catalog.querySelectorAll('[data-page-product-row]')).toHaveLength(2)
      const catalogSearch = catalog.querySelector<HTMLInputElement>('[data-list-search="routes"] .cxm-search')!
      catalogSearch.value = 'Shows structured analytics'
      catalogSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelectorAll('[data-route-product-row]')).toHaveLength(0)
      expect(dom.window.document.querySelectorAll('[data-page-product-row]')).toHaveLength(0)
      const localeSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="routes"] .cxm-search')!
      localeSearch.value = '展示当前工作区'
      localeSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelectorAll('[data-route-product-row]')).toHaveLength(0)
      expect(dom.window.document.querySelectorAll('[data-page-product-row]')).toHaveLength(1)
      const resetCatalog = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="routes"] .cxm-search')!
      resetCatalog.value = ''
      resetCatalog.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="demo"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="routes"]')!.click()

      const panel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="路由"]')!
      expect([...panel.querySelectorAll('.cxm-route-section-heading')].map(item => item.textContent)).toEqual(['路由', '页面'])
      expect(panel.querySelectorAll('[data-route-product-row]')).toHaveLength(2)
      expect(panel.querySelectorAll('[data-page-product-row]')).toHaveLength(2)
      expect(panel.querySelector('[data-route-product-row="demo:analytics"] .cxm-route-card-title')?.textContent).toBe('打开工作区分析')
      expect(panel.querySelector('[data-route-product-row="demo:analytics"] .cxm-route-card-description')?.textContent)
        .toContain('从插件导航进入')
      expect(panel.querySelector('[data-page-product-row="demo:analytics"] .cxm-route-card-description')?.textContent)
        .toBe('展示当前工作区的结构化分析内容。')
      expect(panel.textContent).toContain('/main/analytics/:workspaceId')
      expect(panel.textContent).toContain(':workspaceId')
      expect(panel.textContent).toContain('body-only')
      expect(panel.querySelector('.cxm-kind-badge')).toBeNull()
      expect(panel.querySelector('.cxm-chevron')).toBeNull()
      expect(panel.textContent).not.toContain('受控页面 mount')
      expect(panel.querySelector('[data-route-product-row="demo:legacy"] .cxm-route-card-title')?.textContent).toBe('demo:legacy')
      expect(panel.querySelector('[data-route-product-row="demo:legacy"] .cxm-route-card-description')?.textContent).toBe('未提供说明')
      expect(panel.querySelector('[data-route-product-row="demo:legacy"] [data-metadata-diagnostic="title,description"]')?.textContent)
        .toContain('贡献作者应补充本地化标题、说明 metadata')
      expect(panel.querySelector('[data-page-product-row="demo:legacy"] [data-metadata-diagnostic="description"]')?.textContent)
        .toContain('贡献作者应补充本地化说明 metadata')
      expect(panel.querySelectorAll('[role="list"]')).toHaveLength(2)
      expect([...panel.querySelectorAll('[role="listitem"]')].every(item => item.closest('[role="list"]') !== null)).toBe(true)

      const search = panel.querySelector<HTMLInputElement>('[data-list-search="plugin-routes-demo"] .cxm-search')!
      search.value = '主区域查看工作区'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelectorAll('[data-route-product-row]')).toHaveLength(1)
      expect(dom.window.document.querySelectorAll('[data-page-product-row]')).toHaveLength(0)
      const projectedSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="plugin-routes-demo"] .cxm-search')!
      projectedSearch.value = '找不到的页面'
      projectedSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="路由"] .cxm-empty')?.textContent).toBe('没有匹配的路由或页面')

      const clearSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="plugin-routes-demo"] .cxm-search')!
      clearSearch.value = ''
      clearSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      state = snapshot('en')
      for (const listener of listeners) listener()
      const enPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="路由"]')!
      expect(enPanel.querySelector('[data-route-product-row="demo:analytics"] .cxm-route-card-title')?.textContent).toBe('Open workspace analytics')
      expect(enPanel.querySelector('[data-page-product-row="demo:analytics"] .cxm-route-card-description')?.textContent)
        .toBe('Shows structured analytics for the current workspace.')
      expect(enPanel.querySelector('[data-route-product-row="demo:legacy"] .cxm-route-card-description')?.textContent).toBe('No description provided')

      const styles = dom.window.document.getElementById('cordisx-manager-style')?.textContent ?? ''
      expect(styles).toContain('.cxm-route-group { overflow: hidden; border: 1px solid var(--cx-border); border-radius: 12px;')
      expect(styles).toContain('.cxm-route-machine { display: grid; grid-template-columns: minmax(0, 1fr);')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
