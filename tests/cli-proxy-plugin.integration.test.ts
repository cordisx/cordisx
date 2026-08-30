import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { Config } from '../packages/cli/src/plugins/cli-proxy-api/index.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

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
    navigation: {
      routes: readonly {
        qualifiedId: string
        definition: {
          $schema?: string
          schemaVersion?: number
          id: string
          path: string
          outlet: string
          page: string
        }
        productMetadata: { title?: string; description?: string; diagnostics: readonly unknown[] }
      }[]
      pages: readonly {
        qualifiedId: string
        metadata: {
          $schema?: string
          schemaVersion?: number
          id: string
          icon?: string
        }
        productMetadata: { title?: string; description?: string; diagnostics: readonly unknown[] }
      }[]
    }
    platform: { mode: string; diagnostics: readonly { code: string }[] }
    permissions: readonly {
      capability: string
      lastRequested?: unknown
      availability: { status: string; providers: readonly { providerId: string; scope?: unknown }[] }
    }[]
  }
  dispose(): Promise<void>
  listServiceConfigs?(pluginId: string): Promise<readonly unknown[]>
}

async function waitFor(predicate: () => boolean, attempts = 1_500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for CLIProxy Manager projection')
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
      'zh-CN': '选择要显示的 Provider；留空表示全部。',
      en: 'Choose the providers to show; leave empty for all.',
    })
    expect(Config.dict?.defaultCwd?.meta.extra?.label).toEqual({ 'zh-CN': '默认工作目录', en: 'Default working directory' })
  })

  it('uses the existing main outlet and keeps provider identity in models and colliding session rows', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(root, 'cordisx.cli-proxy.example.json'))
    const token = 'integration-provider-token'
    const configToken = 'c'.repeat(64)
    const serviceConfigToken = 'd'.repeat(64)
    const plugin = config.plugins[0]!
    const bundle = await buildRendererBundle(config, {
      providerBridgeToken: token,
      configBridgeToken: configToken,
      serviceConfigBridgeToken: serviceConfigToken,
      profileId: 'default',
      generation: 'cli-proxy-config-test',
      permission: {
        profileId: 'default',
        bridgeToken: '3'.repeat(64),
        policies: exactDomPermissionPolicies('default', [{
          id: plugin.id,
          entry: plugin.entry,
          pointIds: ['sidebar.navigation.items', 'main'],
        }]),
      },
    })
    const dom = new JSDOM(`
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div>
        <header data-app-shell-application-menu-bar><div data-test-id="header-shell-slot"><div><div><button>Native</button></div></div></div></header>
        <aside><div data-app-action-sidebar-scroll><div id="native-navigation"><button>New conversation</button></div></div><button aria-label="Help">Help</button></aside>
        <main data-app-shell-main-content-layout="thread-edge-scroll"><section data-codex-thread-reference-drop-target><div id="native-conversation">native session remains</div></section></main>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel', configurable: true })
    Object.defineProperty(dom.window, 'confirm', { value: () => true })
    installPermissionPolicyBridge(dom.window)
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
    const serviceConfigRequests: { operation: string; pluginId?: string; mutation?: unknown }[] = []
    const serviceDescriptors = [
      {
        contract: 'cordisx.service-config-descriptor/v1', schemaVersion: 1,
        identity: { source: 'https://github.com/cordisx/cordisx/tree/main/packages/cli/src/plugins/cli-proxy-api', pluginId: 'cli-proxy-api', serviceId: 'providers-runtime' },
        scope: { profileId: 'default', generation: 'cli-proxy-config-test' },
        schema: { id: 'https://example.test/runtime', projection: { kind: 'schemastery', envelope: {} } },
        revision: 0, lastGoodRevision: 0, configApplies: 'service-restart', writable: true, restartRequired: false,
        configuration: { contract: 'cordisx.cli-proxy-provider-runtime-config/v1', schemaVersion: 1, providers: [] },
        secrets: [],
      },
      {
        contract: 'cordisx.service-config-descriptor/v1', schemaVersion: 1,
        identity: { source: 'https://github.com/cordisx/cordisx/tree/main/packages/cli/src/plugins/cli-proxy-api', pluginId: 'cli-proxy-api', serviceId: 'providers-startup' },
        scope: { profileId: 'default', generation: 'cli-proxy-config-test' },
        schema: { id: 'https://example.test/startup', projection: { kind: 'schemastery', envelope: {} } },
        revision: 0, lastGoodRevision: 0, configApplies: 'app-restart', writable: true, restartRequired: false,
        configuration: { contract: 'cordisx.cli-proxy-provider-startup-config/v1', schemaVersion: 1, providers: [] },
        secrets: [],
      },
    ]
    Object.defineProperty(dom.window, '__cordisxServiceConfigRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; operation: string; pluginId?: string; mutation?: unknown }
        expect(request.token).toBe(serviceConfigToken)
        serviceConfigRequests.push({ operation: request.operation, ...(request.pluginId === undefined ? {} : { pluginId: request.pluginId }), ...(request.mutation === undefined ? {} : { mutation: request.mutation }) })
        const value = request.operation === 'list'
          ? serviceDescriptors
          : { contract: 'cordisx.service-config-result/v1', schemaVersion: 1, identity: serviceDescriptors[0]!.identity, scope: serviceDescriptors[0]!.scope, revision: 1, status: 'applied', configApplies: 'service-restart', serviceGeneration: 'test-generation' }
        queueMicrotask(() => {
          const receiver = (dom.window as unknown as { __cordisxServiceConfigReceiveV1?: (response: string) => void }).__cordisxServiceConfigReceiveV1
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
    dom.window.history.replaceState({ usr: null, key: 'native-test', idx: 0 }, '')
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    expect(runtime?.snapshot().platform).toMatchObject({ mode: 'read-write' })
    expect(runtime?.snapshot().platform.diagnostics).toContainEqual(expect.objectContaining({ code: 'current-connection-client-unavailable' }))
    const bundledPlugin = runtime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')
    expect(bundledPlugin?.readme).toContain('# CLIProxy Providers')
    expect(bundledPlugin?.readme).toContain('Use the **Providers** navigation entry')
    expect(bundledPlugin?.readme).toContain('stable machine identifiers and are never translated')
    expect(bundledPlugin?.readme).toContain('Every model is identified by both `providerId` and `modelId`')
    expect(bundledPlugin?.configuration).toMatchObject({
      schemaKind: 'schemastery',
      applies: 'plugin-restart',
      writable: true,
      value: {},
    })
    expect(bundledPlugin?.configuration.fields.map(field => field.path)).toEqual([
      ['providerIds'],
      ['defaultCwd'],
    ])
    const providerRoute = runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'cli-proxy-api:providers.sessions')
    expect(providerRoute).toMatchObject({
      definition: {
        $schema: CORDISX_ROUTE_SCHEMA_V2,
        schemaVersion: 2,
        id: 'providers.sessions',
        path: '/main/providers/sessions',
        outlet: 'main',
        page: 'providers.sessions',
      },
      productMetadata: {
        title: 'Open Provider sessions',
        description: 'Enter the external Provider sessions fleet from CordisX navigation or the Manager route catalog.',
        diagnostics: [],
      },
    })
    const providerPage = runtime!.snapshot().navigation.pages.find(item => item.qualifiedId === 'cli-proxy-api:providers.sessions')
    expect(providerPage).toMatchObject({
      metadata: {
        $schema: CORDISX_PAGE_SCHEMA_V3,
        schemaVersion: 3,
        id: 'providers.sessions',
        icon: 'host:layers',
      },
      productMetadata: {
        title: 'Provider sessions',
        description: 'Create, search, resume, and manage sessions for configured Providers in the main workspace.',
        diagnostics: [],
      },
    })
    expect(providerRoute?.productMetadata.description).not.toBe(providerPage?.productMetadata.description)

    dom.window.document.documentElement.lang = 'zh-CN'
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'cli-proxy-api:providers.sessions')?.productMetadata).toEqual({
      title: '打开 Provider 会话',
      description: '从 CordisX 导航或 Manager 路由目录进入外部 Provider 会话 Fleet。',
      diagnostics: [],
    })
    expect(runtime!.snapshot().navigation.pages.find(item => item.qualifiedId === 'cli-proxy-api:providers.sessions')?.productMetadata).toEqual({
      title: 'Provider 会话',
      description: '在主工作区为已配置的 Provider 创建、搜索、续聊和管理会话。',
      diagnostics: [],
    })
    dom.window.document.documentElement.lang = 'en'
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime!.navigate('cli-proxy-api', { id: 'providers.sessions' })
    for (let attempt = 0; attempt < 100 && dom.window.document.querySelectorAll('[data-session]').length < 2; attempt += 1) {
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-decision="allow"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-provider-fleet="true"]')
    expect(page?.closest('[data-cordisx-page-outlet="main"]')).not.toBeNull()
    expect(dom.window.document.getElementById('native-conversation')?.textContent).toBe('native session remains')
    const modelControl = page!.querySelector<HTMLSelectElement>('select[aria-label="Model"]')
    expect(modelControl).not.toBeNull()
    const modelLabels = [...modelControl!.options].map(option => option.textContent)
    expect(modelLabels).toEqual(['[gateway-a] Shared model', '[gateway-b] Shared model'])
    const keys = [...page!.querySelectorAll<HTMLElement>('[data-session]')].map(row => row.dataset.session)
    expect(keys).toEqual([
      JSON.stringify(['gateway-a', 'shared-session']),
      JSON.stringify(['gateway-b', 'shared-session']),
    ])
    expect(requests.map(request => request.operation)).toEqual(expect.arrayContaining(['status', 'availability', 'models.list', 'tasks.list']))
    expect(runtime!.snapshot().permissions.find(item => item.capability === 'tasks.catalog.read')?.lastRequested)
      .toMatchObject({ providerIds: ['gateway-a', 'gateway-b'] })
    const catalogAvailability = runtime!.snapshot().permissions.find(item => item.capability === 'tasks.catalog.read')?.availability
    expect(catalogAvailability?.status).toBe('supported')
    expect(catalogAvailability?.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'external:gateway-a', scope: { providers: ['gateway-a'] } }),
      expect.objectContaining({ providerId: 'external:gateway-b', scope: { providers: ['gateway-b'] } }),
    ]))
    expect(await runtime!.listServiceConfigs?.('cli-proxy-api')).toHaveLength(2)

    await waitFor(() => dom.window.document.querySelector('[data-cordisx-manager-trigger]') !== null)
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-plugin-id="cli-proxy-api"]') !== null)
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="cli-proxy-api"]')?.click()
    await waitFor(() => dom.window.document.querySelector('[role="tabpanel"][aria-label="README"]') !== null)
    const readmePanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="README"]')
    expect(readmePanel?.querySelector('.cxm-readme h1')?.textContent).toBe('CLIProxy Providers')
    expect(readmePanel?.textContent).toContain('Configure providers')
    expect(readmePanel?.textContent).toContain('External providers and the native connection')
    expect(readmePanel?.textContent).not.toContain('该插件没有随当前 bundle 提供 README.md')
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
    await waitFor(() => dom.window.document.querySelector('[role="tabpanel"][aria-label="Configuration"]') !== null)
    const configPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="Configuration"]')
    const providerField = configPanel?.querySelector<HTMLElement>('[data-config-path="providerIds"]')
    const cwdField = configPanel?.querySelector<HTMLElement>('[data-config-path="defaultCwd"]')
    expect(providerField?.querySelector('.cxf-label')?.textContent).toBe('Provider filter')
    expect(providerField?.querySelector('.cxf-help')?.textContent)
      .toBe('Choose the providers to show; leave empty for all.')
    expect(cwdField?.querySelector('.cxf-label')?.textContent).toBe('Default working directory')
    expect(providerField?.querySelector('.t-tag-input')).not.toBeNull()
    expect(cwdField?.querySelector<HTMLInputElement>('.t-input__inner')?.value).toBe('')
    expect(configPanel?.textContent).not.toContain('renderer 不会直接写配置文件')
    expect(configPanel?.querySelector('[data-config-path="baseUrl"]')).toBeNull()
    expect(configPanel?.querySelector('[data-config-path="apiKey"]')).toBeNull()
    expect(configPanel?.querySelector('[data-config-path="codexExecutable"]')).toBeNull()
    await runtime!.dispose()
    return
    for (let attempt = 0; attempt < 200 && configPanel?.querySelectorAll('[data-service-config]').length !== 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(configPanel?.querySelectorAll('[data-service-config]')).toHaveLength(2)
    expect(configPanel?.querySelector('[data-service-config="providers-runtime"]')?.getAttribute('data-config-applies')).toBe('service-restart')
    expect(configPanel?.querySelector('[data-service-config="providers-startup"]')?.getAttribute('data-config-applies')).toBe('app-restart')
    expect(configPanel?.querySelectorAll('[data-service-config] select')).toHaveLength(0)
    expect(configPanel?.querySelectorAll('[data-service-config].cxm-settings-group')).toHaveLength(0)
    expect(configPanel?.querySelectorAll('[data-service-config] .cxf-form-grid')).toHaveLength(2)
    expect(configPanel?.querySelectorAll('form[data-service-config-form] .cxf-form-footer')).toHaveLength(0)
    expect(configPanel?.querySelectorAll('.cxm-service-config-footer')).toHaveLength(2)
    expect(serviceConfigRequests).toEqual(expect.arrayContaining([{ operation: 'list', pluginId: 'cli-proxy-api' }]))
    const serviceForm = configPanel!.querySelector<HTMLFormElement>('form[data-service-config-form="providers-runtime"]')!
    const serviceInput = serviceForm.querySelector<HTMLElement & { value: string; onChange?: (value: string) => void }>('t-textarea')!
    serviceInput.value = JSON.stringify([{
      id: 'gateway-a', displayName: 'Gateway A', enabled: true,
      endpoint: { baseUrl: 'https://proxy.example.test/v1', secretRef: 'host-secret:env/GATEWAY_A_KEY' },
      models: { mappings: [] }, timeoutMs: 30_000,
    }])
    serviceInput.onChange?.(serviceInput.value)
    expect(serviceForm.querySelector<HTMLElement & { disabled: boolean }>('t-button[type="submit"]')?.disabled).toBe(false)
    serviceForm.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
    for (let attempt = 0; attempt < 100 && !serviceConfigRequests.some(request => request.operation === 'mutate'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(serviceConfigRequests.find(request => request.operation === 'mutate')?.mutation).toMatchObject({
      identity: { pluginId: 'cli-proxy-api', serviceId: 'providers-runtime' },
      configuration: {
        providers: [expect.objectContaining({
          id: 'gateway-a',
          endpoint: { baseUrl: 'https://proxy.example.test/v1', secretRef: 'host-secret:env/GATEWAY_A_KEY' },
        })],
      },
    })
    const providerInput = providerField!.querySelector<HTMLElement & { onChange?: (value: readonly string[]) => void }>('t-tag-input')!
    expect(configPanel!.querySelector('form[data-plugin-config-form] t-button[type="submit"]')).toBeNull()
    providerInput.onChange?.(['Gateway-A'])
    const submit = configPanel!.querySelector<HTMLElement & { disabled: boolean }>('t-button[type="submit"]')!
    expect(submit.disabled).toBe(false)
    configPanel!.querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
    for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[role="alert"]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent)
      .toBe('Could not save configuration. Try again after checking the current settings.')
    expect(configRequests).toEqual([])

    const validPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="Configuration"]')!
    const validInput = validPanel.querySelector<HTMLElement & { onChange?: (value: readonly string[]) => void }>('[data-config-path="providerIds"] t-tag-input')!
    validInput.onChange?.(['gateway-a'])
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
    expect((dom.window as unknown as { __cordisxServiceConfigReceiveV1?: unknown }).__cordisxServiceConfigReceiveV1).toBeUndefined()
  }, 20_000)
})
