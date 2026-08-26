import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { manifest } from '../packages/cli/src/plugins/channel/index.js'
import {
  CordisXChannelManagerService,
  type ChannelManagerProjectionV1,
} from '../packages/cli/src/renderer/channel-manager.js'

interface RuntimeHandle {
  snapshot(): {
    plugins: readonly { id: string; status: string; configuration: { schemaKind: string; fields: readonly unknown[] } }[]
    registrations: readonly { owner: string; surface: string; qualifiedId: string; valid: boolean; pending: boolean }[]
    navigation: {
      routes: readonly { qualifiedId: string; valid: boolean; productMetadata: { title?: string; diagnostics: readonly unknown[] } }[]
      pages: readonly { qualifiedId: string; metadata: { chrome?: string }; productMetadata: { title?: string; diagnostics: readonly unknown[] } }[]
      outlets: readonly { id: string; available: boolean; mounted: boolean; activeRoute?: string }[]
    }
  }
  dispose(): Promise<void>
}

async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not settle')
}

const projection: ChannelManagerProjectionV1 = {
  contract: 'cordisx.channel-manager-projection/v1',
  schemaVersion: 1,
  status: 'experimental',
  service: { configurationKind: 'host', configApplies: 'service-restart', revision: 4, lastGoodRevision: 4, writable: false },
  connections: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator', enabled: true, transportMode: 'simulator', secretState: 'unavailable',
  }],
  routes: [{
    id: 'default',
    connection: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    enabled: true, workspaceAlias: 'cordisx', provider: 'codex', model: 'default', profile: 'work',
    notifications: ['completion', 'failure'],
  }],
  accounts: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator', enabled: true, transportMode: 'simulator', secretState: 'unavailable',
    implementationStatus: 'verified', connectionState: 'ready', generation: 3,
    inbound: { pending: 0, retrying: 0, deadLetter: 0 }, outbound: { pending: 1, retrying: 0, deadLetter: 0 },
  }],
  bindings: [{
    bindingId: 'binding-1',
    channel: {
      adapterId: 'simulator', accountId: 'local', tenantId: 'test', conversationId: 'direct-alice', threadId: 'direct-alice',
    },
    session: { providerId: 'codex', remoteSessionId: 'same-id-safe-by-provider' },
    routeId: 'default', state: 'active',
  }],
  diagnostics: [{ id: 'simulator', status: 'verified', message: 'Local simulator verified without an external account.' }],
}

