import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CordisXPluginConsolePageV1 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

interface TestRuntime {
  pluginConsole(id: string): CordisXPluginConsolePageV1
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  dispose(): Promise<void>
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const showcaseEntry = path.join(projectRoot, 'examples/plugins/console-showcase/index.ts')
const silentEntry = path.join(projectRoot, 'tests/fixtures/silent-console-api-plugin.ts')
const BUNDLE_SETUP_TIMEOUT_MS = 15_000
const RUNTIME_INTEGRATION_TIMEOUT_MS = 10_000

async function waitForState(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
type TestTDesignSelect = HTMLElement & { setSelectedValue(value: string | undefined, notify?: boolean): void }

describe('plugin DevTools Console runtime', () => {
  let bundle = ''
  let activeDom: JSDOM | undefined
  let activeRuntime: TestRuntime | undefined

  beforeAll(async () => {
    const base = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
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
    bundle = await buildRendererBundle(config, { permission: { profileId: 'console-smoke', policies: [denial], bridgeToken: 'console-smoke-token' } })
    expect(bundle).not.toContain('https://cdn')
  }, BUNDLE_SETUP_TIMEOUT_MS)

  afterEach(async () => {
    const runtime = activeRuntime
    const dom = activeDom
    activeRuntime = undefined
    activeDom = undefined
    try {
      await runtime?.dispose()
    } finally {
      dom?.window.close()
    }
  })

  it('captures silent Host API calls and owner-scoped native Console without cross-plugin leakage', async () => {
    const dom = new JSDOM('<html class="electron-dark"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>', {
      runScripts: 'dangerously', url: 'https://codex.local/', pretendToBeVisual: true,
    })
    activeDom = dom
    Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({
      matches: false, media: '', onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }) })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: function () {
      const height = (this as HTMLElement).classList.contains('luna-console') ? 240 : 24
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) }
    } })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: function () {
      return (this as HTMLElement).classList.contains('luna-console') ? 240 : 24
    } })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => dom.window.document.body })
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', { configurable: true, value: () => {} })
    dom.window.eval(bundle)
    await waitForState(() => dom.window.document.documentElement.dataset.cordisxReady === 'true', 'renderer readiness')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: TestRuntime }).__cordisxRuntime
    expect(runtime).toBeDefined()
    activeRuntime = runtime
    await waitForState(() => runtime!.pluginConsole('console-showcase').entries.some(entry => (
      entry.source === 'platform.models.list' && (entry.phase === 'failure' || entry.phase === 'success')
    )), 'terminal Host invocation')

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
    expect(dom.window.document.querySelector('[data-plugin-runtime-status="console-showcase"]')).not.toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="logs"]')?.click()
    let consoleFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
    await waitForState(() => {
      consoleFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
      return consoleFrame?.textContent?.includes('settings.get') === true
    }, 'Luna Console mount')
    expect(consoleFrame?.textContent).toContain('settings.get')
    expect(consoleFrame?.classList.contains('luna-console')).toBe(true)
    expect(consoleFrame?.querySelector('.luna-text-viewer-text, pre')).toBeNull()
    const lunaEntries = [...(consoleFrame?.querySelectorAll<HTMLElement>('[data-console-entry]') ?? [])]
    expect(lunaEntries.length).toBeGreaterThan(10)
    expect(lunaEntries).toHaveLength(runtime!.pluginConsole('console-showcase').entries.length)
    expect(lunaEntries.some(item => item.dataset.consoleMethod === 'debug')).toBe(true)
    expect(lunaEntries.some(item => item.dataset.consoleMethod === 'warn')).toBe(true)
    expect(lunaEntries.some(item => item.dataset.consoleMethod === 'error')).toBe(true)
    expect(consoleFrame?.querySelector('.luna-console-log-content')?.textContent).toBeTruthy()
    expect(dom.window.document.querySelector('[data-console-action="export"]')).not.toBeNull()
    const mixed = lunaEntries.find(item => item.textContent?.includes('object and array'))
    expect(mixed?.querySelectorAll('.luna-console-preview')).toHaveLength(2)
    mixed?.querySelector<HTMLElement>('.luna-console-preview')?.click()
    expect(mixed?.querySelector('.luna-object-viewer')).not.toBeNull()
    const errorPayload = lunaEntries.find(item => item.dataset.consoleSource === 'console.info')
    expect(errorPayload).toBeDefined()
    errorPayload?.querySelector<HTMLElement>('.luna-console-preview')?.click()
    expect(errorPayload?.querySelector('.luna-object-viewer')?.textContent).toContain('inspectable error')
    expect(errorPayload?.querySelector('.luna-object-viewer')?.textContent).toContain('stack')
    const circularPayload = lunaEntries.find(item => item.dataset.consoleSource === 'console.warn')
    circularPayload?.querySelector<HTMLElement>('.luna-console-preview')?.click()
    circularPayload?.querySelector<HTMLElement>('.luna-object-viewer-collapsed')?.click()
    expect(circularPayload?.querySelector('.luna-object-viewer')?.textContent).toContain('[Circular]')
    const controls = dom.window.document.querySelector('.cxm-console-controls')
    expect(controls?.textContent).not.toContain('采集范围')
    expect(controls?.parentElement?.textContent).not.toContain('Host API 自动切面')
    const toolbar = controls?.querySelector('[role="toolbar"][aria-label="Console display controls"]')
    const actionButtons = [...(toolbar?.querySelectorAll<HTMLButtonElement>('[data-console-action]') ?? [])]
    expect(actionButtons.map(button => button.dataset.consoleAction)).toEqual(['pause', 'follow', 'clear', 'copy', 'export'])
    expect(actionButtons.every(button => button.textContent === '')).toBe(true)
    expect(actionButtons.map(button => button.getAttribute('aria-label'))).toEqual(['Pause capture', 'Stop following', 'Clear logs', 'Copy selected', 'Export plugin logs'])
    expect(actionButtons.find(button => button.dataset.consoleAction === 'clear')?.getAttribute('aria-description')).toBe('Cannot be undone')
    expect(actionButtons.find(button => button.dataset.consoleAction === 'copy')?.disabled).toBe(true)
    actionButtons[0]?.focus()
    await waitForState(() => dom.window.document.querySelector('[role="tooltip"]')?.textContent === 'Pause capture', 'toolbar tooltip')
    expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent).toBe('Pause capture')
    actionButtons[0]?.blur()
    actionButtons[0]?.click()
    expect(dom.window.document.querySelector('[data-console-action="pause"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(dom.window.document.querySelector('[data-console-action="follow"]')?.getAttribute('aria-pressed')).toBe('true')
    dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="pause"]')?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(dom.window.document.querySelector('[data-console-action="pause"]')?.getAttribute('aria-pressed')).toBe('false')
    dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="pause"]')?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    )
    expect(dom.window.document.querySelector('[data-console-action="pause"]')?.getAttribute('aria-pressed')).toBe('true')
    dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="follow"]')?.click()
    expect(dom.window.document.querySelector('[data-console-action="pause"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(dom.window.document.querySelector('[data-console-action="follow"]')?.getAttribute('aria-pressed')).toBe('false')
    dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="pause"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="follow"]')?.click()
    const keyboardFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
    await waitForState(() => keyboardFrame?.querySelector('[data-console-entry]') !== null, 'keyboard Console remount')
    keyboardFrame?.focus()
    keyboardFrame?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const inspector = dom.window.document.querySelector('[data-console-detail]')
    expect(inspector?.textContent).toContain('host-mediated')
    expect(inspector?.textContent).not.toContain('arg[')
    const closeInspector = inspector?.querySelector<HTMLButtonElement>('[aria-label="Close log details"]')
    expect(closeInspector?.textContent).toBe('')
    expect(closeInspector?.classList.contains('cxm-manager-icon-action')).toBe(true)
    expect(dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="copy"]')?.disabled).toBe(false)
    const search = dom.window.document.querySelector<HTMLInputElement>('[data-console-search="console-showcase"]')
    search!.value = 'inspectable error'
    search!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await waitForState(() => dom.window.document.querySelector('[data-console-entry]') !== null, 'search projection')
    expect(dom.window.document.querySelector('[data-console-entry]')?.getAttribute('data-console-source')).toBe('console.info')
    expect(dom.window.document.querySelector('[data-console-source="console.warn"]')).toBeNull()
    const resetSearch = dom.window.document.querySelector<HTMLInputElement>('[data-console-search="console-showcase"]')
    resetSearch!.value = ''
    resetSearch!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const source = dom.window.document.querySelector<TestTDesignSelect>('t-select[aria-label="Log source"]')
    source!.setSelectedValue('console.warn', true)
    await waitForState(() => dom.window.document.querySelector('[data-console-entry]') !== null, 'source projection')
    expect(dom.window.document.querySelector('[data-console-entry]')?.getAttribute('data-console-source')).toBe('console.warn')
    expect(dom.window.document.querySelector('[data-console-source="console.log"]')).toBeNull()
    const resetSource = dom.window.document.querySelector<TestTDesignSelect>('t-select[aria-label="Log source"]')
    resetSource!.setSelectedValue('all', true)
    const kind = dom.window.document.querySelector<TestTDesignSelect>('t-select[aria-label="API / type"]')
    kind!.setSelectedValue('console', true)
    const scopedFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
    await waitForState(() => scopedFrame?.querySelector('[data-console-source="console.log"]') !== null, 'Console-only projection')
    expect(scopedFrame?.querySelector('[data-console-source="console.log"]')).not.toBeNull()
    expect(scopedFrame?.querySelector('[data-console-source="settings.get"]')).toBeNull()

    Object.defineProperties(scopedFrame!, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 200 },
    })
    scopedFrame!.scrollTop = 180
    scopedFrame!.dispatchEvent(new dom.window.Event('scroll'))
    const latest = scopedFrame!.parentElement?.querySelector<HTMLButtonElement>('.cxm-console-latest')
    expect(latest?.hidden).toBe(false)
    expect(latest?.textContent).toBe('')
    expect(latest?.getAttribute('aria-label')).toBe('Back to latest')
    expect(latest?.querySelector('[data-material-icon="console-follow"]')).not.toBeNull()
    latest?.click()
    expect(scopedFrame!.scrollTop).toBe(800)

    const modal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')
    expect(modal?.dataset.cordisxAppTheme).toBe('dark')
    dom.window.document.documentElement.className = 'electron-light'
    await waitForState(() => modal?.dataset.cordisxAppTheme === 'light', 'Host light theme projection')
    expect(modal?.dataset.cordisxAppTheme).toBe('light')
    expect(scopedFrame?.classList.contains('luna-console-theme-light')).toBe(true)

    const clear = dom.window.document.querySelector<HTMLButtonElement>('[data-console-action="clear"]')
    clear?.click()
    expect(runtime!.pluginConsole('console-showcase').entries).toEqual([])
    expect(dom.window.document.querySelector('[data-plugin-console="console-showcase"] .cxm-console-empty')?.textContent).toContain('Waiting for plugin logs')
    dom.window.document.documentElement.lang = 'zh-CN'
    await waitForState(() => dom.window.document.querySelector('[data-tab="about"]')?.textContent === '关于 CordisX', 'zh primary navigation')
    const zhToolbar = dom.window.document.querySelector('[role="toolbar"][aria-label="Console 显示控制"]')
    expect([...zhToolbar?.querySelectorAll<HTMLButtonElement>('[data-console-action]') ?? []].map(button => button.getAttribute('aria-label')))
      .toEqual(['暂停采集', '停止跟随', '清空日志', '复制所选', '导出插件日志'])
    await runtime!.setPluginBlocked('console-showcase', true)
    await runtime!.setPluginBlocked('console-showcase', false)
    expect(runtime!.pluginConsole('console-showcase').entries.some(entry => entry.phase === 'reload')).toBe(true)
  }, RUNTIME_INTEGRATION_TIMEOUT_MS)
})
