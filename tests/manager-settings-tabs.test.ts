import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_BUILTIN_MANAGER_SETTINGS_TABS,
  installCordisXManager,
  type ManagerModel,
  type ManagerSettingsTabSnapshot,
  type ManagerSnapshot,
} from '../packages/cli/src/renderer/manager.js'
import type { ManagedSettingsPageMount } from '../packages/cli/src/renderer/navigation.js'

function baseSnapshot(settingsTabs: readonly ManagerSettingsTabSnapshot[]): ManagerSnapshot {
  return {
    version: '0.1.0',
    plugins: [{
      id: 'settings-demo', source: 'file:///plugins/settings-demo/index.ts', name: 'Settings Demo',
      inject: [], config: {}, status: 'active',
    }],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable', supportedCapabilities: [],
      diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
    settingsTabs,
  }
}

const externalTab = (overrides: Partial<ManagerSettingsTabSnapshot> = {}): ManagerSettingsTabSnapshot => ({
  id: 'settings-demo:settings',
  owner: 'settings-demo',
  title: 'Demo plugin',
  icon: 'host:settings',
  order: 150,
  disabled: false,
  builtin: false,
  route: { id: 'settings' },
  ...overrides,
})

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('CordisX manager settings tabs', () => {
  it('renders one host-owned tablist/panel, preserves active identity across reprojection, and falls back on removal', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    let state = baseSnapshot([
      CORDISX_BUILTIN_MANAGER_SETTINGS_TABS[0]!,
      externalTab(),
      externalTab({ id: 'settings-demo:disabled', title: 'Disabled plugin', order: 175, disabled: true, disabledReason: 'Not available' }),
      ...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS.slice(1),
    ])
    const listeners = new Set<() => void>()
    const events: string[] = []
    let activeMount: { id: string; content: HTMLElement; controller: AbortController; disposed: boolean } | undefined
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      mountSettingsTab: async (id, panelBody): Promise<ManagedSettingsPageMount> => {
        events.push(`mount:${id}`)
        const content = panelBody.ownerDocument.createElement('section')
        content.dataset.pluginSettingsBody = id
        content.append(panelBody.ownerDocument.createElement('input'))
        panelBody.append(content)
        const controller = new AbortController()
        const record = { id, content, controller, disposed: false }
        activeMount = record
        return {
          owner: 'settings-demo', contributionId: id, routeId: 'settings-demo:settings', pageId: 'settings-demo:settings',
          signal: controller.signal,
          abort: () => {
            if (controller.signal.aborted) return
            controller.abort()
            events.push(`abort:${id}`)
          },
          dispose: async () => {
            if (record.disposed) return
            record.disposed = true
            content.remove()
            events.push(`dispose:${id}`)
          },
        }
      },
      closeSettingsTabContent: async () => {
        if (activeMount === undefined) return
        const mount = activeMount
        activeMount = undefined
        if (!mount.disposed) {
          mount.disposed = true
          mount.content.remove()
          events.push(`dispose:${mount.id}`)
        }
      },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click()
      const tabs = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')]
      expect(tabs().map(tab => tab.dataset.settingsTab)).toEqual([
        'host:marketplace', 'settings-demo:settings', 'settings-demo:disabled', 'host:runtime', 'host:launcher',
      ])
      expect(tabs().map(tab => tab.tabIndex)).toEqual([0, -1, -1, -1, -1])
      expect(tabs().every(tab => tab.getAttribute('role') === 'tab')).toBe(true)
      expect(tabs().every(tab => tab.querySelector('[data-host-icon]') !== null)).toBe(true)
      expect(tabs().find(tab => tab.dataset.settingsTab === 'settings-demo:disabled')).toMatchObject({ disabled: true, title: 'Not available' })
      const panel = dom.window.document.querySelector<HTMLElement>('[data-settings-root] [role="tabpanel"]')!
      expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0]!.id)
      expect(panel.parentElement?.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
      const marketplaceForm = panel.querySelector<HTMLFormElement>('[data-host-form="marketplace-source"]')!
      expect(marketplaceForm.classList.contains('cxf-scope')).toBe(true)
      expect(marketplaceForm.querySelector('.cxf-label')?.textContent).toBe('插件商店 JSON 地址')
      expect(marketplaceForm.querySelector<HTMLInputElement>('[data-host-form-primitive="input"]')?.type).toBe('url')
      expect(marketplaceForm.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent).toBe('添加商店')

      tabs().find(tab => tab.dataset.settingsTab === 'settings-demo:settings')!.click()
      await settle()
      expect(events).toEqual(['mount:settings-demo:settings'])
      expect(dom.window.document.activeElement?.getAttribute('data-settings-tab')).toBe('settings-demo:settings')
      expect(panel.querySelector('[data-plugin-settings-body="settings-demo:settings"]')).not.toBeNull()
      expect(panel.querySelector('[data-host-icon]')).toBeNull()
      expect(panel.getAttribute('aria-labelledby')).toBe(tabs().find(tab => tab.dataset.settingsTab === 'settings-demo:settings')!.id)

      state = baseSnapshot([
        externalTab({ title: '演示插件', order: 50 }),
        CORDISX_BUILTIN_MANAGER_SETTINGS_TABS[0]!,
        externalTab({ id: 'settings-demo:disabled', title: '禁用插件', order: 175, disabled: true }),
        ...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS.slice(1),
      ])
      for (const listener of [...listeners]) listener()
      expect(tabs().map(tab => tab.dataset.settingsTab)).toEqual([
        'settings-demo:settings', 'host:marketplace', 'settings-demo:disabled', 'host:runtime', 'host:launcher',
      ])
      expect(tabs()[0]?.textContent).toBe('演示插件')
      expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')
      expect(panel.querySelector('[data-plugin-settings-body]')).not.toBeNull()
      expect(events).toEqual(['mount:settings-demo:settings'])

      tabs()[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await settle()
      expect(dom.window.document.activeElement?.getAttribute('data-settings-tab')).toBe('host:marketplace')
      expect(events).toEqual([
        'mount:settings-demo:settings', 'abort:settings-demo:settings', 'dispose:settings-demo:settings',
      ])

      tabs().find(tab => tab.dataset.settingsTab === 'settings-demo:settings')!.click()
      await settle()
      state = baseSnapshot([...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS])
      for (const listener of [...listeners]) listener()
      await settle()
      expect(events.slice(-3)).toEqual([
        'mount:settings-demo:settings', 'abort:settings-demo:settings', 'dispose:settings-demo:settings',
      ])
      expect(tabs().find(tab => tab.dataset.settingsTab === 'host:marketplace')?.getAttribute('aria-selected')).toBe('true')
      expect(panel.getAttribute('aria-labelledby')).toBe(tabs().find(tab => tab.dataset.settingsTab === 'host:marketplace')!.id)

      state = baseSnapshot([
        CORDISX_BUILTIN_MANAGER_SETTINGS_TABS[0]!, externalTab(), ...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS.slice(1),
      ])
      for (const listener of [...listeners]) listener()
      expect(tabs().find(tab => tab.dataset.settingsTab === 'host:marketplace')?.getAttribute('aria-selected')).toBe('true')
      expect(tabs().find(tab => tab.dataset.settingsTab === 'settings-demo:settings')?.getAttribute('aria-selected')).toBe('false')

      dom.window.document.querySelector<HTMLButtonElement>('.cxm-close')!.click()
      await settle()
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click()
      expect(tabs().find(tab => tab.dataset.settingsTab === 'host:marketplace')?.getAttribute('aria-selected')).toBe('true')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('shows a host error and returns to the stable built-in fallback when a plugin mount throws', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
    const state = baseSnapshot([
      CORDISX_BUILTIN_MANAGER_SETTINGS_TABS[0]!, externalTab(), ...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS.slice(1),
    ])
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: () => () => {},
      mountSettingsTab: async () => { throw new Error('demo mount exploded') },
      closeSettingsTabContent: async () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-demo:settings"]')!.click()
      await settle()
      expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toContain('demo mount exploded')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('fences a delayed stale mount when the active contribution disappears', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
    let state = baseSnapshot([
      CORDISX_BUILTIN_MANAGER_SETTINGS_TABS[0]!, externalTab(), ...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS.slice(1),
    ])
    const listeners = new Set<() => void>()
    let resolveMount: ((mount: ManagedSettingsPageMount) => void) | undefined
    const events: string[] = []
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      mountSettingsTab: async () => await new Promise<ManagedSettingsPageMount>(resolve => { resolveMount = resolve }),
      closeSettingsTabContent: async () => { events.push('close') },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-demo:settings"]')!.click()
      await settle()
      expect(resolveMount).toBeDefined()
      state = baseSnapshot([...CORDISX_BUILTIN_MANAGER_SETTINGS_TABS])
      for (const listener of [...listeners]) listener()
      await settle()
      expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')

      const controller = new AbortController()
      resolveMount!({
        owner: 'settings-demo', contributionId: 'settings-demo:settings',
        routeId: 'settings-demo:settings', pageId: 'settings-demo:settings', signal: controller.signal,
        abort: () => { controller.abort(); events.push('abort-stale') },
        dispose: async () => { events.push('dispose-stale') },
      })
      await settle()
      expect(events).toEqual(['close', 'abort-stale', 'dispose-stale'])
      expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