describe('built-in Channel product bundle', () => {
  it('rejects unknown or secret-bearing Manager projection fields before renderer publication', () => {
    const unsafe = structuredClone(projection) as unknown as Record<string, unknown>
    unsafe.secretRef = 'keychain:must-not-enter-renderer'
    expect(() => new CordisXChannelManagerService(new Context(), unsafe as unknown as ChannelManagerProjectionV1))
      .toThrow('secretRef is not renderer-safe')
  })

  it('declares the Host service schema and projects the structured Manager B data plane', async () => {
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      id: 'channel',
      services: [{
        id: 'runtime', kind: 'channel-adapter', entry: './service.mjs',
        configuration: { kind: 'host', configApplies: 'restart' },
      }],
    })
    expect(manifest.capabilities.some(item => item.name === 'channel.messages.send' && !item.required)).toBe(true)

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'packages/cli/src/plugins/channel/index.ts')
    const rendererComposition = await buildRendererComposition({
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
    }, () => undefined, { profileId: 'work', channelManager: projection, channelActionsBridgeToken: 'a'.repeat(64) })
    const bundle = rendererComposition.source
    const dom = new JSDOM(`
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    const actionRequests: unknown[] = []
    Object.defineProperty(dom.window, '__cordisxChannelActionsRequestV1', { configurable: true, value: (payload: string) => {
      const request = JSON.parse(payload) as { requestId: string; token: string }
      actionRequests.push(request)
      queueMicrotask(() => (dom.window as unknown as { __cordisxChannelActionsReceiveV1?: (response: string) => void }).__cordisxChannelActionsReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value: { status: 'applied' } })))
    } })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      const snapshot = runtime.snapshot()
      expect(snapshot.plugins).toEqual([expect.objectContaining({
        id: 'channel', status: 'active', configuration: expect.objectContaining({ schemaKind: 'none', fields: [] }),
      })])
      expect(snapshot.registrations).toContainEqual(expect.objectContaining({
        owner: 'channel', surface: 'manager.settings.navigation-items', qualifiedId: 'channel:channels', valid: true,
      }))
      expect(snapshot.navigation.routes).toContainEqual(expect.objectContaining({
        qualifiedId: 'channel:settings', valid: true,
        productMetadata: expect.objectContaining({ title: 'Channel settings', diagnostics: [] }),
      }))
      expect(snapshot.navigation.pages).toContainEqual(expect.objectContaining({
        qualifiedId: 'channel:settings', metadata: expect.objectContaining({ chrome: 'standard' }),
        productMetadata: expect.objectContaining({
          title: 'Channels',
          description: 'Manage configured channel accounts, connections, and sessions.',
          diagnostics: [],
        }),
      }))
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      const managerModal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal="true"]')!
      expect(dom.window.getComputedStyle(managerModal).fontSize).toBe('13px')
      const channelEntry = dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!
      expect(channelEntry.textContent).toContain('Channel settings')
      expect(channelEntry.querySelector('[data-host-icon="host:layers"]')).not.toBeNull()
      channelEntry.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-manager="mounted"]') !== null)
      // Channel content may add its own local styling, but it must never reset
      // the shared Manager modal typography to the browser default.
      expect(dom.window.getComputedStyle(managerModal).fontSize).toBe('13px')
      expect(dom.window.document.querySelector<HTMLElement>('[data-channel-manager-styles="true"]')?.textContent)
        .not.toContain('.cxf-scope')
      expect(dom.window.document.querySelector('.cxm-heading-direct-title')?.textContent).toBe('Channel settings')
      expect(dom.window.document.querySelector('[data-manager-content-root]')?.textContent).not.toContain('正在加载插件页面')
      expect(runtime.snapshot().navigation.outlets).toContainEqual(expect.objectContaining({
        id: 'manager.content', mounted: true, activeRoute: 'channel:settings',
      }))
      const card = dom.window.document.querySelector<HTMLButtonElement>('[data-host-collection="channel-list"] [data-collection-item="simulator/local/test"] .cxc-primary')!
      card.click()
      await waitFor(() => dom.window.document.querySelector('[data-manager-content-tabs]') !== null)
      expect(dom.window.document.querySelector('[data-channel-page="detail"]')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading-direct-title')?.textContent).toBe('Channel settings')
      expect(dom.window.document.querySelector('.cxm-heading .cxm-back')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-breadcrumbs')).toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading .cxm-heading-icon[data-host-icon="host:layers"]')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxc-channel-back,.cxc-channel-tabs')).toBeNull()
      expect(dom.window.document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="configuration"]')).not.toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-content-tabs] [data-manager-content-tab="runtime"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-runtime-action="reconnect"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-runtime-action="reconnect"]')!.click()
      await waitFor(() => actionRequests.length === 1)
      expect(actionRequests[0]).toMatchObject({ token: 'a'.repeat(64), action: 'reconnect' })
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-content-tabs] [data-manager-content-tab="logs"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-detail-panel="logs"]') !== null)
      expect(dom.window.document.querySelector('[data-channel-logs]')?.textContent).toContain('No logs yet.')
      expect(dom.window.document.querySelector('[data-channel-log-query]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-channel-log-outcome]')).not.toBeNull()
      expect(dom.window.document.querySelector<HTMLButtonElement>('[data-channel-log-export="json"]')?.disabled).toBe(true)
      expect(dom.window.location.href).toBe('https://codex.local/native')
    } finally {
      await runtime.dispose()
      expect(dom.window.document.querySelector('[data-channel-manager]')).toBeNull()
      dom.window.close()
    }
  }, 10_000)

  it('reprojects a newly created local account into exact Host routes and its Host-owned title', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'packages/cli/src/plugins/channel/index.ts')
    const serviceConfigToken = 'e'.repeat(64)
    const generation = 'channel-created-record-test'
    const bundle = await buildRendererBundle({
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
    }, {
      profileId: 'work', generation, serviceConfigBridgeToken: serviceConfigToken,
      channelManager: { ...projection, service: { ...projection.service, writable: true } },
    })
    const dom = new JSDOM(`
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    const descriptor = {
      contract: 'cordisx.service-config-descriptor/v1', schemaVersion: 1,
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation },
      schema: { id: 'https://example.test/channel-runtime', projection: { kind: 'standard', renderable: false } },
      revision: 4, lastGoodRevision: 4, configApplies: 'service-restart', writable: true, restartRequired: false,
      configuration: {
        contract: 'cordisx.channel-service-config/v1', schemaVersion: 1,
        connections: [{ ref: projection.connections[0]!.ref, adapterKind: 'simulator', enabled: true, transport: { mode: 'simulator' } }],
        routes: [], reliability: {
          leaseMs: 30_000,
          retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxAgeMs: 86_400_000, jitterRatio: .2 },
          rateLimit: { perAccountPerMinute: 120, perUserPerMinute: 20, perConversationPerMinute: 60, maxConcurrent: 8, maxBacklog: 1_000 },
          attachments: { maxFiles: 4, maxBytesPerFile: 10_485_760, allowedMediaTypes: ['text/plain'] },
        },
      }, secrets: [],
    }
    Object.defineProperty(dom.window, '__cordisxServiceConfigRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; operation: 'list' | 'mutate' }
        expect(request.token).toBe(serviceConfigToken)
        const value = request.operation === 'list'
          ? [descriptor]
          : {
              contract: 'cordisx.service-config-result/v1', schemaVersion: 1,
              identity: descriptor.identity, scope: descriptor.scope, revision: 5,
              status: 'applied', configApplies: 'service-restart', serviceGeneration: 'channel-created-record-next',
            }
        queueMicrotask(() => {
          const receiver = (dom.window as unknown as { __cordisxServiceConfigReceiveV1?: (response: string) => void }).__cordisxServiceConfigReceiveV1
          receiver?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      },
    })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="list"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-create="true"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="create"]') !== null)
      const name = dom.window.document.querySelector<HTMLElement>('#channel-create-name') as HTMLElement & { onChange?: (value: string) => void }
      expect(name.onChange).toBeTypeOf('function')
      name.onChange?.('Local smoke')
      dom.window.document.querySelector<HTMLFormElement>('[data-channel-create-form="true"]')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      const selector = '[data-host-collection="channel-list"] [data-collection-item="simulator/local-smoke/local"]'
      await waitFor(() => dom.window.document.querySelector(selector) !== null)
      const card = dom.window.document.querySelector<HTMLElement>(selector)!
      expect(card.textContent).toContain('Local smoke')
      expect(card.querySelector('.cxc-avatar')).not.toBeNull()
      expect(card.querySelector('.cxc-avatar-badge')).not.toBeNull()
      expect(card.querySelector('.cxc-status[data-position="card"]')).not.toBeNull()
      card.querySelector<HTMLButtonElement>('.cxc-primary')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="detail"][data-channel-detail="simulator/local-smoke/local"]') !== null)
      expect(dom.window.document.querySelector('.cxm-heading-direct-title')?.textContent).toBe('Channel settings')
      expect(dom.window.document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="configuration"]')).not.toBeNull()
    } finally {
      await runtime.dispose()
      dom.window.close()
    }
  }, 10_000)

  it('captures a Feishu create credential through the Host bridge and never renders it back', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'packages/cli/src/plugins/channel/index.ts')
    const serviceConfigToken = 's'.repeat(64)
    const credentialToken = 'c'.repeat(64)
    const generation = 'channel-feishu-create-test'
    const bundle = await buildRendererBundle({
      version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [],
      plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
    }, {
      profileId: 'work', generation, serviceConfigBridgeToken: serviceConfigToken, channelCredentialBridgeToken: credentialToken,
      channelManager: { ...projection, service: { ...projection.service, writable: true } },
    })
    const dom = new JSDOM('<html lang="en" class="electron-dark"><body><div class="sidebar-header"><button id="workspace-switcher">Codex</button></div></body></html>', {
      runScripts: 'dangerously', url: 'https://codex.local/native',
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    const descriptor = {
      contract: 'cordisx.service-config-descriptor/v1', schemaVersion: 1,
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation }, schema: { id: 'https://example.test/channel-runtime', projection: { kind: 'standard', renderable: false } },
      revision: 4, lastGoodRevision: 4, configApplies: 'service-restart', writable: true, restartRequired: false,
      configuration: {
        contract: 'cordisx.channel-service-config/v1', schemaVersion: 1, connections: [], routes: [], reliability: {
          leaseMs: 30_000, retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxAgeMs: 86_400_000, jitterRatio: .2 },
          rateLimit: { perAccountPerMinute: 120, perUserPerMinute: 20, perConversationPerMinute: 60, maxConcurrent: 8, maxBacklog: 1_000 },
          attachments: { maxFiles: 4, maxBytesPerFile: 10_485_760, allowedMediaTypes: ['text/plain'] },
        },
      }, secrets: [],
    }
    const requests: unknown[] = []
    Object.defineProperty(dom.window, '__cordisxServiceConfigRequestV1', { configurable: true, value: (payload: string) => {
      const request = JSON.parse(payload) as { requestId: string; operation: 'list' | 'mutate' }
      queueMicrotask(() => (dom.window as unknown as { __cordisxServiceConfigReceiveV1?: (response: string) => void }).__cordisxServiceConfigReceiveV1?.(JSON.stringify({
        requestId: request.requestId, ok: true, value: request.operation === 'list' ? [descriptor] : { contract: 'cordisx.service-config-result/v1', schemaVersion: 1, identity: descriptor.identity, scope: descriptor.scope, revision: 5, status: 'applied', configApplies: 'service-restart', serviceGeneration: 'next' },
      })))
    } })
    Object.defineProperty(dom.window, '__cordisxChannelCredentialRequestV1', { configurable: true, value: (payload: string) => {
      const request = JSON.parse(payload) as { requestId: string; token: string; secret?: string; mutation?: unknown }
      requests.push(request)
      queueMicrotask(() => (dom.window as unknown as { __cordisxChannelCredentialReceiveV1?: (response: string) => void }).__cordisxChannelCredentialReceiveV1?.(JSON.stringify({
        requestId: request.requestId, ok: true, value: { contract: 'cordisx.service-config-result/v1', schemaVersion: 1, identity: descriptor.identity, scope: descriptor.scope, revision: 5, status: 'applied', configApplies: 'service-restart', serviceGeneration: 'next' },
      })))
    } })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="list"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-create="true"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="create"]') !== null)
      const get = (id: string) => dom.window.document.querySelector<HTMLElement>(`#${id}`) as HTMLElement & { onChange?: (value: string) => void }
      get('channel-create-name').onChange?.('Feishu smoke')
      get('channel-create-platform').onChange?.('feishu')
      get('channel-create-app-id').onChange?.('cli_smoke')
      const credential = dom.window.document.querySelector<HTMLInputElement>('[data-channel-credential-capture="true"]')!
      credential.value = 'test-only-credential'
      credential.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      dom.window.document.querySelector<HTMLFormElement>('[data-channel-create-form="true"]')!.requestSubmit()
      await waitFor(() => requests.length === 1)
      expect(requests[0]).toMatchObject({ token: credentialToken, secret: 'test-only-credential', account: { adapterId: 'feishu', accountId: 'cli_smoke' } })
      expect(dom.window.document.body.textContent).not.toContain('test-only-credential')
      expect(dom.window.document.documentElement.outerHTML).not.toMatch(/secretRef|keychain:/i)
    } finally {
      await runtime.dispose()
      dom.window.close()
    }
  }, 10_000)

  it('renders and disposes the bounded Channel body through the internal Host service', async () => {
    const dom = new JSDOM('<html lang="en"><body><main id="seat"></main></body></html>')
    const mutations: unknown[] = []
    const manager = new CordisXChannelManagerService(new Context(), {
      projection: { ...projection, service: { ...projection.service, writable: true } },
      serviceConfig: {
        list: async () => [{
          contract: 'cordisx.service-config-descriptor/v1', schemaVersion: 1,
          identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
          scope: { profileId: 'work', generation: 'channel-test-generation' },
          schema: { id: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json', projection: { kind: 'standard', renderable: false } },
          revision: 4, lastGoodRevision: 4, configApplies: 'service-restart', writable: true, restartRequired: false,
          configuration: {
            contract: 'cordisx.channel-service-config/v1', schemaVersion: 1,
            connections: [{ ref: projection.connections[0]!.ref, adapterKind: 'simulator', enabled: true, transport: { mode: 'simulator' } }],
            routes: [], reliability: {
              leaseMs: 30_000,
              retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxAgeMs: 86_400_000, jitterRatio: .2 },
              rateLimit: { perAccountPerMinute: 120, perUserPerMinute: 20, perConversationPerMinute: 60, maxConcurrent: 8, maxBacklog: 1_000 },
              attachments: { maxFiles: 4, maxBytesPerFile: 10_485_760, allowedMediaTypes: ['text/plain'] },
            },
          }, secrets: [],
        }] as never,
        mutate: async mutation => {
          mutations.push(mutation)
          return { contract: 'cordisx.service-config-result/v1', schemaVersion: 1, identity: mutation.identity, scope: mutation.scope, revision: 5, status: 'applied', configApplies: 'service-restart', serviceGeneration: 'channel-test-next' }
        },
      },
    })
    const controller = new AbortController()
    const container = dom.window.document.querySelector<HTMLElement>('#seat')!
    const navigations: unknown[] = []
    const dispose = manager.mount({
      document: dom.window.document,
      container,
      signal: controller.signal,
      routeId: 'channel:settings', outlet: 'manager.content', params: {},
      navigation: { navigate: reference => { navigations.push(reference); return Promise.resolve() }, back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    const page = container.querySelector<HTMLElement>('[data-channel-manager="mounted"]')!
    expect(page.dataset.channelStatus).toBe('experimental')
    expect(page.querySelector('[data-channel-page="list"]')).not.toBeNull()
    const search = page.querySelector<HTMLInputElement>('[data-collection-search="channel-list"]')!
    expect(search.getAttribute('aria-label')).toBe('Search configured channels')
    const card = page.querySelector<HTMLButtonElement>('[data-host-collection="channel-list"] [data-collection-item="simulator/local/test"] .cxc-primary')!
    const initialCard = card.closest<HTMLElement>('[data-collection-item="simulator/local/test"]')!
    expect(initialCard.querySelector('.cxc-avatar')).not.toBeNull()
    expect(initialCard.querySelector('.cxc-avatar-badge')).not.toBeNull()
    expect(initialCard.querySelector('.cxc-status[data-position="card"]')).not.toBeNull()
    search.value = 'simulator'
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    card.click()
    expect(navigations).toContainEqual({ id: 'configuration', params: { accountId: 'simulator/local/test' } })
    dispose()
    const detailDispose = manager.mount({
      document: dom.window.document, container, signal: controller.signal,
      routeId: 'channel:configuration', outlet: 'manager.content', params: { accountId: 'simulator/local/test' },
      navigation: { navigate: reference => { navigations.push(reference); return Promise.resolve() }, back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    const detail = container.querySelector<HTMLElement>('[data-channel-page="detail"][data-channel-detail="simulator/local/test"]')!
    expect(detail).not.toBeNull()
    expect(detail.querySelector('[role="tablist"],h2,.cxc-channel-back,.cxc-channel-tabs')).toBeNull()
    expect(detail.querySelector('[data-channel-configuration="simulator/local/test"]')).not.toBeNull()
    await waitFor(() => detail.querySelector('[data-channel-configuration-form="simulator/local/test"]') !== null)
    detailDispose()
    const logsDispose = manager.mount({
      document: dom.window.document, container, signal: controller.signal,
      routeId: 'channel:logs', outlet: 'manager.content', params: { accountId: 'simulator/local/test' },
      navigation: { navigate: () => Promise.resolve(), back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    expect(container.querySelector('[data-channel-logs="true"]')?.textContent).toContain('No logs yet.')
    logsDispose()
    const sessionsDispose = manager.mount({
      document: dom.window.document, container, signal: controller.signal,
      routeId: 'channel:sessions', outlet: 'manager.content', params: { accountId: 'simulator/local/test' },
      navigation: { navigate: () => Promise.resolve(), back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    expect(container.querySelector('[data-channel-real-readiness],[data-channel-session-actions]')).toBeNull()
    expect(container.querySelector('[data-host-collection="channel-routes"] [data-collection-item="default"]')).not.toBeNull()
    expect(container.querySelector('[data-host-collection="channel-bindings"] [data-collection-item="binding-1"]')?.textContent).toContain('codex')
    sessionsDispose()
    const createDispose = manager.mount({
      document: dom.window.document, container, signal: controller.signal,
      routeId: 'channel:create', outlet: 'manager.content', params: {},
      navigation: { navigate: reference => { navigations.push(reference); return Promise.resolve() }, back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    const createPage = container.querySelector<HTMLElement>('[data-channel-page="create"]')!
    expect(createPage.querySelector('[data-channel-create-form="true"]')).not.toBeNull()
    const name = createPage.querySelector<HTMLElement>('#channel-create-name') as HTMLElement & { onChange?: (value: string) => void }
    name.onChange?.('Local smoke')
    createPage.querySelector<HTMLFormElement>('[data-channel-create-form="true"]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => mutations.length === 1)
    await waitFor(() => navigations.some(item => JSON.stringify(item) === JSON.stringify({ id: 'settings' })))
    expect(mutations[0]).toMatchObject({ identity: { pluginId: 'channel', serviceId: 'runtime' }, expectedRevision: 4 })
    createDispose()
    const returnedRootDispose = manager.mount({
      document: dom.window.document, container, signal: controller.signal,
      routeId: 'channel:settings', outlet: 'manager.content', params: {},
      navigation: { navigate: reference => { navigations.push(reference); return Promise.resolve() }, back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    const savedCard = container.querySelector<HTMLElement>('[data-host-collection="channel-list"] [data-collection-item="simulator/local-smoke/local"]')!
    expect(savedCard).not.toBeNull()
    expect(savedCard.textContent).toContain('Local smoke')
    expect(savedCard.querySelector('.cxc-avatar')).not.toBeNull()
    expect(savedCard.querySelector('.cxc-avatar-badge')).not.toBeNull()
    expect(savedCard.querySelector('.cxc-status[data-position="card"]')).not.toBeNull()
    expect(container.outerHTML).not.toMatch(/secretRef|keychain:|host-secret:/i)
    controller.abort()
    expect(container.querySelector<HTMLElement>('[data-channel-manager="mounted"]')?.dataset.channelManagerAborted).toBe('true')
    returnedRootDispose()
    expect(container.querySelector('[data-channel-manager]')).toBeNull()
    dom.window.close()
  })

  it('saves an account switch only through the Host service-config bridge', async () => {
    const dom = new JSDOM('<html lang="en"><body><main id="seat"></main></body></html>')
    const mutations: unknown[] = []
    let revision = 4
    const manager = new CordisXChannelManagerService(new Context(), {
      projection: { ...projection, service: { ...projection.service, writable: true } },
      serviceConfig: {
        list: async () => [{
          contract: 'cordisx.service-config-descriptor/v1', schemaVersion: 1,
          identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
          scope: { profileId: 'work', generation: 'channel-test-generation' },
          schema: { id: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json', projection: { kind: 'standard', renderable: false } },
          revision, lastGoodRevision: revision, configApplies: 'service-restart', writable: true, restartRequired: false,
          configuration: {
            contract: 'cordisx.channel-service-config/v1', schemaVersion: 1,
            connections: [{ ref: projection.connections[0]!.ref, adapterKind: 'simulator', enabled: true, transport: { mode: 'simulator' } }],
            routes: [], reliability: {
              leaseMs: 30_000,
              retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxAgeMs: 86_400_000, jitterRatio: .2 },
              rateLimit: { perAccountPerMinute: 120, perUserPerMinute: 20, perConversationPerMinute: 60, maxConcurrent: 8, maxBacklog: 1_000 },
              attachments: { maxFiles: 4, maxBytesPerFile: 10_485_760, allowedMediaTypes: ['text/plain'] },
            },
          }, secrets: [],
        }] as never,
        mutate: async mutation => {
          mutations.push(mutation)
          revision += 1
          return { contract: 'cordisx.service-config-result/v1', schemaVersion: 1, identity: mutation.identity, scope: mutation.scope, revision, status: 'applied', configApplies: 'service-restart', serviceGeneration: 'channel-test-next' }
        },
      },
    })
    const container = dom.window.document.querySelector<HTMLElement>('#seat')!
    const dispose = manager.mount({
      document: dom.window.document, container, signal: new AbortController().signal,
      routeId: 'channel:configuration', outlet: 'manager.content', params: { accountId: 'simulator/local/test' },
      navigation: { navigate: () => Promise.resolve(), back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as never)
    await waitFor(() => container.querySelector('[data-channel-configuration-form="simulator/local/test"]') !== null)
    container.querySelector<HTMLFormElement>('[data-channel-configuration-form="simulator/local/test"]')!.requestSubmit()
    await waitFor(() => mutations.length === 1)
    expect(mutations[0]).toMatchObject({ identity: { pluginId: 'channel', serviceId: 'runtime' }, expectedRevision: 4 })
    await waitFor(() => container.querySelector<HTMLButtonElement>('[data-channel-reconnect="simulator/local/test"]')?.disabled === false)
    container.querySelector<HTMLButtonElement>('[data-channel-reconnect="simulator/local/test"]')!.click()
    await waitFor(() => mutations.length === 2)
    expect(mutations[1]).toMatchObject({ identity: { pluginId: 'channel', serviceId: 'runtime' }, expectedRevision: 5 })
    await waitFor(() => container.querySelector('[data-channel-configuration-status]')?.textContent === 'Reconnected')
    expect(container.textContent).not.toMatch(/secretRef|keychain:|host-secret:/i)
    dispose()
    dom.window.close()
  })

  it('keeps runtime state and operational logs in separate Host-owned tabs', async () => {
    const dom = new JSDOM('<html lang="en"><body><main id="seat"></main></body></html>')
    const logs = Array.from({ length: 30 }, (_, index) => ({
      id: `audit-${index}`, account: projection.connections[0]!.ref,
      recordedAt: `2026-08-25T12:${String(index).padStart(2, '0')}:00.000Z`,
      action: index === 0 ? 'special-query' : `adapter.receive.${index}`,
      outcome: index % 3 === 0 ? 'failure' : 'success',
    }))
    let exported: Blob | undefined
    let filename = ''
    let revoked = ''
    Object.defineProperty(dom.window.URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { exported = blob; return 'blob:channel-logs' } })
    Object.defineProperty(dom.window.URL, 'revokeObjectURL', { configurable: true, value: (url: string) => { revoked = url } })
    Object.defineProperty(dom.window.HTMLAnchorElement.prototype, 'click', { configurable: true, value: function (this: HTMLAnchorElement) { filename = this.download } })
    const manager = new CordisXChannelManagerService(new Context(), {
      projection: {
        ...projection,
        logs,
      },
    })
    const container = dom.window.document.querySelector<HTMLElement>('#seat')!
    const common = {
      document: dom.window.document, container, signal: new AbortController().signal,
      outlet: 'manager.content', params: { accountId: 'simulator/local/test' },
      navigation: { navigate: () => Promise.resolve(), back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as const
    const runtimeDispose = manager.mount({ ...common, routeId: 'channel:runtime' } as never)
    expect(container.querySelector('[data-channel-runtime-status="simulator/local/test"]')).not.toBeNull()
    expect(container.querySelector('[data-channel-logs]')).toBeNull()
    runtimeDispose()
    const logsDispose = manager.mount({ ...common, routeId: 'channel:logs' } as never)
    const entries = () => container.querySelectorAll('[data-channel-logs="true"] [data-channel-log-entry]')
    expect(entries()).toHaveLength(25)
    const query = container.querySelector<HTMLInputElement>('[data-channel-log-query]')!
    query.value = 'special-query'; query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(entries()).toHaveLength(1)
    query.value = ''; query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const filter = container.querySelector<HTMLElement>('[data-channel-log-outcome]') as HTMLElement & { onChange?: (value: 'all' | 'success' | 'failure') => void }
    expect(filter).not.toBeNull(); filter.onChange?.('failure')
    expect(entries()).toHaveLength(10)
    filter.onChange?.('all')
    const next = container.querySelector<HTMLButtonElement>('[data-channel-log-pagination] .cxc-channel-log-page:last-child')!
    next.click(); expect(entries()).toHaveLength(5)
    const previous = container.querySelector<HTMLButtonElement>('[data-channel-log-pagination] .cxc-channel-log-page:first-child')!
    previous.click(); expect(entries()).toHaveLength(25)
    container.querySelector<HTMLButtonElement>('[data-channel-log-export="json"]')!.click()
    expect(filename).toBe('cordisx-channel-local-logs.json')
    const payload = JSON.parse(await exported!.text()) as readonly Record<string, unknown>[]
    expect(payload).toHaveLength(30)
    expect(payload.every(entry => Object.keys(entry).sort().join(',') === 'action,id,outcome,recordedAt')).toBe(true)
    await new Promise(resolve => dom.window.setTimeout(resolve, 0))
    expect(revoked).toBe('blob:channel-logs')
    logsDispose(); dom.window.close()
  })

  it('invokes real launcher action seams for runtime and binding controls instead of disabled placeholders', async () => {
    const dom = new JSDOM('<html lang="en"><body><main id="seat"></main></body></html>')
    const requests: Array<{ action: string; input: Record<string, unknown> }> = []
    const manager = new CordisXChannelManagerService(new Context(), {
      projection,
      actions: {
        run: async (action, input) => {
          requests.push({ action, input })
          return { status: 'applied' }
        },
      },
    })
    const container = dom.window.document.querySelector<HTMLElement>('#seat')!
    const common = {
      document: dom.window.document, container, signal: new AbortController().signal,
      outlet: 'manager.content', params: { accountId: 'simulator/local/test' },
      navigation: { navigate: () => Promise.resolve(), back: () => Promise.resolve(), close: () => Promise.resolve() },
    } as const
    const runtimeDispose = manager.mount({ ...common, routeId: 'channel:runtime' } as never)
    const reconnect = container.querySelector<HTMLButtonElement>('[data-channel-runtime-action="reconnect"]')!
    expect(reconnect.disabled).toBe(false)
    reconnect.click()
    await waitFor(() => requests.length === 1)
    expect(requests[0]).toEqual({ action: 'reconnect', input: { ref: projection.connections[0]!.ref } })
    runtimeDispose()
    const sessionsDispose = manager.mount({ ...common, routeId: 'channel:sessions' } as never)
    const archive = container.querySelector<HTMLButtonElement>('[data-channel-binding-operation="archive"]')!
    expect(archive.disabled).toBe(false)
    archive.click()
    await waitFor(() => requests.length === 2)
    expect(requests[1]).toEqual({ action: 'archive', input: { bindingId: 'binding-1' } })
    sessionsDispose()
    dom.window.close()
  })
})
