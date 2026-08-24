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

function extensionPoints(locale: 'en' | 'zh-CN'): ExtensionPointRuntimeSnapshot {
  const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
  descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  descriptors.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
  const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
  const i18n = {
    resolveFor: (owner: string, message: { namespace?: string; key: string; fallback?: string }) => {
      const namespace = message.namespace ?? owner
      const catalog = CORDISX_EXTENSION_POINT_LOCALE_CATALOGS.find(item => (
        item.namespace === namespace && item.locale === locale
      ))
      const text = (catalog?.messages as Readonly<Record<string, string | undefined>> | undefined)?.[message.key]
        ?? message.fallback
        ?? '[[' + namespace + ':' + message.key + ']]'
      return { text, namespace, key: message.key, locale }
    },
    clearDiagnosticSite: () => {},
  } as unknown as CordisXI18nService
  const built = buildExtensionPointRuntimeSnapshot({
    descriptors,
    broker,
    i18n,
    plugins: [],
    registrations: [],
    commands: [],
    navigation: {
      routes: [],
      pages: [],
      outlets: [
        { id: 'app', placement: 'application', available: true, mounted: false, presentation: 'inactive' },
        { id: 'main', placement: 'main', available: true, mounted: false, presentation: 'inactive' },
        { id: 'session.content', placement: 'session', available: true, mounted: false, presentation: 'inactive' },
        { id: 'manager.settings.content', placement: 'manager-settings', available: true, mounted: false, presentation: 'inactive' },
      ],
    },
    surfaceAvailability: [
      { surface: 'session.header.actions', state: 'pending', code: 'seat-pending', detail: 'No unique seat.' },
      { surface: 'sidebar.footer.before-control', state: 'unavailable', code: 'seat-unavailable', detail: 'Seat unavailable.' },
      { surface: 'composer.toolbar.items', state: 'available' },
    ],
  })
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
      expect(list.querySelectorAll('[data-extension-point-id]')).toHaveLength(35)
      expect(list.querySelector('.cxm-kind-badge')).toBeNull()
      expect(list.querySelector('.cxm-chevron')).toBeNull()

      const available = list.querySelector<HTMLButtonElement>('[data-extension-point-id="composer.toolbar.items"]')!
      expect(available.dataset.extensionPointState).toBe('available')
      expect(available.querySelector('.cxm-catalog-status')).toBeNull()
      expect(available.querySelector('.cxm-catalog-title')?.textContent).toBe('输入区工具栏')
      expect(available.querySelector('.cxm-catalog-description')?.textContent).toContain('语义输入区锚点')
      expect(available.querySelector('code')?.textContent).toBe('composer.toolbar.items')
      expect(available.querySelector('[data-host-icon]')?.getAttribute('aria-hidden')).toBe('true')

      const pending = list.querySelector<HTMLButtonElement>('[data-extension-point-id="session.header.actions"]')!
      expect(pending.dataset.extensionPointState).toBe('pending')
      expect(pending.querySelector('.cxm-catalog-status')?.textContent).toBe('待定位')
      expect(pending.children).toHaveLength(3)

      const unavailable = list.querySelector<HTMLButtonElement>('[data-extension-point-id="sidebar.footer.before-control"]')!
      expect(unavailable.dataset.extensionPointState).toBe('unavailable')
      expect(unavailable.querySelector('.cxm-catalog-status')?.textContent).toBe('不可用')

      const error = list.querySelector<HTMLButtonElement>('[data-extension-point-id="workspace.toolbar.items"]')!
      expect(error.dataset.extensionPointState).toBe('error')
      expect(error.querySelector('.cxm-catalog-status')?.textContent).toBe('需要处理')

      const styles = [...dom.window.document.querySelectorAll('style')].map(item => item.textContent ?? '').join('\n')
      expect(styles).toContain('.cxm-catalog-row {\n    display: flex;')
      expect(styles).toContain('.cxm-catalog-status { display: inline-flex;')
      expect(styles).toContain('user-select: text')
      expect(styles).not.toContain('.cxm-catalog-row {\n    display: grid;')

      pending.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(dom.window.document.querySelector('[data-extension-point-detail-tab="diagnostics"]')?.getAttribute('aria-selected')).toBe('true')
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')!.click()

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="extension-points"] input')!
      search.value = '输入区工具栏'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelectorAll('[data-extension-point-id]')).toHaveLength(1)
      expect(dom.window.document.querySelector('[data-extension-point-id="composer.toolbar.items"]')).not.toBeNull()

      state = managerSnapshot('en')
      for (const listener of listeners) listener()
      expect(dom.window.document.querySelectorAll('[data-extension-point-id]')).toHaveLength(0)
      const reprojectedSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="extension-points"] input')!
      reprojectedSearch.value = 'Composer toolbar'
      reprojectedSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-extension-point-id="composer.toolbar.items"] .cxm-catalog-title')?.textContent).toBe('Composer toolbar')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
