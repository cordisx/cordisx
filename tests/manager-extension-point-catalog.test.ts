import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
  buildExtensionPointRuntimeSnapshot,
  type ExtensionPointRuntimeSnapshot,
} from '../packages/cli/src/renderer/extension-points.js'
import type { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'

function extensionPoints(locale: 'en' | 'zh-CN', withUsage = false): ExtensionPointRuntimeSnapshot {
  const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
  descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  descriptors.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
  const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
  const i18n = {
    getSnapshot: () => ({ locale, direction: 'ltr', version: 1 }),
    resolveFor: (owner: string, message: { namespace?: string; key: string; fallback?: string }) => {
      const namespace = message.namespace ?? owner
      const catalog = CORDISX_EXTENSION_POINT_LOCALE_CATALOGS.find(item => (
        item.namespace === namespace && item.locale === locale
      ))
      const contributionText = message.key === 'action.label'
        ? locale === 'zh-CN' ? '提交前刷新' : 'Refresh before submit'
        : message.key === 'action.description'
          ? locale === 'zh-CN' ? '在提交前刷新当前数据。' : 'Refresh current data before submit.'
          : undefined
      const text = contributionText
        ?? (catalog?.messages as Readonly<Record<string, string | undefined>> | undefined)?.[message.key]
        ?? message.fallback
        ?? '[[' + namespace + ':' + message.key + ']]'
      return { text, namespace, key: message.key, locale }
    },
    clearDiagnosticSite: () => {},
  } as unknown as CordisXI18nService
  const source = 'https://plugins.example/showcase'
  const unregister = withUsage ? broker.register({ source, id: 'showcase' }) : () => {}
  const built = buildExtensionPointRuntimeSnapshot({
    descriptors,
    broker,
    i18n,
    plugins: withUsage ? [{ id: 'showcase', source, name: 'Showcase', description: '演示提交前刷新操作。', status: 'active' }] : [],
    registrations: withUsage ? [{
      owner: 'showcase', id: 'submit-before', qualifiedId: 'showcase:submit-before',
      surface: 'composer.toolbar.items', group: 'default', order: 0,
      item: {
        label: { namespace: 'showcase:messages', key: 'action.label', fallback: 'Refresh before submit' },
        description: { namespace: 'showcase:messages', key: 'action.description', fallback: 'Refresh current data before submit.' },
        anchor: 'submit', placement: 'before', command: { id: 'refresh' },
      },
      visible: true, authorized: true, pointPolicy: 'inherit', effectivePointPolicy: 'allow',
      disabled: false, valid: true, pending: false, currentContext: 'active', rendered: true,
    }] : [],
    commands: [],
    navigation: {
      routes: [],
      pages: [],
      outlets: [
        { id: 'app', placement: 'application', available: true, mounted: false, presentation: 'inactive' },
        { id: 'main', placement: 'main', available: true, mounted: false, presentation: 'inactive' },
        { id: 'session.content', placement: 'session', available: true, mounted: false, presentation: 'inactive' },
        { id: 'manager.settings.content', placement: 'manager-settings', available: true, mounted: false, presentation: 'inactive' },
        { id: 'manager.content', placement: 'manager', available: false, mounted: false, presentation: 'inactive' },
      ],
    },
    surfaceCurrentContext: [
      { surface: 'session.header.actions', state: 'not-mounted', code: 'session.not-mounted', detail: { key: 'session.not-mounted', fallback: 'No session page is mounted.' } },
      { surface: 'sidebar.footer.before-control', state: 'not-mounted', code: 'sidebar.not-mounted', detail: { key: 'sidebar.not-mounted', fallback: 'The sidebar is not mounted.' } },
      { surface: 'composer.toolbar.items', state: 'active' },
    ],
  })
  unregister()
  broker.dispose()
  descriptors.dispose()
  return {
    ...built,
    points: built.points.map(point => point.id === 'workspace.toolbar.items'
      ? { ...point, titleProjection: { ...point.titleProjection, diagnostic: 'missing-key' as const } }
      : point),
  }
}

function managerSnapshot(locale: 'en' | 'zh-CN'): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale, direction: 'ltr', version: locale === 'en' ? 1 : 2 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable',
      supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
    extensionPoints: extensionPoints(locale),
  }
}

