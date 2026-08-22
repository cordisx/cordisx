import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../src/launcher/bundle.js'
import { loadConfig } from '../src/launcher/config.js'

describe('renderer bundle', () => {
  it('boots a Cordis plugin and removes its UI on runtime disposal', async () => {
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
    const dom = new JSDOM(`
      <html><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
        <header class="app-header-tint"><div class="ms-auto flex items-center"></div></header>
        <aside></aside>
        <main><form><textarea></textarea></form></main>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value: () => ({ length: 1 }),
    })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v1.schema.json',
          schemaVersion: 1,
          name: 'CordisX Community Marketplace',
          homepage: 'https://cordisx.github.io/marketplace/',
          plugins: [{
            $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v1.schema.json',
            schemaVersion: 1,
            id: 'slot-showcase',
            name: 'Slot Showcase',
            description: 'Demonstrates all five CordisX semantic UI extension points.',
            version: '0.1.0',
            source: 'https://github.com/cordisx/cordisx',
            homepage: 'https://github.com/cordisx/cordisx',
            license: 'UNLICENSED',
            compatibility: { cordisx: '^0.1.0' },
            authors: [{ name: 'CordisX', url: 'https://github.com/cordisx' }],
            keywords: ['demo', 'slots'],
          }],
        }),
      }),
    })

    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 20 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
    const toggle = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-contribution="slot-showcase.header-action"] button')
    const overlay = dom.window.document.querySelector<HTMLElement>('[data-cordisx-contribution="slot-showcase.overlay"] section')
    expect(toggle?.querySelector('span:last-child')?.textContent).toBe('CX Demo')
    expect(dom.window.document.querySelector('[data-cordisx-contribution="slot-showcase.composer-before"]')?.textContent).toContain('Prompt Lens')
    expect(dom.window.document.querySelector('[data-cordisx-contribution="slot-showcase.composer-after"]')?.textContent).toContain('demo active')
    expect(dom.window.document.querySelector('[data-cordisx-contribution="slot-showcase.sidebar-footer"]')?.textContent).toContain('5 slots online')
    expect(overlay?.hidden).toBe(false)
    toggle?.click()
    expect(overlay?.hidden).toBe(true)
    toggle?.click()
    expect(overlay?.hidden).toBe(false)

    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        readonly version: string
        snapshot(): {
          plugins: readonly { id: string; status: string }[]
          registrations: readonly { pluginId: string; slot: string; active: boolean }[]
        }
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.version).toBe('0.1.0')
    expect(runtime?.snapshot().plugins).toEqual([
      expect.objectContaining({ id: 'slot-showcase', status: 'active' }),
      expect.objectContaining({ id: 'configured-off', status: 'configured-disabled' }),
    ])
    expect(runtime?.snapshot().registrations.filter(item => item.active)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'slot-showcase', slot: 'header.actions' }),
      expect.objectContaining({ pluginId: 'slot-showcase', slot: 'composer.before' }),
      expect.objectContaining({ pluginId: 'slot-showcase', slot: 'composer.after' }),
      expect.objectContaining({ pluginId: 'slot-showcase', slot: 'sidebar.footer' }),
      expect.objectContaining({ pluginId: 'slot-showcase', slot: 'shell.overlay' }),
    ]))

    const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')
    expect(managerTrigger?.previousElementSibling?.id).toBe('workspace-switcher')
    const replacementSwitcher = dom.window.document.createElement('button')
    replacementSwitcher.id = 'workspace-switcher-replaced'
    replacementSwitcher.setAttribute('aria-haspopup', 'menu')
    replacementSwitcher.textContent = 'Codex'
    dom.window.document.getElementById('workspace-switcher')?.replaceWith(replacementSwitcher)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(managerTrigger?.previousElementSibling?.id).toBe('workspace-switcher-replaced')
    managerTrigger?.click()
    const managerModal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')
    expect(managerModal?.hidden).toBe(false)
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="slots"]')?.click()
    expect(managerModal?.textContent).toContain('header.actions')
    expect(managerModal?.textContent).toContain('slot-showcase')
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
    const search = dom.window.document.querySelector<HTMLInputElement>('.cxm-search')
    if (search !== null) {
      search.value = 'composer.before'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }
    expect(managerModal?.textContent).toContain('slot-showcase')
    expect(managerModal?.textContent).not.toContain('插件配置')
    expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('◫')

    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')?.click()
    expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('返回')
    expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('插件/slot-showcase')
    expect(managerModal?.textContent).toContain('插件配置')

    dom.window.document.querySelector<HTMLButtonElement>('.cxm-action')?.click()
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'blocked'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().plugins[0]?.status).toBe('blocked')
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toContain('slot-showcase')
    expect(dom.window.document.querySelector('[data-cordisx-contribution]')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-action')?.click()
    for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'active'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toEqual([])
    expect(dom.window.document.querySelector('[data-cordisx-contribution="slot-showcase.header-action"]')).not.toBeNull()

    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
    expect(dom.window.document.querySelector<HTMLInputElement>('.cxm-search')?.value).toBe('composer.before')
    expect(managerModal?.textContent).not.toContain('插件配置')

    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')?.click()
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(managerModal?.textContent).toContain('CordisX Community Marketplace')
    expect(managerModal?.textContent).toContain('Slot Showcase')
    expect(managerModal?.textContent).not.toContain('查看源码')
    dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin="slot-showcase"]')?.click()
    expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('插件商店/Slot Showcase')
    expect(managerModal?.textContent).toContain('查看源码')
    expect(managerModal?.textContent).toContain('不会下载、执行、安装或激活')
    dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()

    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="settings"]')?.click()
    expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('配置')
    expect(managerModal?.textContent).toContain('插件商店来源')
    expect(managerModal?.textContent).toContain('https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
    expect(managerModal?.textContent).toContain('CordisX Community Marketplace')
    expect(managerModal?.textContent).toContain('启动器配置')

    await runtime?.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-contribution]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-manager-modal]')).toBeNull()
    dom.window.close()
  })
})
