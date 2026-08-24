import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

interface RuntimeHandle {
  snapshot(): {
    plugins: readonly {
      id: string
      status: string
      configuration: { revision: number; applies: string; fields: readonly { path: readonly string[]; role?: string }[] }
    }[]
  }
  updatePluginConfig(id: string, expectedRevision: number, operations: readonly {
    op: 'set' | 'unset'
    path: readonly string[]
    value?: unknown
  }[]): Promise<void>
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  dispose(): Promise<void>
}

interface BridgeState {
  revision: number
  config: unknown
  candidate?: { revision: number; config: unknown }
}

async function boot(): Promise<{
  dom: JSDOM
  runtime: RuntimeHandle
  bridge: Map<string, BridgeState>
  failCommit: Set<string>
}> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const config: CordisXConfig = {
    version: 1,
    rootDir: root,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [
      {
        id: 'live-config',
        entry: path.join(root, 'tests/fixtures/live-config-plugin.ts'),
        enabled: true,
        config: { timeout: 30 },
        revision: 0,
      },
      {
        id: 'restart-config',
        entry: path.join(root, 'tests/fixtures/restart-config-plugin.ts'),
        enabled: true,
        config: { label: 'good' },
        revision: 0,
      },
    ],
  }
  const token = 'a'.repeat(64)
  const bundle = await buildRendererBundle(config, { profileId: 'work', configBridgeToken: token })
  const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>
    <div class="sidebar-header"><button id="workspace" aria-haspopup="menu">Codex</button></div>
  </body></html>`, { runScripts: 'dangerously', url: 'https://codex.local/native' })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  Object.defineProperty(dom.window, 'fetch', {
    value: async () => ({ ok: false, status: 503, url: 'https://cordisx.github.io/marketplace/index.json', text: async () => '' }),
  })
  const bridge = new Map<string, BridgeState>([
    ['live-config', { revision: 0, config: { timeout: 30 } }],
    ['restart-config', { revision: 0, config: { label: 'good' } }],
  ])
  const failCommit = new Set<string>()
  ;(dom.window as unknown as Record<string, unknown>).__cordisxConfigRequestV1 = (payload: string) => {
    const request = JSON.parse(payload) as {
      requestId: string
      operation: 'stage' | 'commit' | 'abort'
      identity: { pluginId: string }
      expectedRevision?: number
      candidateRevision?: number
      config?: unknown
    }
    const state = bridge.get(request.identity.pluginId)!
    let response: Record<string, unknown>
    if (request.operation === 'stage') {
      if (state.revision !== request.expectedRevision || state.candidate !== undefined) {
        response = { requestId: request.requestId, ok: false, code: 'conflict', actualRevision: state.revision, error: 'conflict' }
      } else {
        state.candidate = { revision: state.revision + 1, config: request.config }
        response = { requestId: request.requestId, ok: true, value: { candidateRevision: state.revision + 1 } }
      }
    } else if (request.operation === 'commit') {
      if (failCommit.delete(request.identity.pluginId)) {
        response = { requestId: request.requestId, ok: false, code: 'rejected', error: 'simulated persistence failure' }
      } else
      if (state.candidate?.revision !== request.candidateRevision) {
        response = { requestId: request.requestId, ok: false, code: 'conflict', actualRevision: state.revision, error: 'conflict' }
      } else {
        state.revision = state.candidate.revision
        state.config = state.candidate.config
        delete state.candidate
        response = { requestId: request.requestId, ok: true, value: { revision: state.revision } }
      }
    } else {
      delete state.candidate
      response = { requestId: request.requestId, ok: true }
    }
    queueMicrotask(() => {
      const receive = (dom.window as unknown as Record<string, unknown>).__cordisxConfigReceiveV1 as ((value: string) => void) | undefined
      receive?.(JSON.stringify(response))
    })
  }
  dom.window.eval(bundle)
  for (let attempt = 0; attempt < 50 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
  if (runtime === undefined) throw new Error('CordisX runtime did not start')
  return { dom, runtime, bridge, failCommit }
}

describe('plugin config runtime', () => {
  it('publishes live config without apply and restarts only the owning fiber', async () => {
    const { dom, runtime, bridge } = await boot()
    const global = dom.window as unknown as {
      __cordisxConfigFixture: { liveApply: number; liveDispose: number; liveValues: number[] }
      __cordisxRestartConfigFixture: { restartApply: string[]; restartDispose: number }
    }
    expect(global.__cordisxConfigFixture.liveApply).toBe(1)
    expect(global.__cordisxRestartConfigFixture.restartApply).toEqual(['good'])

    await runtime.updatePluginConfig('live-config', 0, [{ op: 'set', path: ['timeout'], value: 45 }])
    expect(global.__cordisxConfigFixture.liveApply).toBe(1)
    expect(global.__cordisxConfigFixture.liveDispose).toBe(0)
    expect(global.__cordisxConfigFixture.liveValues).toEqual([30, 45])
    expect(bridge.get('live-config')).toMatchObject({ revision: 1, config: { timeout: 45 } })

    await runtime.updatePluginConfig('restart-config', 0, [{ op: 'set', path: ['label'], value: 'next' }])
    expect(global.__cordisxRestartConfigFixture.restartApply).toEqual(['good', 'next'])
    expect(global.__cordisxRestartConfigFixture.restartDispose).toBe(1)
    expect(global.__cordisxConfigFixture.liveApply).toBe(1)
    expect(runtime.snapshot().plugins.find(plugin => plugin.id === 'restart-config')?.configuration.revision).toBe(1)
    await runtime.dispose()
  })

  it('aborts a failed restart candidate and restores last-good on a fresh fiber', async () => {
    const { dom, runtime, bridge } = await boot()
    const state = (dom.window as unknown as {
      __cordisxRestartConfigFixture: { restartApply: string[]; restartDispose: number }
    }).__cordisxRestartConfigFixture
    await expect(runtime.updatePluginConfig('restart-config', 0, [{ op: 'set', path: ['label'], value: 'fail' }]))
      .rejects.toThrow('last-good restored')
    expect(state.restartApply).toEqual(['good', 'fail', 'good'])
    expect(bridge.get('restart-config')).toMatchObject({ revision: 0, config: { label: 'good' } })
    expect(bridge.get('restart-config')?.candidate).toBeUndefined()
    expect(runtime.snapshot().plugins.find(plugin => plugin.id === 'restart-config')).toMatchObject({
      status: 'active',
      configuration: { revision: 0 },
    })
    await runtime.dispose()
  })

  it('persists a blocked restart config without mounting until restore', async () => {
    const { dom, runtime } = await boot()
    const state = (dom.window as unknown as {
      __cordisxRestartConfigFixture: { restartApply: string[]; restartDispose: number }
    }).__cordisxRestartConfigFixture
    await runtime.setPluginBlocked('restart-config', true)
    await runtime.updatePluginConfig('restart-config', 0, [{ op: 'set', path: ['label'], value: 'blocked-next' }])
    expect(state.restartApply).toEqual(['good'])
    expect(runtime.snapshot().plugins.find(plugin => plugin.id === 'restart-config')).toMatchObject({
      status: 'blocked',
      configuration: { revision: 1 },
    })
    await runtime.setPluginBlocked('restart-config', false)
    expect(state.restartApply).toEqual(['good', 'blocked-next'])
    await runtime.dispose()
  })

  it('rolls back a mounted candidate when durable commit fails', async () => {
    const { dom, runtime, bridge, failCommit } = await boot()
    const state = (dom.window as unknown as {
      __cordisxRestartConfigFixture: { restartApply: string[]; restartDispose: number }
    }).__cordisxRestartConfigFixture
    failCommit.add('restart-config')
    await expect(runtime.updatePluginConfig('restart-config', 0, [{ op: 'set', path: ['label'], value: 'candidate' }]))
      .rejects.toThrow('simulated persistence failure')
    expect(state.restartApply).toEqual(['good', 'candidate', 'good'])
    expect(bridge.get('restart-config')).toMatchObject({ revision: 0, config: { label: 'good' } })
    expect(bridge.get('restart-config')?.candidate).toBeUndefined()
    expect(runtime.snapshot().plugins.find(plugin => plugin.id === 'restart-config')).toMatchObject({
      status: 'active',
      configuration: { revision: 0 },
    })
    await runtime.dispose()
  })

  it('reports failed when both candidate start and last-good rollback fail', async () => {
    const { dom, runtime, bridge } = await boot()
    const state = (dom.window as unknown as {
      __cordisxRestartConfigFixture: { restartApply: string[]; restartDispose: number }
    }).__cordisxRestartConfigFixture
    await expect(runtime.updatePluginConfig('restart-config', 0, [{ op: 'set', path: ['label'], value: 'fail-rollback' }]))
      .rejects.toThrow('last-good rollback failed')
    expect(state.restartApply).toEqual(['good', 'fail-rollback', 'good'])
    expect(bridge.get('restart-config')).toMatchObject({ revision: 0, config: { label: 'good' } })
    expect(runtime.snapshot().plugins.find(plugin => plugin.id === 'restart-config')).toMatchObject({
      status: 'failed',
      configuration: { revision: 0 },
    })
    await runtime.dispose()
  })

  it('mounts custom field UI and cleans it on owning plugin block', async () => {
    const { dom, runtime } = await boot()
    const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
    trigger.click()
    const row = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-plugin-id]')]
      .find(element => element.dataset.pluginId === 'live-config')
    row?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
    for (let attempt = 0; attempt < 20
      && dom.window.document.querySelector('input[type="range"][data-host-form-primitive="custom"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const configPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="配置管理"]')
    const timeoutField = configPanel?.querySelector<HTMLElement>('[data-config-path="timeout"]')
    const secretField = configPanel?.querySelector<HTMLElement>('[data-config-path="apiKey"]')
    expect(configPanel?.textContent).not.toContain('Schemastery')
    expect(configPanel?.textContent).not.toContain('实时发布（不重载）')
    expect(configPanel?.textContent).not.toContain('Revision')
    expect(configPanel?.querySelector('.cxm-detail-grid')).toBeNull()
    expect(configPanel?.querySelector('.cxm-config-path')).toBeNull()
    expect(timeoutField?.querySelector('.cxf-label')?.textContent).toBe('Request timeout')
    expect(timeoutField?.querySelector('.cxf-help')?.textContent).toBe('Live timeout')
    expect(secretField?.querySelector('.cxf-label')?.textContent).toBe('Api Key')
    expect(secretField?.querySelectorAll('.cxf-alert')).toHaveLength(1)
    expect(configPanel?.textContent).not.toContain('Host 保留了')
    const state = (dom.window as unknown as {
      __cordisxConfigFixture: { rendererMount: number; rendererDispose: number; rendererAbort: number }
    }).__cordisxConfigFixture
    const range = dom.window.document.querySelector<HTMLInputElement>('input[type="range"]')
    const save = configPanel?.querySelector<HTMLButtonElement>('button[type="submit"]')
    expect(range).not.toBeNull()
    expect(save?.disabled).toBe(true)
    range!.value = '45'
    range!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(save?.disabled).toBe(false)
    expect(state.rendererMount).toBe(1)
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.click()
    const diagnostics = dom.window.document.querySelector<HTMLDetailsElement>('[data-runtime-diagnostics="platform"]')
    expect(diagnostics?.open).toBe(false)
    expect(diagnostics?.querySelector('[data-config-diagnostics="live-config"]')?.textContent)
      .toBe('配置：Schemastery · live · revision 0 · last-good 0 · writer available')
    await runtime.setPluginBlocked('live-config', true)
    expect(state.rendererAbort).toBe(1)
    expect(state.rendererDispose).toBe(1)
    expect(dom.window.document.querySelector('input[type="range"]')).toBeNull()
    await runtime.dispose()
  })

  it('keeps a custom-renderer draft and exposes a bounded form error after a CAS conflict', async () => {
    const { dom, runtime, bridge } = await boot()
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    ;[...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-plugin-id]')]
      .find(element => element.dataset.pluginId === 'live-config')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
    for (let attempt = 0; attempt < 20
      && dom.window.document.querySelector('input[type="range"][data-host-form-primitive="custom"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const range = dom.window.document.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(dom.window.document.querySelectorAll('#cxm-config-live-config-0')).toHaveLength(1)
    expect(range.dataset.hostFormPrimitive).toBe('custom')
    expect(range.getAttribute('aria-describedby')).toContain('cxm-config-live-config-0-error')
    range.value = '45'
    range.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(dom.window.document.querySelector('[data-plugin-config-form="live-config"]')?.getAttribute('data-state')).toBe('dirty')

    bridge.get('live-config')!.revision = 1
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-config-form="live-config"] button[type="submit"]')!.click()
    for (let attempt = 0; attempt < 30 && dom.window.document.querySelector('[data-plugin-config-form="live-config"][data-state="conflict"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const conflicted = dom.window.document.querySelector<HTMLElement>('[data-plugin-config-form="live-config"]')!
    expect(conflicted.dataset.state).toBe('conflict')
    expect(dom.window.document.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('45')
    expect(dom.window.document.querySelector('.cxf-alert[data-tone="error"]')?.textContent).toContain('草稿仍保留')
    expect(conflicted.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
    await runtime.dispose()
  })
})
