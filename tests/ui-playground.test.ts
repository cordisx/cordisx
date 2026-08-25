import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { startUiPlayground } from '../packages/cli/src/playground/server.js'

describe('UI Playground', () => {
  it('serves a loopback production renderer bundle and removes isolated state on close', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const playground = await startUiPlayground({ configPath: path.join(root, 'cordisx.config.example.json') })
    try {
      expect(playground.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const page = await fetch(playground.url).then(response => response.text())
      expect(page).toContain('data-cordisx-playground-manager-trigger')
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      expect(bundle).toContain('hostKind: "playground"')
      expect(bundle).toContain('installCordisX')
      await fetch(`${playground.url}api/reset`, { method: 'POST' }).then(response => expect(response.ok).toBe(true))
    } finally {
      const home = playground.homeDir
      await playground.close()
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 30_000)

  it('boots real plugin runtime and Manager with explicit Playground seats only', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(root, 'cordisx.config.example.json'))
    const bundle = await buildRendererBundle(config, { playground: true, generation: 'playground-test', profileId: 'playground' })
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
      expect(runtime.__cordisxRuntime?.snapshot().plugins).toContainEqual(expect.objectContaining({ id: 'slot-showcase', status: 'active' }))
      expect(runtime.__cordisxRuntime?.snapshot().platform.mode).toBe('unavailable')
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      expect(trigger.previousElementSibling).toBe(dom.window.document.querySelector('[data-cordisx-playground-manager-trigger]'))
      trigger.click()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')?.hidden).toBe(false)
      await runtime.__cordisxRuntime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally { dom.window.close() }
  }, 30_000)
})
