import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { Config } from '../packages/cli/src/plugins/cli-proxy-api/index.js'

interface RuntimeHandle {
  navigate(owner: string, reference: { id: string }): Promise<void>
  snapshot(): {
    plugins: readonly {
      id: string
      readme?: string
      configuration: {
        schemaKind: string
        applies: string
        writable: boolean
        value: unknown
        fields: readonly { path: readonly string[]; label?: string; description?: string; role?: string }[]
      }
    }[]
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
  it('exports a renderer-only Schemastery Config with safe defaults and validation', () => {
    expect(Config({})).toEqual({ providerIds: [], defaultCwd: '' })
    expect(Config({ providerIds: ['gateway-a', 'gateway-a', 'region.eu_1'], defaultCwd: '/workspace' })).toEqual({
      providerIds: ['gateway-a', 'gateway-a', 'region.eu_1'],
      defaultCwd: '/workspace',
    })
    expect(() => Config({ providerIds: ['Gateway-A'], defaultCwd: '' })).toThrow(/match regexp/i)
    expect(() => Config({ providerIds: [null], defaultCwd: '' } as never)).toThrow(/required value/i)
    expect(() => Config({ providerIds: Array.from({ length: 65 }, (_, index) => `gateway-${index}`), defaultCwd: '' })).toThrow(/length/i)
    expect(() => Config({ providerIds: [], defaultCwd: `bad\0path` })).toThrow(/match regexp/i)
    expect(Config.meta).not.toHaveProperty('role')
    expect(Config.dict?.providerIds?.meta.role).toBeUndefined()
    expect(Config.dict?.defaultCwd?.meta.role).toBeUndefined()
    expect(Object.keys(Config.dict ?? {})).toEqual(['providerIds', 'defaultCwd'])
    expect(Config.dict?.providerIds?.meta.extra?.label).toEqual({ 'zh-CN': 'Provider 过滤范围', en: 'Provider filter' })
    expect(Config.dict?.providerIds?.meta.description).toMatchObject({
      'zh-CN': expect.stringContaining('launcher 配置并启用'),
      en: expect.stringContaining('launcher-configured, enabled Provider IDs'),
    })
    expect(Config.dict?.defaultCwd?.meta.extra?.label).toEqual({ 'zh-CN': '默认工作目录', en: 'Default working directory' })
  })

  it('uses the existing main outlet and keeps provider identity in models and colliding session rows', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(root, 'cordisx.cli-proxy.example.json'))
    const token = 'integration-provider-token'
    const configToken = 'c'.repeat(64)
    const bundle = await buildRendererBundle(config, {
      providerBridgeToken: token,
      configBridgeToken: configToken,
      profileId: 'default',
      generation: 'cli-proxy-config-test',
    })
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
    const configRequests: { operation: string; config?: unknown }[] = []
    let configCandidate: { revision: number; config: unknown } | undefined
    let configRevision = 0
    Object.defineProperty(dom.window, '__cordisxConfigRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as {
          requestId: string
          token: string
          operation: 'stage' | 'commit' | 'abort'
          identity: { pluginId: string }
          expectedRevision?: number
          candidateRevision?: number
          config?: unknown
        }
        expect(request.token).toBe(configToken)
        expect(request.identity.pluginId).toBe('cli-proxy-api')
        configRequests.push({ operation: request.operation, ...(request.config === undefined ? {} : { config: request.config }) })
        let value: unknown
        if (request.operation === 'stage') {
          expect(request.expectedRevision).toBe(configRevision)
          configCandidate = { revision: configRevision + 1, config: request.config }
          value = { candidateRevision: configCandidate.revision }
        } else if (request.operation === 'commit') {
          expect(request.candidateRevision).toBe(configCandidate?.revision)
          configRevision = configCandidate!.revision
          configCandidate = undefined
          value = { revision: configRevision }
        } else {
          configCandidate = undefined
        }
        queueMicrotask(() => {
          const receiver = (dom.window as unknown as { __cordisxConfigReceiveV1?: (response: string) => void }).__cordisxConfigReceiveV1
          receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      },
    })
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
        } else if (request.operation === 'availability') {
          value = [
            { providerId: 'gateway-a', displayName: 'Gateway A', generation: 'generation-a', state: 'ready' },
            { providerId: 'gateway-b', displayName: 'Gateway B', generation: 'generation-b', state: 'ready' },
          ]
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
    expect(bundledPlugin?.configuration).toMatchObject({
      schemaKind: 'schemastery',
      applies: 'restart',
      writable: true,
      value: {},
    })
    expect(bundledPlugin?.configuration.fields.map(field => field.path)).toEqual([
      ['providerIds'],
      ['defaultCwd'],
    ])
    await runtime!.navigate('cli-proxy-api', { id: 'providers.sessions' })
    for (let attempt = 0; attempt < 100 && dom.window.document.querySelectorAll('[data-session]').length < 2; attempt += 1) {
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-decision="allow"]')?.click()
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
    expect(requests.map(request => request.operation)).toEqual(expect.arrayContaining(['status', 'availability', 'models.list', 'tasks.list']))
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
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
    const configPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="配置管理"]')
    const providerField = configPanel?.querySelector<HTMLElement>('[data-config-path="providerIds"]')
    const cwdField = configPanel?.querySelector<HTMLElement>('[data-config-path="defaultCwd"]')
    expect(providerField?.querySelector('.cxm-config-label')?.textContent).toBe('Provider filter')
    expect(providerField?.querySelector('.cxm-config-help')?.textContent)
      .toBe('Show only these launcher-configured, enabled Provider IDs; leave empty for all, with at most 64 IDs. Connections and credentials cannot be added here.')
    expect(cwdField?.querySelector('.cxm-config-label')?.textContent).toBe('Default working directory')
    expect(providerField?.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('[]')
    expect(cwdField?.querySelector<HTMLInputElement>('input')?.value).toBe('')
    expect(configPanel?.textContent).not.toContain('renderer 不会直接写配置文件')
    expect(configPanel?.querySelector('[data-config-path="baseUrl"]')).toBeNull()
    expect(configPanel?.querySelector('[data-config-path="apiKey"]')).toBeNull()
    expect(configPanel?.querySelector('[data-config-path="codexExecutable"]')).toBeNull()
    const providerInput = providerField!.querySelector<HTMLTextAreaElement>('textarea')!
    const submit = configPanel!.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    providerInput.value = '["Gateway-A"]'
    providerInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(false)
    configPanel!.querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[role="alert"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('expect string to match regexp')
    expect(configRequests).toEqual([])

    const validPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="配置管理"]')!
    const validInput = validPanel.querySelector<HTMLTextAreaElement>('[data-config-path="providerIds"] textarea')!
    validInput.value = '["gateway-a"]'
    validInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    validPanel.querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
    for (let attempt = 0; attempt < 100 && configRevision < 1; attempt += 1) {
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-decision="allow"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(configRequests).toEqual([
      { operation: 'stage', config: { providerIds: ['gateway-a'] } },
      { operation: 'commit' },
    ])
    expect(runtime!.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')?.configuration)
      .toMatchObject({ revision: 1, value: { providerIds: ['gateway-a'] } })
    await runtime!.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-provider-fleet]')).toBeNull()
  })
})
