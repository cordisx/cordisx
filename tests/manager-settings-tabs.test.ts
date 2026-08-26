import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CORDISX_BUILTIN_MANAGER_SETTINGS_TABS, installCordisXManager, type ManagerModel, type ManagerSettingsNavigationItemSnapshot, type ManagerSettingsTabSnapshot, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagedManagerPageMount } from '../packages/cli/src/renderer/navigation.js'

function modelSnapshot(items: readonly ManagerSettingsNavigationItemSnapshot[] = [], tabs: readonly ManagerSettingsTabSnapshot[] = []): ManagerSnapshot {
  return {
    version: '0.1.0', plugins: [{ id: 'demo', source: 'file:///demo', name: 'Demo', inject: [], config: {}, configuration: { applies: 'plugin-restart', fields: [], revision: 0, writable: true }, status: 'active' }],
    registrations: [], commands: [], navigation: { routes: [], pages: [], outlets: [{ id: 'manager.settings.content', available: false, mounted: false, presentation: 'inactive' }] },
    localization: { locale: 'en', direction: 'ltr', version: 1 }, localeCatalogs: [], localizationDiagnostics: [], permissions: [], settingsTabs: tabs, settingsNavigationItems: items,
    platform: { hostId: 'test', hostName: 'test', mode: 'unavailable', supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false },
  }
}

function item(overrides: Partial<ManagerSettingsNavigationItemSnapshot> = {}): ManagerSettingsNavigationItemSnapshot {
  return {
    id: 'demo:navigation', owner: 'demo', group: 'after-settings', order: 160, disabled: false,
    title: 'Demo settings', description: 'Host-rendered Manager destination.', pageTitle: 'Demo settings', pageDescription: 'Host header and controlled plugin body.',
    icon: 'host:settings', route: { id: 'navigation' }, ...overrides,
  }
}

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

function managerDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div></body></html>', { url: 'https://codex.local/' })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  return dom
}

