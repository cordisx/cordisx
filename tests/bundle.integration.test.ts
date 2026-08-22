import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../src/launcher/bundle.js'
import { loadConfig } from '../src/launcher/config.js'

describe('renderer bundle', () => {
  it('boots a Cordis plugin and removes its UI on runtime disposal', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const bundle = await buildRendererBundle(config)
    const dom = new JSDOM(`
      <html><head></head><body>
        <header class="app-header-tint"><div class="ms-auto flex items-center"></div></header>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value: () => ({ length: 1 }),
    })

    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 20 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
    expect(dom.window.document.querySelector('[data-cordisx-contribution="hello-toolbar.action"] button')?.textContent).toBe('CordisX')

    const runtime = (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime
    await runtime?.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-contribution]')).toBeNull()
    dom.window.close()
  })
})
