import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

interface RuntimeSnapshot {
  plugins: readonly { id: string; source: string; status: string; configuration: { applies: string } }[]
  registrations: readonly { owner: string; qualifiedId: string; surface: string; valid: boolean; visible: boolean; authorized: boolean; pending: boolean }[]
  settingsTabs: readonly unknown[]
  settingsNavigationItems: readonly { id: string; title: string; description: string; pageTitle: string; pageDescription: string; icon: string; group: string; order: number; disabled: boolean; route: { id: string } }[]
  navigation: { routes: readonly { qualifiedId: string; productMetadata: { title?: string; description?: string } }[]; pages: readonly { qualifiedId: string; metadata: { chrome?: string }; productMetadata: { title?: string; description?: string } }[]; outlets: readonly { id: string; mounted: boolean; activeRoute?: string }[] }
  extensionPoints: { accessDiagnostics: readonly { request: { operation: string; generation: string; identity: { source: string; pluginId: string; pointId: string } }; authorized: boolean }[] }
}
interface RuntimeHandle {
  snapshot(): RuntimeSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: 'inherit' | 'allow' | 'deny'): Promise<void>
  dispose(): Promise<void>
}

async function waitFor(predicate: () => boolean, attempts = 1_500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not settle')
}

describe('settings navigation demo bundle', () => {
  it('projects a first-level Host-owned navigation entry, mounts its controlled body, and cleans it up', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(projectRoot, 'cordisx.config.settings-demo.json'))
    const bundle = await buildRendererBundle(config)
    const dom = new JSDOM('<html lang="en" dir="ltr" class="electron-dark"><body><div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div></body></html>', {
      runScripts: 'dangerously', url: 'https://codex.local/native',
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    const initial = runtime.snapshot()
    expect(initial.plugins).toEqual([expect.objectContaining({ id: 'settings-tab-demo', status: 'active', configuration: expect.objectContaining({ applies: 'plugin-restart' }) })])
    expect(initial.settingsTabs).toEqual([])
    expect(initial.settingsNavigationItems).toEqual([expect.objectContaining({
      id: 'settings-tab-demo:navigation', title: 'Demo plugin settings', icon: 'host:settings', group: 'after-settings', order: 160,
      route: { id: 'navigation' }, pageTitle: 'Demo plugin settings',
    })])
    expect(initial.registrations).toEqual([expect.objectContaining({
      owner: 'settings-tab-demo', qualifiedId: 'settings-tab-demo:navigation', surface: 'manager.settings.navigation-items',
      valid: true, visible: true, authorized: true, pending: false,
    })])
    expect(initial.navigation.routes).toEqual([expect.objectContaining({
      qualifiedId: 'settings-tab-demo:navigation',
      productMetadata: expect.objectContaining({
        title: 'Demo plugin settings',
        description: 'Open the demo plugin settings and edit its example value.',
      }),
    })])
    expect(initial.navigation.pages).toEqual([expect.objectContaining({
      qualifiedId: 'settings-tab-demo:navigation',
      metadata: expect.objectContaining({ chrome: 'standard' }),
      productMetadata: expect.objectContaining({
        title: 'Demo plugin settings',
        description: 'Edit the example value for this demo plugin.',
      }),
    })])

    await waitFor(() => dom.window.document.querySelector('[data-cordisx-manager-trigger]') !== null)
    const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
    trigger.click()
    const item = (): HTMLButtonElement | null => dom.window.document.querySelector('[data-settings-navigation-item="settings-tab-demo:navigation"]')
    expect(dom.window.document.querySelector('[data-tab="settings"]')).toBeNull()
    expect(dom.window.document.querySelector('[data-settings-tab]')).toBeNull()
    expect(item()?.textContent).toContain('Demo plugin settings')
    expect(item()?.querySelector('[data-host-icon="host:settings"]')).not.toBeNull()
    expect(item()?.querySelector('section,style')).toBeNull()

    item()!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-navigation-demo-content="mounted"]') !== null)
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-page="settings-tab-demo:navigation"]')!
    expect(page.closest('.cxr-content')).not.toBeNull()
    // A first-level Manager navigation entry owns the direct Host header: it
    // has its own icon and title, without a history Back control or breadcrumb.
    expect(dom.window.document.querySelector('.cxr-header-seat button[aria-label="返回"]')).toBeNull()
    expect(dom.window.document.querySelector('.cxr-header-seat [data-host-icon="host:settings"]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxr-heading .cxr-breadcrumbs')).toBeNull()
    expect(dom.window.document.querySelector('.cxr-heading p')).toBeNull()
    expect(dom.window.document.querySelector('.cxr-heading h2')?.textContent).toBe('Demo plugin settings')
    const managerStyles = dom.window.document.getElementById('cordisx-react-manager-style')?.textContent
    expect(managerStyles).toContain('.cxr-header')
    expect(managerStyles).toContain('.cxr-content')
    expect(page.style.padding).toBe('')
    expect(page.querySelector('[data-settings-navigation-demo-body-title]')).toBeNull()
    expect(page.textContent).not.toContain('Settings for this demo plugin.')
    expect(page.querySelector<HTMLInputElement>('[data-settings-navigation-demo-focus]')?.value).toBe('CordisX')
    expect(item()?.getAttribute('aria-current')).toBe('page')
    expect(dom.window.location.href).toBe('https://codex.local/native')
    expect(runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'manager.content')).toMatchObject({ mounted: true, activeRoute: 'settings-tab-demo:navigation' })
    expect(runtime.snapshot().extensionPoints.accessDiagnostics.slice(-3).map(entry => entry.request.operation)).toEqual([
      'surface.route.navigate', 'outlet.route.navigate', 'outlet.page.mount',
    ])

    expect(item()?.tabIndex).toBe(0)
    expect(dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')?.tabIndex).toBe(0)

    await runtime.setExtensionPointPolicy(initial.plugins[0]!.source, 'settings-tab-demo', 'manager.settings.navigation-items', 'deny')
    await waitFor(() => item() === null && dom.window.document.querySelector('[data-settings-navigation-demo-content]') === null)
    expect(dom.window.document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current')).toBe('page')
    expect(runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'manager.content')?.mounted).toBe(false)
    await runtime.setExtensionPointPolicy(initial.plugins[0]!.source, 'settings-tab-demo', 'manager.settings.navigation-items', 'allow')
    await waitFor(() => item() !== null)
    expect(dom.window.document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current')).toBe('page')

    item()!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-navigation-demo-content]') !== null)
    await runtime.setPluginBlocked('settings-tab-demo', true)
    await waitFor(() => item() === null && dom.window.document.querySelector('[data-settings-navigation-demo-content]') === null)
    expect(dom.window.document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current')).toBe('page')
    await runtime.setPluginBlocked('settings-tab-demo', false)
    await waitFor(() => item() !== null)

    dom.window.document.documentElement.lang = 'zh-CN'
    await waitFor(() => item()?.textContent?.includes('演示插件设置') === true)
    expect(runtime.snapshot().settingsNavigationItems[0]?.title).toBe('演示插件设置')
    expect(runtime.snapshot().navigation.routes[0]?.productMetadata.title).toBe('演示插件设置')
    expect(runtime.snapshot().navigation.routes[0]?.productMetadata.description).toBe('打开“演示插件设置”并编辑示例值。')
    expect(runtime.snapshot().navigation.pages[0]?.productMetadata).toEqual(expect.objectContaining({
      title: '演示插件设置',
      description: '编辑此演示插件的示例值。',
    }))

    item()!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-navigation-demo-content]') !== null)
    const priorGeneration = runtime.snapshot().extensionPoints.accessDiagnostics.at(-1)!.request.generation
    dom.window.document.querySelector<HTMLButtonElement>('.cxr-header button[aria-label="关闭"]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-navigation-demo-content]') === null)
    dom.window.eval(bundle)
    await waitFor(() => (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime !== runtime)
    const replacement = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    await waitFor(() => dom.window.document.querySelector('[data-cordisx-manager-trigger]') !== null)
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-settings-navigation-item]') !== null)
    expect(replacement.snapshot().extensionPoints.accessDiagnostics.every(entry => entry.request.generation !== priorGeneration)).toBe(true)
    await replacement.dispose()
    expect(dom.window.document.querySelector('[data-settings-navigation-demo-content]')).toBeNull()
    dom.window.close()
  }, 20_000)
})