describe('Manager extension point catalog', () => {
  it('renders the complete localized catalog without normal/type tags or orphan status rows', () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    let state = managerSnapshot('zh-CN')
    const listeners = new Set<() => void>()
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="extension-points"]')!.click()
      const list = dom.window.document.querySelector<HTMLElement>('[aria-label="扩展点列表"]')!
      expect(list.querySelectorAll('[data-extension-point-id]')).toHaveLength(37)
      expect(list.querySelector('.cxm-kind-badge')).toBeNull()
      expect(list.querySelector('.cxm-chevron')).toBeNull()

      const available = list.querySelector<HTMLButtonElement>('[data-extension-point-id="composer.toolbar.items"]')!
      expect(available.dataset.extensionPointState).toBe('supported')
      expect(available.querySelector('.cxc-status')).toBeNull()
      expect(available.querySelector('.cxc-title')?.textContent).toBe('输入区工具栏')
      expect(available.querySelector('.cxc-description')?.textContent).toContain('语义输入区锚点')
      expect(available.querySelector('code')?.textContent).toBe('composer.toolbar.items')
      expect(available.querySelector('[data-host-icon]')?.getAttribute('aria-hidden')).toBe('true')

      const contextAbsent = list.querySelector<HTMLButtonElement>('[data-extension-point-id="session.header.actions"]')!
      expect(contextAbsent.dataset.extensionPointState).toBe('supported')
      expect(contextAbsent.querySelector('.cxc-status')).toBeNull()
      expect(contextAbsent.children).toHaveLength(2)

      const pending = list.querySelector<HTMLButtonElement>('[data-extension-point-id="composer.command-menu.items"]')!
      expect(pending.dataset.extensionPointState).toBe('pending')
      expect(pending.querySelector('.cxc-status')?.getAttribute('aria-label')).toBe('待定位')

      const unavailable = list.querySelector<HTMLButtonElement>('[data-extension-point-id="panel.right.content"]')!
      expect(unavailable.dataset.extensionPointState).toBe('unavailable')
      expect(unavailable.querySelector('.cxc-status')?.getAttribute('aria-label')).toBe('不可用')

      const error = list.querySelector<HTMLButtonElement>('[data-extension-point-id="workspace.toolbar.items"]')!
      expect(error.dataset.extensionPointState).toBe('error')
      expect(error.querySelector('.cxc-status')?.getAttribute('aria-label')).toBe('需要处理')

      const styles = [...dom.window.document.querySelectorAll('style')].map(item => item.textContent ?? '').join('\n')
      expect(styles).toContain('.cxc-list {')
      expect(styles).toContain('.cxc-status {')
      expect(styles).toContain('user-select: text')
      expect(styles).toContain('repeat(auto-fit, minmax(min(100%, 220px), 1fr))')

      pending.click()
      expect(dom.window.document.querySelector('[data-extension-point-detail-tab="diagnostics"]')?.getAttribute('aria-selected')).toBe('true')
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')!.click()

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="extension-points"]')!
      search.value = '输入区工具栏'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-extension-point-id]')].filter(item => !item.closest<HTMLElement>('[data-collection-item]')?.hidden)).toHaveLength(1)
      expect(dom.window.document.querySelector('[data-extension-point-id="composer.toolbar.items"]')).not.toBeNull()

      state = managerSnapshot('en')
      for (const listener of listeners) listener()
      expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-extension-point-id]')].filter(item => !item.closest<HTMLElement>('[data-collection-item]')?.hidden)).toHaveLength(0)
      const reprojectedSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="extension-points"]')!
      reprojectedSearch.value = 'Composer toolbar'
      reprojectedSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-extension-point-id="composer.toolbar.items"] .cxc-title')?.textContent).toBe('Composer toolbar')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('renders localized contribution names in a compact searchable sublist without placeholder cards', () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    const state = { ...managerSnapshot('zh-CN'), extensionPoints: extensionPoints('zh-CN', true) }
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
      setExtensionPointPolicy: async () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="extension-points"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-extension-point-id="composer.toolbar.items"]')!.click()
      const panel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="使用情况"]')!
      expect(panel.querySelector('[data-list-search^="extension-point-usage-"]')).not.toBeNull()
      expect(panel.querySelector('.cxm-usage-item .cxm-plugin-name')?.textContent).toBe('Showcase')
      expect(panel.querySelector('.cxm-plugin-description')?.textContent).toBe('演示提交前刷新操作。')
      expect(panel.querySelector('.cxm-usage-item .cxm-catalog-id')?.textContent).toBe('showcase')
      const contribution = panel.querySelector<HTMLElement>('[data-contribution-id="submit-before"]')!
      expect(contribution.querySelector('.cxm-resource-title')?.textContent).toBe('提交前刷新')
      expect(contribution.querySelector('.cxm-resource-description')?.textContent).toBe('在提交前刷新当前数据。 · 已渲染')
      expect(contribution.querySelector('.cxm-resource-id')?.textContent).toBe('submit-before')
      expect(contribution.querySelector('.cxm-slot-card, .cxm-kind-badge, .cxm-chevron')).toBeNull()
      const styles = dom.window.document.getElementById('cordisx-manager-style')?.textContent ?? ''
      expect(styles).toContain('.cxm-usage-item { padding: 12px 2px; }')
      expect(styles).toContain('.cxm-resource-row + .cxm-resource-row { border-top:')
      expect(styles).toContain('.cxm-resource-id { grid-column: 2; grid-row: 1 / span 2;')

      const search = panel.querySelector<HTMLInputElement>('.cxm-search')!
      search.value = '刷新'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-contribution-id="submit-before"]')).not.toBeNull()
      const replacement = dom.window.document.querySelector<HTMLInputElement>('[data-list-search^="extension-point-usage-"] .cxm-search')!
      replacement.value = 'missing'
      replacement.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-contribution-id]')).toBeNull()
      expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="使用情况"]')?.textContent).toContain('没有匹配的插件或贡献')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