describe('Manager settings navigation projection', () => {
  it('keeps A descriptor compatibility but exposes no global Settings page, row, or mount', () => {
    const dom = managerDom()
    const legacy: ManagerSettingsTabSnapshot = { id: 'demo:legacy', owner: 'demo', title: 'Legacy', icon: 'host:settings', order: 1, disabled: false, builtin: false, route: { id: 'legacy' } }
    let mounts = 0
    const manager: ManagerModel = { snapshot: () => modelSnapshot([], [legacy]), setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {}, mountSettingsTab: async () => { mounts += 1; throw new Error('not mounted') } }
    const dispose = installCordisXManager(dom.window.document, manager)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-back')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-heading-icon')?.getAttribute('data-material-icon')).toBe('plugins')
      expect(CORDISX_BUILTIN_MANAGER_SETTINGS_TABS).toEqual([])
      expect(dom.window.document.querySelector('[data-tab="settings"],[data-settings-tab],[data-settings-navigation-item]')).toBeNull()
      expect(mounts).toBe(0)
    } finally { dispose(); dom.window.close() }
  })

  it('renders B through a Host row and controlled body, then aborts on Manager close', async () => {
    const dom = managerDom()
    const events: string[] = []
    let body: HTMLElement | undefined
    const manager: ManagerModel = {
      snapshot: () => modelSnapshot([item()]), setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
      mountManagerContent: async (id, _reference, container): Promise<ManagedManagerPageMount> => {
        body = container.ownerDocument.createElement('section'); body.dataset.demoBody = id; container.append(body); const controller = new AbortController(); events.push(`mount:${id}`)
        return { owner: 'demo', contributionId: id, routeId: id, pageId: id, signal: controller.signal, abort: () => { controller.abort(); events.push(`abort:${id}`) }, dispose: async () => body?.remove() }
      }, closeManagerContent: async () => { body?.remove(); events.push('close') },
    }
    const dispose = installCordisXManager(dom.window.document, manager)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      const entry = dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="demo:navigation"]')!
      expect(entry.querySelector('[data-host-icon="host:settings"]')).not.toBeNull(); expect(entry.querySelector('style,section')).toBeNull()
      entry.click(); await settle()
      expect(dom.window.document.querySelector('[data-demo-body="demo:navigation"]')).not.toBeNull(); expect(dom.window.document.querySelector('[data-settings-navigation-item="demo:navigation"]')?.getAttribute('aria-current')).toBe('page')
      expect(dom.window.document.querySelector('.cxm-heading .cxm-back')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-breadcrumbs')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-heading-icon[data-host-icon="host:settings"]')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading-direct-title')?.textContent).toBe('Demo settings')
      expect(dom.window.document.querySelector('.cxm-heading p')).toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-close')!.click(); await settle()
      expect(events).toEqual(['mount:demo:navigation', 'abort:demo:navigation', 'close'])
      expect(dom.window.document.querySelector('[data-demo-body]')).toBeNull()
    } finally { dispose(); dom.window.close() }
  })

  it('renders disabled B data without activation and falls back to Plugins after active removal', async () => {
    const dom = managerDom()
    let state = modelSnapshot([item(), item({ id: 'demo:disabled', order: 170, disabled: true, disabledReason: 'Unavailable' })])
    const listeners = new Set<() => void>()
    const manager: ManagerModel = {
      snapshot: () => state, setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      mountManagerContent: async (id, _reference, container) => { const node = container.ownerDocument.createElement('div'); node.dataset.activeBody = id; container.append(node); const controller = new AbortController(); return { owner: 'demo', contributionId: id, routeId: id, pageId: id, signal: controller.signal, abort: () => controller.abort(), dispose: async () => node.remove() } }, closeManagerContent: async () => {},
    }
    const dispose = installCordisXManager(dom.window.document, manager)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      const disabled = dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="demo:disabled"]')!
      expect(disabled.disabled).toBe(true); expect(disabled.title).toBe('Unavailable'); disabled.click(); await settle(); expect(dom.window.document.querySelector('[data-active-body]')).toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="demo:navigation"]')!.click(); await settle()
      state = modelSnapshot([item({ id: 'demo:disabled', disabled: true })]); for (const listener of listeners) listener(); await settle()
      expect(dom.window.document.querySelector('[data-active-body]')).toBeNull(); expect(dom.window.document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current')).toBe('page')
    } finally { dispose(); dom.window.close() }
  })

  it('renders manager-content navigation as Host icon tabs with complete ARIA and keyboard focus recovery', async () => {
    const dom = managerDom()
    const listeners = new Set<() => void>()
    let invalidProjection = false
    const routes = [
      { id: 'a.b', label: 'Configuration', icon: 'host:settings' },
      { id: 'a-b', label: 'Logs', icon: 'host:history' },
      { id: 'sessions', label: 'Sessions', icon: 'host:layers' },
    ] as const
    const manager: ManagerModel = {
      snapshot: () => modelSnapshot([item({ route: { id: 'a.b', params: { accountId: 'one' } } })]),
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      managerContentPresentation: (_id, reference) => ({
        title: 'Demo account', description: 'Host-owned detail navigation.', icon: 'host:layers',
        tabs: (invalidProjection ? [routes[1]!] : routes).map(tab => ({
          ...tab,
          route: { id: tab.id, params: { accountId: 'one' } },
          active: tab.id === reference.id,
        })),
      }),
      mountManagerContent: async (_id, reference, container) => {
        const body = container.ownerDocument.createElement('section')
        body.dataset.activeManagerContentBody = reference.id
        container.append(body)
        const controller = new AbortController()
        return {
          owner: 'demo', contributionId: 'demo:navigation', routeId: `demo:${reference.id}`, pageId: `demo:${reference.id}`,
          signal: controller.signal, abort: () => controller.abort(), dispose: async () => body.remove(),
        }
      },
      closeManagerContent: async () => {},
    }
    const dispose = installCordisXManager(dom.window.document, manager)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="demo:navigation"]')!.click()
      await settle()
      const tablist = dom.window.document.querySelector<HTMLElement>('[data-manager-content-tabs]')!
      const tabs = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-manager-content-tabs] [data-manager-content-tab]')]
      const panel = () => dom.window.document.querySelector<HTMLElement>('[data-manager-content-root]')!
      expect(tablist.getAttribute('role')).toBe('tablist')
      expect(tablist.getAttribute('aria-orientation')).toBe('horizontal')
      expect(tabs().map(tab => tab.getAttribute('role'))).toEqual(['tab', 'tab', 'tab'])
      expect(tabs().map(tab => tab.tabIndex)).toEqual([0, -1, -1])
      expect(new Set(tabs().map(tab => tab.id)).size).toBe(tabs().length)
      expect(tabs().map(tab => tab.querySelector('[data-host-icon]')?.getAttribute('data-host-icon')))
        .toEqual(['host:settings', 'host:history', 'host:layers'])
      expect(panel().getAttribute('role')).toBe('tabpanel')
      expect(panel().getAttribute('aria-labelledby')).toBe(tabs()[0]!.id)
      expect(tabs().every(tab => tab.getAttribute('aria-controls') === panel().id)).toBe(true)
      expect(dom.window.getComputedStyle(tablist).flexWrap).toBe('wrap')
      expect(dom.window.getComputedStyle(tabs()[0]!).borderRadius).toBe('9px')
      expect(dom.window.getComputedStyle(tabs()[0]!).fontSize).toBe('11px')
      expect(dom.window.getComputedStyle(tabs()[0]!).boxSizing).toBe('border-box')

      // Simulate a narrow renderer layout with measured, wrapped rows. The
      // tab strip's scrollWidth is derived from its child geometry, rather
      // than accepted merely because a parent clips overflowing content.
      const narrowWidth = 104
      Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: narrowWidth })
      for (const [index, tab] of tabs().entries()) {
        Object.defineProperty(tab, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, right: 96, top: index * 32, bottom: index * 32 + 28, width: 96, height: 28, x: 0, y: index * 32, toJSON: () => ({}) }) })
      }
      Object.defineProperty(tablist, 'scrollWidth', {
        configurable: true,
        get: () => Math.max(...tabs().map(tab => tab.getBoundingClientRect().right - tablist.getBoundingClientRect().left)),
      })
      Object.defineProperty(tablist, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, right: narrowWidth, top: 0, bottom: 96, width: narrowWidth, height: 96, x: 0, y: 0, toJSON: () => ({}) }) })
      expect(tablist.scrollWidth).toBeLessThanOrEqual(tablist.clientWidth)
      expect(tabs().every(tab => tab.getBoundingClientRect().right <= tablist.getBoundingClientRect().right)).toBe(true)

      tabs()[0]!.focus()
      tabs()[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await settle()
      expect(tabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
      expect(dom.window.document.activeElement?.getAttribute('data-manager-content-tab')).toBe('a-b')
      expect(panel().getAttribute('aria-labelledby')).toBe(tabs()[1]!.id)
      expect(panel().querySelector('[data-active-manager-content-body="a-b"]')).not.toBeNull()

      // The navigation entry, rather than an inner route history, owns the
      // first-level page chrome for every controlled tab.
      expect(dom.window.document.querySelector('.cxm-heading .cxm-back')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-breadcrumbs')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading-direct-title')?.textContent).toBe('Demo settings')

      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="demo:navigation"]')!.click()
      await settle()
      tabs()[0]!.focus()
      tabs()[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await settle()

      // Projection updates recreate the tablist, but the active tab remains the
      // focus target instead of falling back to the Manager sidebar.
      for (const listener of listeners) listener()
      expect(dom.window.document.activeElement?.getAttribute('data-manager-content-tab')).toBe('a-b')
      tabs()[1]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await settle()
      expect(dom.window.document.activeElement?.getAttribute('data-manager-content-tab')).toBe('sessions')
      tabs()[2]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      await settle()
      expect(dom.window.document.activeElement?.getAttribute('data-manager-content-tab')).toBe('a-b')
      tabs()[1]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await settle()
      expect(dom.window.document.activeElement?.getAttribute('data-manager-content-tab')).toBe('sessions')
      tabs()[2]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      await settle()
      expect(dom.window.document.activeElement?.getAttribute('data-manager-content-tab')).toBe('a.b')

      // A malformed consumer projection cannot leave a tablist whose buttons
      // are all tabindex=-1 or point aria-labelledby at a missing tab.
      invalidProjection = true
      for (const listener of listeners) listener()
      expect(dom.window.document.querySelector('[data-manager-content-tabs]')).toBeNull()
      expect(panel().getAttribute('role')).toBeNull()
      expect(panel().getAttribute('aria-labelledby')).toBeNull()
    } finally { dispose(); dom.window.close() }
  })
})
