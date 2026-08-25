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
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      expect(bundle).toContain('hostKind: "playground"')
      expect(bundle).toContain('installCordisX')
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
      const runtime = dom.window as unknown as { __cordisxRuntime?: { snapshot(): { plugins: readonly { id: string; status: string }[]; platform: { mode: string } }; dispose(): Promise<void> } }
      expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
      expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
        .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
      expect(runtime.__cordisxRuntime?.snapshot().platform.mode).toBe('unavailable')
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      expect(trigger.previousElementSibling).toBe(dom.window.document.querySelector('[data-cordisx-playground-manager-trigger]'))
      trigger.click()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')?.hidden).toBe(false)
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
      await runtime.__cordisxRuntime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally { dom.window.close() }
  }, 30_000)
})
