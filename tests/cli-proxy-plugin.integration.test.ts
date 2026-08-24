import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

interface RuntimeHandle {
  navigate(owner: string, reference: { id: string }): Promise<void>
  snapshot(): {
    plugins: readonly { id: string; readme?: string }[]
    platform: { mode: string; diagnostics: readonly { code: string }[] }
    permissions: readonly { capability: string; lastRequested?: unknown }[]
  }
  dispose(): Promise<void>
}

function session(providerId: string) {
  return {
    contract: 'cordisx.platform-session/v1', schemaVersion: 1,
    ref: { providerId, remoteSessionId: 'shared-session' },
    hostId: `cli-proxy-api:${providerId}`,
    model: { providerId, modelId: 'shared-model' }, cwd: '/workspace', title: `${providerId} conversation`, state: 'active',
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: providerId === 'gateway-a' ? '2026-08-24T02:00:00.000Z' : '2026-08-24T01:00:00.000Z',
  }
}

describe('CLIProxy provider plugin renderer', () => {
  it('uses the existing main outlet and keeps provider identity in models and colliding session rows', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(root, 'cordisx.cli-proxy.example.json'))
    const token = 'integration-provider-token'
    const bundle = await buildRendererBundle(config, { providerBridgeToken: token })
    const dom = new JSDOM(`
      <html lang="en" class="electron-dark"><head></head><body>
        <header data-app-shell-application-menu-bar><div data-test-id="header-shell-slot"><div><div><button>Native</button></div></div></div></header>
        <aside><div data-app-action-sidebar-scroll><div id="native-navigation"><button>New conversation</button></div></div><button aria-label="Help">Help</button></aside>
        <main data-app-shell-main-content-layout="thread-edge-scroll"><section data-codex-thread-reference-drop-target><div id="native-conversation">native session remains</div></section></main>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel', configurable: true })
    Object.defineProperty(dom.window, 'confirm', { value: () => true })
    const requests: { operation: string; input: Record<string, unknown> }[] = []
    Object.defineProperty(dom.window, '__cordisxProviderRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; operation: string; input: Record<string, unknown> }
        expect(request.token).toBe(token)
        requests.push({ operation: request.operation, input: request.input })
        let value: unknown
        if (request.operation === 'status') {
          value = {
            hostId: 'cordisx-provider-fleet', hostName: 'CordisX External Provider Fleet', mode: 'read-write',
            supportedCapabilities: ['models.read', 'tasks.catalog.read', 'tasks.content.read', 'tasks.create', 'tasks.control', 'turns.submit', 'turns.control'],
            diagnostics: [{ code: 'current-connection-client-unavailable', message: 'native remains unavailable' }],
            secondConnectionCreated: false, rawBridgeExposed: false,
          }
        } else if (request.operation === 'models.list') {
          value = { ok: true, value: {
            contract: 'cordisx.platform-model-page/v1', schemaVersion: 1, providerIds: ['gateway-a', 'gateway-b'],
            models: ['gateway-a', 'gateway-b'].map(providerId => ({
              contract: 'cordisx.platform-model/v1', schemaVersion: 1, ref: { providerId, modelId: 'shared-model' },
              hostId: `cli-proxy-api:${providerId}`, label: 'Shared model', isDefault: true,
            })),
          } }
        } else if (request.operation === 'tasks.list') {
          value = { ok: true, value: {
            contract: 'cordisx.platform-session-page/v1', schemaVersion: 1,
            query: { providerIds: ['gateway-a', 'gateway-b'], limit: 50 }, snapshotId: 'snapshot-1',
            sessions: [session('gateway-a'), session('gateway-b')],
          } }
        } else {
          value = { ok: false, error: { code: 'invalid-request', message: 'unexpected test operation' } }
        }
        queueMicrotask(() => {
          const receiver = (dom.window as unknown as { __cordisxProviderReceiveV1?: (response: string) => void }).__cordisxProviderReceiveV1
          receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      },
    })
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    expect(runtime?.snapshot().platform).toMatchObject({ mode: 'read-write' })
    expect(runtime?.snapshot().platform.diagnostics).toContainEqual(expect.objectContaining({ code: 'current-connection-client-unavailable' }))
    const bundledPlugin = runtime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')
    expect(bundledPlugin?.readme).toContain('# CLIProxy Providers')
    expect(bundledPlugin?.readme).toContain('Every model is identified by both `providerId` and `modelId`')
    await runtime!.navigate('cli-proxy-api', { id: 'providers.sessions' })
    for (let attempt = 0; attempt < 100 && dom.window.document.querySelectorAll('[data-session]').length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-provider-fleet="true"]')
    expect(page?.closest('[data-cordisx-page-outlet="main"]')).not.toBeNull()
    expect(dom.window.document.getElementById('native-conversation')?.textContent).toBe('native session remains')
    const modelLabels = [...page!.querySelectorAll('select[aria-label="Model"] option')].map(option => option.textContent)
    expect(modelLabels).toEqual(['[gateway-a] Shared model', '[gateway-b] Shared model'])
    const keys = [...page!.querySelectorAll<HTMLElement>('[data-session]')].map(row => row.dataset.session)
    expect(keys).toEqual([
      JSON.stringify(['gateway-a', 'shared-session']),
      JSON.stringify(['gateway-b', 'shared-session']),
    ])
    expect(requests.map(request => request.operation)).toEqual(expect.arrayContaining(['status', 'models.list', 'tasks.list']))
    expect(runtime!.snapshot().permissions.find(item => item.capability === 'tasks.catalog.read')?.lastRequested)
      .toMatchObject({ providerIds: ['gateway-a', 'gateway-b'] })

    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="cli-proxy-api"]')?.click()
    const readmePanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="README"]')
    expect(readmePanel?.querySelector('.cxm-readme h1')?.textContent).toBe('CLIProxy Providers')
    expect(readmePanel?.textContent).toContain('Configure providers')
    expect(readmePanel?.textContent).toContain('External providers and the native connection')
    expect(readmePanel?.textContent).not.toContain('该插件没有随当前 bundle 提供 README.md')
    await runtime!.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-provider-fleet]')).toBeNull()
  })
})
