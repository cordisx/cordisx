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
      mountManagerContent: async (id, container): Promise<ManagedManagerPageMount> => {
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
      mountManagerContent: async (id, container) => { const node = container.ownerDocument.createElement('div'); node.dataset.activeBody = id; container.append(node); const controller = new AbortController(); return { owner: 'demo', contributionId: id, routeId: id, pageId: id, signal: controller.signal, abort: () => controller.abort(), dispose: async () => node.remove() } }, closeManagerContent: async () => {},
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
})
