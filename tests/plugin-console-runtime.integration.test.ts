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
      capability: 'models.read',
      scope: {},
      policy: 'deny',
    })
    bundle = await buildRendererBundle(config, {
      permission: { profileId: 'console-smoke', policies: [denial], bridgeToken: 'console-smoke-token' },
    })
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
    const dom = new JSDOM(
      '<html class="electron-dark"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      {
        runScripts: 'dangerously',
        url: 'https://codex.local/',
        pretendToBeVisual: true,
      },
    )
    activeDom = dom
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function() {
        const height = (this as HTMLElement).classList.contains('luna-console') ? 240 : 24
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) }
      },
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: function() {
        return (this as HTMLElement).classList.contains('luna-console') ? 240 : 24
      },
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get: () => dom.window.document.body,
    })
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', { configurable: true, value: () => {} })
    dom.window.eval(bundle)
    await waitForState(() => dom.window.document.documentElement.dataset.cordisxReady === 'true', 'renderer readiness')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: TestRuntime }).__cordisxRuntime
    expect(runtime).toBeDefined()
    activeRuntime = runtime
    await waitForState(() =>
      runtime!.pluginConsole('console-showcase').entries.some(entry => (
        entry.source === 'platform.models.list' && (entry.phase === 'failure' || entry.phase === 'success')
      )), 'terminal Host invocation')

    const silent = runtime!.pluginConsole('silent-api')
    expect(silent.entries.some(entry => entry.source === 'settings.get' && entry.phase === 'success')).toBe(true)
    expect(silent.entries.some(entry => entry.kind === 'console')).toBe(false)

    const showcase = runtime!.pluginConsole('console-showcase')
    expect(showcase.entries.filter(entry => entry.kind === 'console').map(entry => entry.method)).toEqual([
      'debug',
      'log',
      'info',
      'warn',
      'error',
    ])
    expect(showcase.entries.some(entry => entry.source === 'settings.get' && entry.phase === 'success')).toBe(true)
    expect(showcase.entries.some(entry => entry.source === 'platform.models.list' && entry.phase === 'failure')).toBe(
      true,
    )
    expect(showcase.entries.some(entry => entry.kind === 'permission' && entry.phase === 'deny')).toBe(true)
    expect(showcase.entries.every(entry => entry.plugin.pluginId === 'console-showcase')).toBe(true)
    expect(silent.entries.every(entry => entry.plugin.pluginId === 'silent-api')).toBe(true)
    expect(
      showcase.entries.find(entry => entry.method === 'info' && entry.kind === 'console')?.args.some(arg =>
        arg.type === 'error'
      ),
    ).toBe(true)

    dom.window.dispatchEvent(
      new dom.window.ErrorEvent('error', { filename: 'codex-native.js', error: new Error('native') }),
    )
    expect(runtime!.pluginConsole('console-showcase').unattributedEntries).toBeUndefined()
    dom.window.dispatchEvent(
      new dom.window.ErrorEvent('error', {
        filename: pathToFileURL(showcaseEntry).href,
        error: new Error('plugin boundary'),
      }),
    )
    expect(runtime!.pluginConsole('console-showcase').entries.some(entry => entry.coverage === 'best-effort')).toBe(
      true,
    )
    dom.window.dispatchEvent(
      new dom.window.ErrorEvent('error', {
        filename: `${pathToFileURL(showcaseEntry).href}\n${pathToFileURL(silentEntry).href}`,
        error: new Error('shared plugin boundary'),
      }),
    )
    expect(runtime!.pluginConsole('console-showcase').unattributedEntries).toBe(1)

    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger="true"]')?.click()
    await waitForState(
      () => dom.window.document.querySelector('[data-plugin-id="console-showcase"]') !== null,
      'React plugin list',
    )
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="console-showcase"]')?.click()
    await waitForState(
      () => dom.window.document.querySelector('[data-plugin-detail-tab="runtime"]') !== null,
      'React plugin details',
    )
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.click()
    await waitForState(
      () => dom.window.document.querySelector('[data-plugin-runtime-status="console-showcase"]') !== null,
      'React runtime panel',
    )
    expect(dom.window.document.querySelector('[data-plugin-runtime-status="console-showcase"]')).not.toBeNull()
    const runtimeOverview = dom.window.document.querySelector<HTMLElement>('.cxm-runtime-overview')!
    expect(runtimeOverview.querySelector('[data-runtime-console-summary="console-showcase"]')).not.toBeNull()
    expect(runtimeOverview.querySelectorAll('.cxm-runtime-console-metric')).toHaveLength(4)
    expect(runtimeOverview.querySelector('[data-runtime-lifecycle="console-showcase"]')).toBeNull()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="logs"]')?.click()
    await waitForState(
      () => dom.window.document.querySelector('[role="tabpanel"][aria-label="Logs & diagnostics"]') !== null,
      'React logs panel',
    )
    let consoleFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
    await waitForState(() => {
      consoleFrame = dom.window.document.querySelector<HTMLElement>('[data-plugin-console="console-showcase"]')
      return (consoleFrame?.querySelectorAll('[data-console-entry]').length ?? 0) > 10
    }, 'Luna Console mount')
    expect(consoleFrame?.textContent).toBeTruthy()
    expect(consoleFrame?.classList.contains('luna-console')).toBe(true)
    expect(consoleFrame?.querySelector('.luna-text-viewer-text, pre')).toBeNull()
    const lunaEntries = [...(consoleFrame?.querySelectorAll<HTMLElement>('[data-console-entry]') ?? [])]
    expect(lunaEntries.length).toBeGreaterThan(10)
    expect(lunaEntries).toHaveLength(runtime!.pluginConsole('console-showcase').entries.length)
    expect(lunaEntries.some(item => item.dataset.method === 'debug')).toBe(true)
    expect(lunaEntries.some(item => item.dataset.method === 'warn')).toBe(true)
    expect(lunaEntries.some(item => item.dataset.method === 'error')).toBe(true)
    const logsPanel = consoleFrame?.closest<HTMLElement>('[role="tabpanel"]')!
    expect(logsPanel.classList.contains('cxm-console-panel')).toBe(true)
    expect(logsPanel.querySelector('.cxm-console-summary')).toBeNull()
    expect(logsPanel.querySelector('[data-runtime-lifecycle="console-showcase"]')).toBeNull()
    const reactEntriesBeforeLiveUpdate = runtime!.pluginConsole('console-showcase').entries.length
    await runtime!.setPluginBlocked('console-showcase', true)
    await waitForState(
      () => runtime!.pluginConsole('console-showcase').entries.length > reactEntriesBeforeLiveUpdate,
      'live Console append',
    )
    await runtime!.dispose()
  }, RUNTIME_INTEGRATION_TIMEOUT_MS)
})
