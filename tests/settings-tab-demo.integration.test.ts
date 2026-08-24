import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

interface RuntimeSnapshot {
  plugins: readonly {
    id: string
    source: string
    status: string
    configuration: {
      schemaKind: string
      applies: string
      fields: readonly { path: readonly string[]; label?: string; description?: string; value?: unknown; min?: number; max?: number }[]
    }
  }[]
  registrations: readonly { owner: string; qualifiedId: string; surface: string; valid: boolean; visible: boolean; authorized: boolean; pending: boolean }[]
  settingsTabs: readonly { id: string; owner: string; title: string; order: number; disabled: boolean; builtin: boolean }[]
  navigation: {
    routes: readonly { qualifiedId: string; valid: boolean; authorized: boolean }[]
    pages: readonly { qualifiedId: string; metadata: { chrome?: string } }[]
    outlets: readonly { id: string; mounted: boolean; activeRoute?: string }[]
  }
  extensionPoints: {
    points: readonly { id: string; usingPluginCount: number; activePluginCount: number }[]
    accessDiagnostics: readonly {
      request: { operation: string; generation: string; identity: { source: string; pluginId: string; pointId: string } }
      authorized: boolean
    }[]
  }
}

interface RuntimeHandle {
  snapshot(): RuntimeSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: 'inherit' | 'allow' | 'deny'): Promise<void>
  dispose(): Promise<void>
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not settle')
}

