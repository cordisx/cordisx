import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { CordisXPluginConsolePageV1 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

interface TestRuntime {
  pluginConsole(id: string): CordisXPluginConsolePageV1
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  dispose(): Promise<void>
}

describe('plugin DevTools Console runtime', () => {
  it('captures silent Host API calls and owner-scoped native Console without cross-plugin leakage', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const base = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const showcaseEntry = path.join(projectRoot, 'examples/plugins/console-showcase/index.ts')
    const silentEntry = path.join(projectRoot, 'tests/fixtures/silent-console-api-plugin.ts')
    const config = {
      ...base,
      plugins: [
        { id: 'console-showcase', entry: showcaseEntry, enabled: true, config: {} },
        { id: 'silent-api', entry: silentEntry, enabled: true, config: { enabled: true } },
      ],
    }
    const denial = createPermissionPolicyRecord({
      profileId: 'console-smoke',
      identity: { source: pathToFileURL(showcaseEntry).href, id: 'console-showcase' },
      capability: 'models.read', scope: {}, policy: 'deny',
    })
    const bundle = await buildRendererBundle(config, { permission: { profileId: 'console-smoke', policies: [denial], bridgeToken: 'console-smoke-token' } })
    expect(bundle).not.toContain('https://cdn')

    const dom = new JSDOM('<html class="electron-dark"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>', {
      runScripts: 'dangerously', url: 'https://codex.local/', pretendToBeVisual: true,
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', { configurable: true, value: () => {} })
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 40 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: TestRuntime }).__cordisxRuntime
    expect(runtime).toBeDefined()
    for (let attempt = 0; attempt < 30 && !runtime!.pluginConsole('console-showcase').entries.some(entry => (
      entry.source === 'platform.models.list' && (entry.phase === 'failure' || entry.phase === 'success')
    )); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))

    const silent = runtime!.pluginConsole('silent-api')
    expect(silent.entries.some(entry => entry.source === 'settings.get' && entry.phase === 'success')).toBe(true)
    expect(silent.entries.some(entry => entry.kind === 'console')).toBe(false)

    const showcase = runtime!.pluginConsole('console-showcase')
    expect(showcase.entries.filter(entry => entry.kind === 'console').map(entry => entry.method)).toEqual([
      'debug', 'log', 'info', 'warn', 'error',
    ])
    expect(showcase.entries.some(entry => entry.source === 'settings.get' && entry.phase === 'success')).toBe(true)
    expect(showcase.entries.some(entry => entry.source === 'platform.models.list' && entry.phase === 'failure')).toBe(true)
    expect(showcase.entries.some(entry => entry.kind === 'permission' && entry.phase === 'deny')).toBe(true)
    expect(showcase.entries.every(entry => entry.plugin.pluginId === 'console-showcase')).toBe(true)
    expect(silent.entries.every(entry => entry.plugin.pluginId === 'silent-api')).toBe(true)
    expect(showcase.entries.find(entry => entry.method === 'info' && entry.kind === 'console')?.args.some(arg => arg.type === 'error')).toBe(true)

    dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { filename: 'codex-native.js', error: new Error('native') }))
    expect(runtime!.pluginConsole('console-showcase').unattributedEntries).toBeUndefined()
    dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { filename: pathToFileURL(showcaseEntry).href, error: new Error('plugin boundary') }))
    expect(runtime!.pluginConsole('console-showcase').entries.some(entry => entry.coverage === 'best-effort')).toBe(true)
    dom.window.dispatchEvent(new dom.window.ErrorEvent('error', {
      filename: `${pathToFileURL(showcaseEntry).href}\n${pathToFileURL(silentEntry).href}`,
      error: new Error('shared plugin boundary'),
    }))
    expect(runtime!.pluginConsole('console-showcase').unattributedEntries).toBe(1)

    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger="true"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="console-showcase"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.click()
    const consoleFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
    for (let attempt = 0; attempt < 20 && !consoleFrame?.textContent?.includes('settings.get'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(consoleFrame?.textContent).toContain('settings.get')
    expect(consoleFrame?.classList.contains('luna-log')).toBe(true)
    expect(consoleFrame?.querySelector('.luna-text-viewer-text')?.textContent).toContain('arg[1]')
    expect(consoleFrame?.querySelector('.luna-text-viewer-text')?.textContent).toContain('Error: inspectable error')
    expect(consoleFrame?.querySelector('[data-console-entry], .cxm-console-hit-layer')).toBeNull()
    consoleFrame?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientY: 7 }))
    const inspector = dom.window.document.querySelector('[data-console-detail]')
    expect(inspector?.textContent).toContain('host-mediated')
    expect(inspector?.textContent).not.toContain('arg[')
    const search = dom.window.document.querySelector<HTMLInputElement>('[data-console-search="console-showcase"]')
    search!.value = 'inspectable error'
    search!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(dom.window.document.querySelector('[data-plugin-console="console-showcase"]')?.textContent).toContain('console.info')
    expect(dom.window.document.querySelector('[data-plugin-console="console-showcase"]')?.textContent).not.toContain('console.warn')
    const resetSearch = dom.window.document.querySelector<HTMLInputElement>('[data-console-search="console-showcase"]')
    resetSearch!.value = ''
    resetSearch!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const source = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="日志来源"]')
    source!.value = 'console.warn'
    source!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(dom.window.document.querySelector('[data-plugin-console="console-showcase"]')?.textContent).toContain('console.warn')
    expect(dom.window.document.querySelector('[data-plugin-console="console-showcase"]')?.textContent).not.toContain('console.log')
    const resetSource = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="日志来源"]')
    resetSource!.value = 'all'
    resetSource!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    const kind = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="API / 类型"]')
    kind!.value = 'console'
    kind!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    const scopedFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
    for (let attempt = 0; attempt < 20 && !scopedFrame?.classList.contains('luna-log'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
    expect(scopedFrame?.textContent).toContain('console.log')
    expect(scopedFrame?.textContent).not.toContain('settings.get')

    Object.defineProperties(scopedFrame!, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 200 },
    })
    scopedFrame!.scrollTop = 180
    scopedFrame!.dispatchEvent(new dom.window.Event('scroll'))
    const latest = scopedFrame!.parentElement?.querySelector<HTMLButtonElement>('.cxm-console-latest')
    expect(latest?.hidden).toBe(false)
    latest?.click()
    expect(scopedFrame!.scrollTop).toBe(800)

    const modal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')
    expect(modal?.dataset.cordisxAppTheme).toBe('dark')
    dom.window.document.documentElement.className = 'electron-light'
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(modal?.dataset.cordisxAppTheme).toBe('light')
    expect(scopedFrame?.classList.contains('luna-text-viewer-theme-light')).toBe(true)

    const clear = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.cxm-console-controls button')].find(button => button.textContent === '清空')
    clear?.click()
    expect(runtime!.pluginConsole('console-showcase').entries).toEqual([])
    expect(dom.window.document.querySelector('[data-plugin-console="console-showcase"] .cxm-console-empty')?.textContent).toContain('等待插件日志')
    await runtime!.setPluginBlocked('console-showcase', true)
    await runtime!.setPluginBlocked('console-showcase', false)
    expect(runtime!.pluginConsole('console-showcase').entries.some(entry => entry.phase === 'reload')).toBe(true)

    await runtime!.dispose()
    dom.window.close()
  })
})
