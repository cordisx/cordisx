import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'

const externalEntry = bundledPluginEntry('plugin-cli-proxy-api')
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
      outlets: readonly { id: string; mounted: boolean; activeRoute?: string }[]
    }
    settingsNavigationItems?: readonly {
      id: string
      title: string
      icon?: string
      navigationGroup?: string
      route: { id: string }
    }[]
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

describe('CLIProxy provider plugin renderer', () => {
  it('loads the renderer and service artifacts from the exact standalone package', async () => {
    const manifest = JSON.parse(await readFile(path.join(externalPackageRoot, 'package.json'), 'utf8')) as {
      readonly name?: unknown
      readonly version?: unknown
      readonly exports?: Record<string, { readonly default?: unknown }>
    }
    expect(manifest).toMatchObject({
      name: '@cordisx/plugin-cli-proxy-api',
      version: '0.1.1',
      exports: { './extensions/v1': { default: './dist/extensions.mjs' } },
    })
    expect(externalEntry).toBe(path.join(externalPackageRoot, 'dist', 'runtime', 'module.js'))
    await expect(access(path.join(externalPackageRoot, 'dist', 'service.mjs'))).resolves.toBeUndefined()
    await expect(readFile(path.join(externalPackageRoot, 'src', 'index.ts'))).rejects.toThrow()
  })

  it('projects the v14 subscription manager into the external accounts navigation group', async () => {
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
          pointIds: ['manager.settings.navigation-items', 'manager.content'],
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
    Object.defineProperty(dom.window, 'structuredClone', { value: structuredClone })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel', configurable: true })
    Object.defineProperty(dom.window, 'confirm', { value: () => true })
    installPermissionPolicyBridge(dom.window)
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
    const bundledPlugin = runtime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')
    expect(bundledPlugin?.readme).toContain('# CLIProxy Providers')
    expect(bundledPlugin?.readme).toContain('The Host resolves credentials, starts managed processes')
    expect(bundledPlugin?.readme).toContain('owns the Provider Fleet')
    expect(bundledPlugin?.readme).toContain('The plugin never receives raw credentials')
    expect(bundledPlugin?.readme).toContain('filesystem paths, process handles, or transport handles')
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
      item.qualifiedId === 'cli-proxy-api:providers.upstream-subscriptions'
    )
    expect(providerRoute).toMatchObject({
      definition: {
        $schema: CORDISX_ROUTE_SCHEMA_V2,
        schemaVersion: 2,
        id: 'providers.upstream-subscriptions',
        path: '/manager/extensions/cli-proxy-api/subscriptions',
        outlet: 'manager.content',
        page: 'providers.upstream-subscriptions',
      },
      productMetadata: {
        title: 'CLIProxyAPI subscriptions',
        description: 'Manage CLIProxyAPI account subscriptions, CordisX upstreams, and runtime status.',
        diagnostics: [],
      },
    })
    const providerPage = runtime!.snapshot().navigation.pages.find(item =>
      item.qualifiedId === 'cli-proxy-api:providers.upstream-subscriptions'
    )
    expect(providerPage).toMatchObject({
      metadata: {
        $schema: CORDISX_PAGE_SCHEMA_V3,
        schemaVersion: 3,
        id: 'providers.upstream-subscriptions',
        icon: 'host:key',
      },
      productMetadata: {
        title: 'CLIProxyAPI subscriptions',
        description: 'View account subscriptions, CordisX upstream providers, and runtime status.',
        diagnostics: [],
      },
    })
    expect(providerRoute?.productMetadata.description).not.toBe(providerPage?.productMetadata.description)

    dom.window.document.documentElement.lang = 'zh-CN'
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(
      runtime!.snapshot().navigation.routes.find(item =>
        item.qualifiedId === 'cli-proxy-api:providers.upstream-subscriptions'
      )
        ?.productMetadata,
    ).toEqual({
      title: 'CLIProxyAPI 订阅管理',
      description: '管理 CLIProxyAPI 账户订阅、CordisX 上游和运行状态。',
      diagnostics: [],
    })
    expect(
      runtime!.snapshot().navigation.pages.find(item =>
        item.qualifiedId === 'cli-proxy-api:providers.upstream-subscriptions'
      )
        ?.productMetadata,
    ).toEqual({
      title: 'CLIProxyAPI 订阅管理',
      description: '查看账户订阅、CordisX 上游提供方和运行状态。',
      diagnostics: [],
    })
    dom.window.document.documentElement.lang = 'en'
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime!.snapshot().settingsNavigationItems).toContainEqual(expect.objectContaining({
      id: 'cli-proxy-api:upstream-subscriptions',
      title: 'CLIProxyAPI subscriptions',
      icon: 'host:key',
      navigationGroup: 'external-accounts',
      route: { id: 'providers.upstream-subscriptions' },
    }))
    await waitFor(() => dom.window.document.querySelector('[data-cordisx-manager-trigger]') !== null)
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    await waitFor(() => dom.window.document.querySelector('[data-plugin-id="cli-proxy-api"]') !== null)
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="cli-proxy-api"]')?.click()
    await waitFor(() => dom.window.document.querySelector('[role="tabpanel"][aria-label="README"]') !== null)
    const readmePanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="README"]')
    expect(readmePanel?.querySelector('.cxm-readme h1')?.textContent).toBe('CLIProxy Providers')
    expect(readmePanel?.textContent).toContain('The Host resolves credentials, starts managed processes')
    expect(readmePanel?.textContent).toContain('owns the Provider Fleet')
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

    await runtime!.navigate('cli-proxy-api', { id: 'providers.upstream-subscriptions' })
    await waitFor(() => dom.window.document.querySelector('[data-cordisx-upstream-manager="true"]') !== null)
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-upstream-manager="true"]')!
    expect(page.closest('[data-cordisx-manager-page]')).not.toBeNull()
    expect(runtime!.snapshot().navigation.outlets.find(outlet => outlet.id === 'manager.content')).toMatchObject({
      mounted: true,
      activeRoute: 'cli-proxy-api:providers.upstream-subscriptions',
    })
    expect(dom.window.document.getElementById('native-conversation')?.textContent).toBe('native session remains')
    expect(await runtime!.listServiceConfigs?.('cli-proxy-api')).toHaveLength(2)
    await runtime!.dispose()
  }, 20_000)
})