describe('settings tab demo bundle', () => {
  it('projects, mounts, localizes, blocks, denies, restores, and disposes the real manager page', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(projectRoot, 'cordisx.config.settings-demo.json'))
    const bundle = await buildRendererBundle(config)
    const dom = new JSDOM(`
      <html lang="en" dir="ltr" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    expect(runtime).toBeDefined()

    const initial = runtime.snapshot()
    expect(initial.plugins).toEqual([expect.objectContaining({
      id: 'settings-tab-demo',
      status: 'active',
      configuration: expect.objectContaining({
        schemaKind: 'schemastery',
        applies: 'restart',
        fields: [expect.objectContaining({
          path: ['demoValue'], label: 'Demo value', value: 'CordisX', min: 1, max: 64,
        })],
      }),
    })])
    expect(initial.settingsTabs.map(tab => [tab.id, tab.order])).toEqual([
      ['host:marketplace', 100],
      ['settings-tab-demo:settings', 150],
      ['host:runtime', 200],
      ['host:launcher', 300],
    ])
    expect(initial.registrations).toEqual([
      expect.objectContaining({
        owner: 'settings-tab-demo', qualifiedId: 'settings-tab-demo:settings', surface: 'manager.settings.tabs',
        valid: true, visible: true, authorized: true, pending: false,
      }),
    ])
    expect(initial.navigation.routes).toEqual([
      expect.objectContaining({ qualifiedId: 'settings-tab-demo:settings', valid: true, authorized: true }),
    ])
    expect(initial.navigation.pages).toEqual([
      expect.objectContaining({ qualifiedId: 'settings-tab-demo:settings', metadata: expect.objectContaining({ chrome: 'body-only' }) }),
    ])
    expect(initial.extensionPoints.points.find(point => point.id === 'manager.settings.tabs')).toMatchObject({ usingPluginCount: 1, activePluginCount: 1 })
    expect(initial.extensionPoints.points.find(point => point.id === 'manager.settings.content')).toMatchObject({ usingPluginCount: 1, activePluginCount: 1 })

    const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
    expect(managerTrigger).not.toBeNull()
    managerTrigger.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="settings-tab-demo"]')!.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')!.click()
    const configPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="配置管理"]')!
    const demoField = configPanel.querySelector<HTMLElement>('[data-config-path="demoValue"]')!
    expect(demoField.querySelector('.cxm-config-label')?.textContent).toBe('Demo value')
    expect(demoField.querySelector('.cxm-config-help')?.textContent).toBe('Initial value shown inside the controlled settings page.')
    expect(demoField.querySelector<HTMLInputElement>('input')?.value).toBe('CordisX')
    expect(configPanel.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click()
    const tabIds = () => [...dom.window.document.querySelectorAll<HTMLElement>('[data-settings-tab]')]
      .map(tab => tab.dataset.settingsTab)
    expect(tabIds()).toEqual(['host:marketplace', 'settings-tab-demo:settings', 'host:runtime', 'host:launcher'])
    const pluginTab = dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-tab-demo:settings"]')!
    expect(pluginTab.textContent).toBe('Demo plugin')
    expect(pluginTab.querySelector('[data-host-icon="host:settings"]')).not.toBeNull()
    expect(pluginTab.querySelector('section,style')).toBeNull()
    expect(pluginTab.querySelectorAll('svg')).toHaveLength(1)
    pluginTab.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content="mounted"]') !== null)

    const panel = dom.window.document.querySelector<HTMLElement>('[data-settings-root] [role="tabpanel"]')!
    const page = panel.querySelector<HTMLElement>('[data-cordisx-settings-page="settings-tab-demo:settings"]')!
    expect(page.parentElement?.hasAttribute('data-settings-panel-body')).toBe(true)
    expect(page.querySelector('[data-cordisx-page-chrome]')).toBeNull()
    expect(page.querySelector('[data-settings-demo-body-title]')?.textContent).toBe('Plugin settings content')
    expect(page.querySelector<HTMLInputElement>('[data-settings-demo-focus]')?.value).toBe('CordisX')
    expect(dom.window.location.href).toBe('https://codex.local/native')
    expect(runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'manager.settings.content')).toMatchObject({
      mounted: true, activeRoute: 'settings-tab-demo:settings',
    })
    expect(runtime.snapshot().extensionPoints.accessDiagnostics.slice(-3).map(item => item.request.operation)).toEqual([
      'surface.route.navigate', 'outlet.route.navigate', 'outlet.page.mount',
    ])
    expect(runtime.snapshot().extensionPoints.accessDiagnostics.slice(-3).every(item => (
      item.authorized
      && item.request.identity.pluginId === 'settings-tab-demo'
      && item.request.identity.source === initial.plugins[0]!.source
      && item.request.generation.length > 0
    ))).toBe(true)

    await runtime.setExtensionPointPolicy(initial.plugins[0]!.source, 'settings-tab-demo', 'manager.settings.tabs', 'deny')
    await waitFor(() => dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]') === null)
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') === null)
    expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')
    expect(runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'manager.settings.content')?.mounted).toBe(false)

    await runtime.setExtensionPointPolicy(initial.plugins[0]!.source, 'settings-tab-demo', 'manager.settings.tabs', 'allow')
    await waitFor(() => dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]') !== null)
    expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')
    dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-tab-demo:settings"]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') !== null)

    await runtime.setExtensionPointPolicy(initial.plugins[0]!.source, 'settings-tab-demo', 'manager.settings.content', 'deny')
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') === null)
    expect(dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]')).toBeNull()
    expect(runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'manager.settings.content')?.mounted).toBe(false)
    await runtime.setExtensionPointPolicy(initial.plugins[0]!.source, 'settings-tab-demo', 'manager.settings.content', 'allow')
    await waitFor(() => dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]') !== null)

    dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-tab-demo:settings"]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') !== null)
    await runtime.setPluginBlocked('settings-tab-demo', true)
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') === null)
    expect(runtime.snapshot().plugins[0]?.status).toBe('blocked')
    expect(dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]')).toBeNull()
    expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')

    await runtime.setPluginBlocked('settings-tab-demo', false)
    await waitFor(() => dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]') !== null)
    expect(runtime.snapshot().plugins[0]?.status).toBe('active')
    expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')

    dom.window.document.documentElement.lang = 'zh-CN'
    await waitFor(() => dom.window.document.querySelector('[data-settings-tab="settings-tab-demo:settings"]')?.textContent === '演示插件')
    expect(runtime.snapshot().settingsTabs.find(tab => tab.id === 'settings-tab-demo:settings')?.title).toBe('演示插件')

    dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-tab-demo:settings"]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') !== null)
    const previousGeneration = runtime.snapshot().extensionPoints.accessDiagnostics.at(-1)!.request.generation
    dom.window.eval(bundle)
    await waitFor(() => (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime !== runtime)
    const replacement = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true'
      && dom.window.document.querySelectorAll('[data-cordisx-manager-trigger]').length === 1)
    expect(dom.window.document.querySelector('[data-settings-demo-content]')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click()
    expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected')).toBe('true')
    dom.window.document.querySelector<HTMLButtonElement>('[data-settings-tab="settings-tab-demo:settings"]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-demo-content]') !== null)
    const replacementGeneration = replacement.snapshot().extensionPoints.accessDiagnostics.at(-1)!.request.generation
    expect(replacementGeneration).not.toBe(previousGeneration)

    await replacement.dispose()
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
    expect(dom.window.document.querySelector('[data-settings-demo-content]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    dom.window.close()
  }, 15_000)
})
