import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

const externalEntry = createRequire(import.meta.url).resolve('@cordisx/plugin-cli-proxy-api')
const externalPackageRoot = path.resolve(path.dirname(externalEntry), '..', '..')

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
    contract: 'cordisx.platform-session/v1',
    schemaVersion: 1,
    ref: { providerId, remoteSessionId: 'shared-session' },
    hostId: `cli-proxy-api:${providerId}`,
    model: { providerId, modelId: 'shared-model' },
    cwd: '/workspace',
    title: `${providerId} conversation`,
    state: 'active',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: providerId === 'gateway-a' ? '2026-08-24T02:00:00.000Z' : '2026-08-24T01:00:00.000Z',
  }
}

describe('CLIProxy provider plugin renderer', () => {
  it('loads the renderer and service artifacts from the exact standalone package', async () => {
    const manifest = JSON.parse(await readFile(path.join(externalPackageRoot, 'package.json'), 'utf8')) as {
      readonly name?: unknown
      readonly version?: unknown
    }
    expect(manifest).toMatchObject({ name: '@cordisx/plugin-cli-proxy-api', version: '0.1.0' })
    expect(externalEntry).toBe(path.join(externalPackageRoot, 'dist', 'runtime', 'module.js'))
    await expect(access(path.join(externalPackageRoot, 'dist', 'service.mjs'))).resolves.toBeUndefined()
    await expect(readFile(path.join(externalPackageRoot, 'src', 'index.ts'))).rejects.toThrow()
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
    const dom = new JSDOM(
      `
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div>
        <header data-app-shell-application-menu-bar><div data-test-id="header-shell-slot"><div><div><button>Native</button></div></div></div></header>
        <aside><div data-app-action-sidebar-scroll><div id="native-navigation"><button>New conversation</button></div></div><button aria-label="Help">Help</button></aside>
        <main data-app-shell-main-content-layout="thread-edge-scroll"><section data-codex-thread-reference-drop-target><div id="native-conversation">native session remains</div></section></main>
      </body></html>
    `,
      { runScripts: 'dangerously', url: 'https://codex.local/native' },
    )
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
        configRequests.push({
          operation: request.operation,
          ...(request.config === undefined ? {} : { config: request.config }),
        })
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
          const receiver = (dom.window as unknown as { __cordisxConfigReceiveV1?: (response: string) => void })
            .__cordisxConfigReceiveV1
          receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      },
    })
    const serviceConfigRequests: { operation: string; pluginId?: string; mutation?: unknown }[] = []
    const serviceDescriptors = [
      {
        contract: 'cordisx.service-config-descriptor/v1',
        schemaVersion: 1,
        identity: {
          source: 'https://github.com/cordisx/plugin-cli-proxy-api',
          pluginId: 'cli-proxy-api',
          serviceId: 'providers-runtime',
        },
        scope: { profileId: 'default', generation: 'cli-proxy-config-test' },
        schema: { id: 'https://example.test/runtime', projection: { kind: 'schemastery', envelope: {} } },
        revision: 0,
        lastGoodRevision: 0,
        configApplies: 'service-restart',
        writable: true,
        restartRequired: false,
        configuration: { contract: 'cordisx.cli-proxy-provider-runtime-config/v1', schemaVersion: 1, providers: [] },
        secrets: [],
      },
      {
        contract: 'cordisx.service-config-descriptor/v1',
        schemaVersion: 1,
        identity: {
          source: 'https://github.com/cordisx/plugin-cli-proxy-api',
          pluginId: 'cli-proxy-api',
          serviceId: 'providers-startup',
        },
        scope: { profileId: 'default', generation: 'cli-proxy-config-test' },
        schema: { id: 'https://example.test/startup', projection: { kind: 'schemastery', envelope: {} } },
        revision: 0,
        lastGoodRevision: 0,
        configApplies: 'app-restart',
        writable: true,
        restartRequired: false,
        configuration: { contract: 'cordisx.cli-proxy-provider-startup-config/v1', schemaVersion: 1, providers: [] },
        secrets: [],
      },
    ]
    Object.defineProperty(dom.window, '__cordisxServiceConfigRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as {
          requestId: string
          token: string
          operation: string
          pluginId?: string
          mutation?: unknown
        }
        expect(request.token).toBe(serviceConfigToken)
        serviceConfigRequests.push({
          operation: request.operation,
          ...(request.pluginId === undefined ? {} : { pluginId: request.pluginId }),
          ...(request.mutation === undefined ? {} : { mutation: request.mutation }),
        })
        const value = request.operation === 'list'
          ? serviceDescriptors
          : {
            contract: 'cordisx.service-config-result/v1',
            schemaVersion: 1,
            identity: serviceDescriptors[0]!.identity,
            scope: serviceDescriptors[0]!.scope,
            revision: 1,
            status: 'applied',
            configApplies: 'service-restart',
            serviceGeneration: 'test-generation',
          }
        queueMicrotask(() => {
          const receiver = (dom.window as unknown as { __cordisxServiceConfigReceiveV1?: (response: string) => void })
            .__cordisxServiceConfigReceiveV1
          receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      },
    })
    Object.defineProperty(dom.window, '__cordisxProviderRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as {
          requestId: string
          token: string
          operation: string
          input: Record<string, unknown>
        }
        expect(request.token).toBe(token)
        requests.push({ operation: request.operation, input: request.input })
        let value: unknown
        if (request.operation === 'status') {
          value = {
            hostId: 'cordisx-provider-fleet',
            hostName: 'CordisX External Provider Fleet',
            mode: 'read-write',
            supportedCapabilities: [
              'models.read',
              'tasks.catalog.read',
              'tasks.content.read',
              'tasks.create',
              'tasks.control',
              'turns.submit',
              'turns.control',
            ],
            diagnostics: [{ code: 'current-connection-client-unavailable', message: 'native remains unavailable' }],
            secondConnectionCreated: false,
            rawBridgeExposed: false,
          }
        } else if (request.operation === 'availability') {
          value = [
            { providerId: 'gateway-a', displayName: 'Gateway A', generation: 'generation-a', state: 'ready' },
            { providerId: 'gateway-b', displayName: 'Gateway B', generation: 'generation-b', state: 'ready' },
          ]
        } else if (request.operation === 'models.list') {
          value = {
            ok: true,
            value: {
              contract: 'cordisx.platform-model-page/v1',
              schemaVersion: 1,
              providerIds: ['gateway-a', 'gateway-b'],
              models: ['gateway-a', 'gateway-b'].map(providerId => ({
                contract: 'cordisx.platform-model/v1',
                schemaVersion: 1,
                ref: { providerId, modelId: 'shared-model' },
                hostId: `cli-proxy-api:${providerId}`,
                label: 'Shared model',
                isDefault: true,
              })),
            },
          }
        } else if (request.operation === 'tasks.list') {
          value = {
            ok: true,
            value: {
              contract: 'cordisx.platform-session-page/v1',
              schemaVersion: 1,
              query: { providerIds: ['gateway-a', 'gateway-b'], limit: 50 },
              snapshotId: 'snapshot-1',
              sessions: [session('gateway-a'), session('gateway-b')],
            },
          }
        } else {
          value = { ok: false, error: { code: 'invalid-request', message: 'unexpected test operation' } }
        }
        queueMicrotask(() => {
          const receiver = (dom.window as unknown as { __cordisxProviderReceiveV1?: (response: string) => void })
            .__cordisxProviderReceiveV1
          receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      },
    })
    dom.window.history.replaceState({ usr: null, key: 'native-test', idx: 0 }, '')
    dom.window.eval(bundle)
    for (
      let attempt = 0;
      attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    expect(runtime?.snapshot().platform).toMatchObject({ mode: 'read-write' })
    expect(runtime?.snapshot().platform.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'current-connection-client-unavailable' }),
    )
    const bundledPlugin = runtime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')
    expect(bundledPlugin?.readme).toContain('# CLIProxy Providers')
    expect(bundledPlugin?.readme).toContain('standalone owner')
    expect(bundledPlugin?.readme).toContain('The Host owns endpoint and credential resolution')
    expect(bundledPlugin?.readme).toContain('The plugin receives no endpoint, credential, process')
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
    const providerRoute = runtime!.snapshot().navigation.routes.find(item =>
      item.qualifiedId === 'cli-proxy-api:providers.sessions'
    )
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
    const providerPage = runtime!.snapshot().navigation.pages.find(item =>
      item.qualifiedId === 'cli-proxy-api:providers.sessions'
    )
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
    expect(
      runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'cli-proxy-api:providers.sessions')
        ?.productMetadata,
    ).toEqual({
      title: '打开 Provider 会话',
      description: '从 CordisX 导航或 Manager 路由目录进入外部 Provider 会话 Fleet。',
      diagnostics: [],
    })
    expect(
      runtime!.snapshot().navigation.pages.find(item => item.qualifiedId === 'cli-proxy-api:providers.sessions')
        ?.productMetadata,
    ).toEqual({
      title: 'Provider 会话',
      description: '在主工作区为已配置的 Provider 创建、搜索、续聊和管理会话。',
      diagnostics: [],
    })
    dom.window.document.documentElement.lang = 'en'
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime!.navigate('cli-proxy-api', { id: 'providers.sessions' })
    for (
      let attempt = 0;
      attempt < 100 && dom.window.document.querySelectorAll('[data-session]').length < 2;
      attempt += 1
    ) {
      const decisions = dom.window.document.querySelectorAll<HTMLElement>(
        '[data-permission-decision="allow-once"]',
      )
      for (const decision of decisions) decision.click()
      if (decisions.length > 0) await new Promise(resolve => setTimeout(resolve, 0))
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')?.click()
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
    expect(requests.map(request => request.operation)).toEqual(
      expect.arrayContaining(['status', 'availability', 'models.list', 'tasks.list']),
    )
    expect(runtime!.snapshot().permissions.find(item => item.capability === 'tasks.catalog.read')?.lastRequested)
      .toMatchObject({ providerIds: ['gateway-a', 'gateway-b'] })
    const catalogAvailability = runtime!.snapshot().permissions.find(item => item.capability === 'tasks.catalog.read')
      ?.availability
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
    expect(readmePanel?.textContent).toContain('standalone owner')
    expect(readmePanel?.textContent).toContain('Host owns endpoint and credential resolution')
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
  }, 20_000)
})
