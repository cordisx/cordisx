import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { defaultUiPlaygroundConfig } from '../packages/cli/src/playground/defaults.js'
import { startUiPlayground } from '../packages/cli/src/playground/server.js'

const defaultPluginIds = [
  'slot-showcase', 'hello-toolbar', 'form-schema-gallery', 'settings-tab-demo',
  'console-showcase', 'channel', 'cli-proxy-api',
]

describe('UI Playground', () => {
  it('serves a loopback production renderer bundle and removes isolated state on close', async () => {
    const source = await readFile(defaultUiPlaygroundConfig, 'utf8')
    const playground = await startUiPlayground({ configPath: defaultUiPlaygroundConfig })
    try {
      expect(playground.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const page = await fetch(playground.url).then(response => response.text())
      expect(page).toContain('data-cordisx-playground-manager-trigger')
      expect(page).toContain('Comprehensive UI demos')
      expect(page).toContain('data-pg-plugin-count')
      expect(page).toContain('npm run dev:ui -- --config')
      expect(page).toContain('__cordisxServiceConfigRequestV1')
      expect(page).toContain('__cordisxChannelCredentialRequestV1')
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      expect(bundle).toContain('hostKind: "playground"')
      expect(bundle).toContain('installCordisX')
      const serviceConfigToken = /serviceConfigBridgeToken: "([a-f0-9]{64})"/.exec(bundle)?.[1]
      const generation = /generation: "(playground-[a-f0-9]+)"/.exec(bundle)?.[1]
      expect(serviceConfigToken).toBeDefined()
      expect(generation).toBeDefined()
      const serviceList = await fetch(`${playground.url}api/service-config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1, token: serviceConfigToken, requestId: 'playground-service-list', operation: 'list', pluginId: 'channel',
          scope: { profileId: 'playground', generation },
        }),
      }).then(response => response.json()) as { ok: boolean; value?: Array<{ writable?: boolean }> }
      expect(serviceList.ok).toBe(true)
      expect(serviceList.value?.[0]?.writable).toBe(true)
      const materialized = path.join(playground.homeDir, 'config', 'playground.config.json')
      const materializedInitial = await readFile(materialized, 'utf8')
      expect(JSON.parse(materializedInitial).plugins.map((plugin: { id: string }) => plugin.id)).toEqual(defaultPluginIds)
      await writeFile(materialized, '{"version":1,"plugins":[]}\n')
      await fetch(`${playground.url}api/reset`, { method: 'POST' }).then(response => expect(response.ok).toBe(true))
      expect(await readFile(materialized, 'utf8')).toBe(materializedInitial)
      expect(await readFile(defaultUiPlaygroundConfig, 'utf8')).toBe(source)
    } finally {
      const home = playground.homeDir
      await playground.close()
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 30_000)

  it('boots, reloads, and disposes the comprehensive real plugin runtime with explicit Playground seats only', async () => {
    const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
    expect(config.plugins.map(plugin => plugin.id)).toEqual(defaultPluginIds)
    const bundle = await buildRendererBundle(config, { playground: true, generation: 'playground-test-1', profileId: 'playground' })
    const dom = new JSDOM(`<!doctype html><html data-theme="dark"><head></head><body>
      <button data-cordisx-playground-manager-trigger>Manager</button>
      <main data-cordisx-playground-seat="app"></main><main data-cordisx-playground-seat="main"></main><main data-cordisx-playground-seat="session.content"></main>
    </body></html>`, { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
    try {
      dom.window.eval(bundle)
      for (let attempt = 0; attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const runtime = dom.window as unknown as { __cordisxRuntime?: { snapshot(): { plugins: readonly { id: string; name: string; description?: string; icon?: string; status: string }[]; platform: { mode: string } }; dispose(): Promise<void> } }
      expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
        .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => plugin.name)).toEqual([
        'Slot Showcase', 'Hello Toolbar', 'Form Schema Gallery', 'Settings Navigation Demo',
        'Plugin Console Showcase', 'Channels', 'CLIProxy Providers',
      ])
      dom.window.document.documentElement.lang = 'zh-CN'
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => plugin.name)).toEqual([
        '点位展示', '工具栏问候', '表单结构展示', '设置导航演示',
        '插件控制台展示', '渠道', 'CLIProxy 提供方',
      ])
      expect(runtime.__cordisxRuntime?.snapshot().plugins.find(plugin => plugin.id === 'channel')?.description)
        .toBe('管理渠道账号、连接和会话。')
      expect(runtime.__cordisxRuntime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')?.icon)
        .toMatch(/^data:image\/png;base64,/)
      expect(runtime.__cordisxRuntime?.snapshot().platform.mode).toBe('unavailable')
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      const reactManager = dom.window.document.querySelector('[data-cordisx-react-manager="true"]')
      expect(reactManager).not.toBeNull()
      const managerStyles = dom.window.document.getElementById('cordisx-react-manager-style')?.textContent ?? ''
      expect(managerStyles).toContain('.t-input {')
      expect(managerStyles).toContain('.t-textarea__inner {')
      expect(managerStyles).toContain('.cxr-tabs { display: flex; min-height: 38px; flex: none;')
      expect(managerStyles).toContain('.cxr-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));')
      expect(managerStyles).toContain('.cxr-plugin-actions { position: absolute; top: 50%;')
      expect(managerStyles).toContain('transform: translateY(-50%);')
      expect(managerStyles).toContain('.cxf-form-body { display: grid; min-width: 0; align-content: start; grid-auto-rows: max-content;')
      expect(managerStyles).toContain('.cxr-page[data-plugin-detail]:has(> .cxr-plugin-config-panel)')
      expect(managerStyles).not.toContain('.cxr-page[data-plugin-detail] { display: flex;')
      expect(trigger.parentElement?.previousElementSibling).toBe(dom.window.document.querySelector('[data-cordisx-playground-manager-trigger]'))
      expect(trigger.querySelector('.cxr-trigger-mark img')).not.toBeNull()
      expect(trigger.querySelector('svg')).toBeNull()
      trigger.click()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')).not.toBeNull()
      expect(dom.window.document.querySelector<HTMLImageElement>('[data-plugin-id="cli-proxy-api"] .cxr-card-icon img')?.src)
        .toMatch(/^data:image\/png;base64,/)
      const internalAccents = new Map([
        ['slot-showcase', 'spectral'],
        ['hello-toolbar', 'solar'],
        ['form-schema-gallery', 'violet'],
        ['settings-tab-demo', 'polar'],
        ['console-showcase', 'ember'],
        ['channel', 'jade'],
      ])
      const gradientPhases = new Set<string>()
      for (const [pluginId, accent] of internalAccents) {
        const internalBadge = dom.window.document.querySelector(`[data-plugin-id="${pluginId}"] [data-internal-plugin-badge="${pluginId}"]`)
        expect(internalBadge?.getAttribute('data-accent')).toBe(accent)
        expect(internalBadge?.getAttribute('data-brand-geometry')).toBe('official-1440-segments')
        expect(internalBadge?.getAttribute('data-gradient-mode')).toBe('segment-depth')
        expect(internalBadge?.getAttribute('data-gradient-phase')).toMatch(/^\d+$/)
        gradientPhases.add(internalBadge?.getAttribute('data-gradient-phase') ?? '')
        const derivedMarks = internalBadge?.querySelectorAll<HTMLImageElement>('img') ?? []
        expect(derivedMarks).toHaveLength(2)
        for (const mark of derivedMarks) expect(mark.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
        expect(internalBadge?.textContent).toBe('')
      }
      expect(gradientPhases.size).toBe(internalAccents.size)
      for (const [index, id] of defaultPluginIds.entries()) {
        dom.window.document.querySelector<HTMLButtonElement>(`[data-plugin-id="${id}"]`)?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(dom.window.document.querySelector('[data-plugin-detail]')?.getAttribute('data-plugin-detail')).toBe(id)
        expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
        if (index < defaultPluginIds.length - 1) {
          dom.window.document.querySelector<HTMLButtonElement>('.cxr-breadcrumbs button')?.click()
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      const firstRuntime = runtime.__cordisxRuntime!
      let disposed = false
      const dispose = firstRuntime.dispose.bind(firstRuntime)
      firstRuntime.dispose = async () => { disposed = true; await dispose() }
      const reload = await buildRendererBundle(config, { playground: true, generation: 'playground-test-2', profileId: 'playground' })
      dom.window.eval(reload)
      for (let attempt = 0; attempt < 100 && runtime.__cordisxRuntime === firstRuntime; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(disposed).toBe(true)
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
        .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
      expect(dom.window.document.querySelector('[data-plugin-detail]')?.getAttribute('data-plugin-detail')).toBe('cli-proxy-api')
      expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
      await runtime.__cordisxRuntime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally { dom.window.close() }
  }, 30_000)
})
