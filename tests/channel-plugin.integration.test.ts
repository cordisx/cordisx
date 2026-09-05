import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { manifest } from '../packages/cli/src/plugins/channel/index.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { domPermissionAuthorizationKeyV3 } from '../packages/cli/src/permission-model-v3.js'
import {
  type ChannelManagerProjectionV1,
  CordisXChannelManagerService,
} from '../packages/cli/src/renderer/channel-manager.js'

interface RuntimeHandle {
  snapshot(): {
    plugins: readonly {
      id: string
      status: string
      configuration: { schemaKind: string; fields: readonly unknown[] }
    }[]
    registrations: readonly { owner: string; surface: string; qualifiedId: string; valid: boolean; pending: boolean }[]
    navigation: {
      routes: readonly {
        qualifiedId: string
        valid: boolean
        productMetadata: { title?: string; diagnostics: readonly unknown[] }
      }[]
      pages: readonly {
        qualifiedId: string
        metadata: { chrome?: string }
        productMetadata: { title?: string; diagnostics: readonly unknown[] }
      }[]
      outlets: readonly { id: string; available: boolean; mounted: boolean; activeRoute?: string }[]
    }
  }
  dispose(): Promise<void>
}

async function waitFor(predicate: () => boolean, attempts = 1_500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not settle')
}

function setControl(window: JSDOM['window'], control: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = control instanceof window.HTMLInputElement
    ? window.HTMLInputElement.prototype
    : window.HTMLSelectElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
  control.dispatchEvent(new window.Event('input', { bubbles: true }))
  control.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function installNoopPermissionBridge(window: JSDOM['window']): void {
  Object.defineProperty(window, '__cordisxPermissionPolicyRequestV1', {
    configurable: true,
    value: () => undefined,
  })
}

const projection: ChannelManagerProjectionV1 = {
  contract: 'cordisx.channel-manager-projection/v1',
  schemaVersion: 1,
  status: 'experimental',
  service: {
    configurationKind: 'host',
    configApplies: 'service-restart',
    revision: 4,
    lastGoodRevision: 4,
    writable: false,
  },
  connections: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator',
    enabled: true,
    transportMode: 'simulator',
    secretState: 'unavailable',
  }],
  routes: [{
    id: 'default',
    connection: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    enabled: true,
    workspaceAlias: 'cordisx',
    provider: 'codex',
    model: 'default',
    profile: 'work',
    notifications: ['completion', 'failure'],
  }],
  accounts: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator',
    enabled: true,
    transportMode: 'simulator',
    secretState: 'unavailable',
    implementationStatus: 'verified',
    connectionState: 'ready',
    generation: 3,
    inbound: { pending: 0, retrying: 0, deadLetter: 0 },
    outbound: { pending: 1, retrying: 0, deadLetter: 0 },
  }],
  bindings: [{
    bindingId: 'binding-1',
    channel: {
      adapterId: 'simulator',
      accountId: 'local',
      tenantId: 'test',
      conversationId: 'direct-alice',
      threadId: 'direct-alice',
    },
    session: { providerId: 'codex', remoteSessionId: 'same-id-safe-by-provider' },
    routeId: 'default',
    state: 'active',
  }],
  diagnostics: [{
    id: 'simulator',
    status: 'verified',
    message: 'Local simulator verified without an external account.',
  }],
}

function channelDomPolicies(entry: string) {
  return ['manager.settings.navigation-items', 'manager.content'].map(pointId => ({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
    schemaVersion: 3 as const,
    key: domPermissionAuthorizationKeyV3({
      profileId: 'work',
      identity: { source: pathToFileURL(entry).href, pluginId: 'channel' },
      pointId,
      catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
    }),
    policy: 'allow-persistent' as const,
  }))
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
        id: 'runtime',
        kind: 'channel-adapter',
        entry: './service.mjs',
        configuration: { kind: 'host', configApplies: 'restart' },
      }],
    })
    expect(manifest.capabilities.some(item => item.name === 'channel.messages.send' && !item.required)).toBe(true)

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'packages/cli/src/plugins/channel/index.ts')
    const rendererComposition = await buildRendererComposition(
      {
        version: 1,
        rootDir: root,
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
      },
      () => undefined,
      {
        profileId: 'work',
        permission: { profileId: 'work', policies: channelDomPolicies(entry), persistent: true },
        channelManager: projection,
        channelActionsBridgeToken: 'a'.repeat(64),
      },
    )
    const bundle = rendererComposition.source
    const dom = new JSDOM(
      `
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `,
      { runScripts: 'dangerously', url: 'https://codex.local/native' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    installNoopPermissionBridge(dom.window)
    const actionRequests: unknown[] = []
    Object.defineProperty(dom.window, '__cordisxChannelActionsRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string }
        actionRequests.push(request)
        queueMicrotask(() =>
          (dom.window as unknown as { __cordisxChannelActionsReceiveV1?: (response: string) => void })
            .__cordisxChannelActionsReceiveV1?.(
              JSON.stringify({ requestId: request.requestId, ok: true, value: { status: 'applied' } }),
            )
        )
      },
    })
    dom.window.history.replaceState({ usr: null, key: 'native-test', idx: 0 }, '')
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      const snapshot = runtime.snapshot()
      expect(snapshot.plugins).toEqual([expect.objectContaining({
        id: 'channel',
        status: 'active',
        configuration: expect.objectContaining({ schemaKind: 'none', fields: [] }),
      })])
      expect(snapshot.registrations).toContainEqual(expect.objectContaining({
        owner: 'channel',
        surface: 'manager.settings.navigation-items',
        qualifiedId: 'channel:channels',
        valid: true,
      }))
      expect(snapshot.navigation.routes).toContainEqual(expect.objectContaining({
        qualifiedId: 'channel:settings',
        valid: true,
        productMetadata: expect.objectContaining({ title: 'Channel settings', diagnostics: [] }),
      }))
      expect(snapshot.navigation.pages).toContainEqual(expect.objectContaining({
        qualifiedId: 'channel:settings',
        metadata: expect.objectContaining({ chrome: 'standard' }),
        productMetadata: expect.objectContaining({
          title: 'Channels',
          description: 'Manage configured channel accounts, connections, and sessions.',
          diagnostics: [],
        }),
      }))
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-tab="plugins"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      const managerRoot = dom.window.document.querySelector<HTMLElement>('.cxr-root')!
      expect(dom.window.getComputedStyle(managerRoot).fontSize).toBe('13px')
      const channelEntry = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-settings-navigation-item="channel:channels"]',
      )!
      expect(channelEntry.textContent).toContain('Channel settings')
      expect(channelEntry.querySelector('[data-host-icon="host:layers"]')).not.toBeNull()
      channelEntry.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-manager="mounted"]') !== null)
      // Channel content may add its own local styling, but it must never reset
      // the shared Manager modal typography to the browser default.
      expect(dom.window.getComputedStyle(managerRoot).fontSize).toBe('13px')
      expect(dom.window.document.querySelector('.cxr-react-root')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxr-heading')?.textContent).toContain('Channels')
      expect(dom.window.document.querySelector('.cxr-content')?.textContent).not.toContain('正在加载插件页面')
      expect(runtime.snapshot().navigation.outlets).toContainEqual(expect.objectContaining({
        id: 'manager.content',
        mounted: true,
        activeRoute: 'channel:settings',
      }))
      expect(dom.window.location.href).toBe('https://codex.local/native')
    } finally {
      await runtime.dispose()
      expect(dom.window.document.querySelector('[data-channel-manager]')).toBeNull()
      dom.window.close()
    }
  }, 25_000)

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
      profileId: 'work',
      generation,
      serviceConfigBridgeToken: serviceConfigToken,
      permission: { profileId: 'work', policies: channelDomPolicies(entry), bridgeToken: 'b'.repeat(64) },
      channelManager: { ...projection, service: { ...projection.service, writable: true } },
    })
    const dom = new JSDOM(
      `
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `,
      { runScripts: 'dangerously', url: 'https://codex.local/native' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    installNoopPermissionBridge(dom.window)
    const descriptor = {
      contract: 'cordisx.service-config-descriptor/v1',
      schemaVersion: 1,
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation },
      schema: { id: 'https://example.test/channel-runtime', projection: { kind: 'standard', renderable: false } },
      revision: 4,
      lastGoodRevision: 4,
      configApplies: 'service-restart',
      writable: true,
      restartRequired: false,
      configuration: {
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref: projection.connections[0]!.ref,
          adapterKind: 'simulator',
          enabled: true,
          transport: { mode: 'simulator' },
        }],
        routes: [],
        reliability: {
          leaseMs: 30_000,
          retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxAgeMs: 86_400_000, jitterRatio: .2 },
          rateLimit: {
            perAccountPerMinute: 120,
            perUserPerMinute: 20,
            perConversationPerMinute: 60,
            maxConcurrent: 8,
            maxBacklog: 1_000,
          },
          attachments: { maxFiles: 4, maxBytesPerFile: 10_485_760, allowedMediaTypes: ['text/plain'] },
        },
      },
      secrets: [],
    }
    Object.defineProperty(dom.window, '__cordisxServiceConfigRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; operation: 'list' | 'mutate' }
        expect(request.token).toBe(serviceConfigToken)
        const value = request.operation === 'list'
          ? [descriptor]
          : {
            contract: 'cordisx.service-config-result/v1',
            schemaVersion: 1,
            identity: descriptor.identity,
            scope: descriptor.scope,
            revision: 5,
            status: 'applied',
            configApplies: 'service-restart',
            serviceGeneration: 'channel-created-record-next',
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
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-tab="plugins"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!
        .click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="list"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-create="true"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="create"]') !== null)
      const name = dom.window.document.querySelector<HTMLInputElement>('#channel-create-name')!
      setControl(dom.window, name, 'Local smoke')
      await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-create-submit="true"]')!.click()
      await new Promise(resolve => dom.window.setTimeout(resolve, 50))
      const selector = '[data-host-collection="channel-list"] [data-collection-item="simulator/local-smoke/local"]'
      await waitFor(() => dom.window.document.querySelector(selector) !== null)
      const card = dom.window.document.querySelector<HTMLElement>(selector)!
      expect(card.textContent).toContain('Local smoke')
      expect(card.querySelector('.cxc-avatar')).not.toBeNull()
      expect(card.querySelector('.cxc-channel-status[data-state]')).not.toBeNull()
      card.click()
      await waitFor(() =>
        dom.window.document.querySelector(
          '[data-channel-page="detail"][data-channel-detail="simulator/local-smoke/local"]',
        ) !== null
      )
      await waitFor(() => dom.window.document.querySelector('[data-manager-content-tabs]') !== null)
      expect(dom.window.document.querySelector('.cxr-heading')?.textContent).toContain('Channels')
      expect(
        dom.window.document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="configuration"]'),
      ).not.toBeNull()
    } finally {
      await runtime.dispose()
      dom.window.close()
    }
  }, 25_000)

  it('captures a Feishu create credential through the Host bridge and never renders it back', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'packages/cli/src/plugins/channel/index.ts')
    const serviceConfigToken = 's'.repeat(64)
    const credentialToken = 'c'.repeat(64)
    const generation = 'channel-feishu-create-test'
    const bundle = await buildRendererBundle({
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
    }, {
      profileId: 'work',
      generation,
      serviceConfigBridgeToken: serviceConfigToken,
      channelCredentialBridgeToken: credentialToken,
      permission: { profileId: 'work', policies: channelDomPolicies(entry), bridgeToken: 'd'.repeat(64) },
      channelManager: { ...projection, service: { ...projection.service, writable: true } },
    })
    const dom = new JSDOM(
      '<html lang="en" class="electron-dark"><body><div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div></body></html>',
      {
        runScripts: 'dangerously',
        url: 'https://codex.local/native',
      },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    installNoopPermissionBridge(dom.window)
    const descriptor = {
      contract: 'cordisx.service-config-descriptor/v1',
      schemaVersion: 1,
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation },
      schema: { id: 'https://example.test/channel-runtime', projection: { kind: 'standard', renderable: false } },
      revision: 4,
      lastGoodRevision: 4,
      configApplies: 'service-restart',
      writable: true,
      restartRequired: false,
      configuration: {
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [],
        routes: [],
        reliability: {
          leaseMs: 30_000,
          retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, maxAgeMs: 86_400_000, jitterRatio: .2 },
          rateLimit: {
            perAccountPerMinute: 120,
            perUserPerMinute: 20,
            perConversationPerMinute: 60,
            maxConcurrent: 8,
            maxBacklog: 1_000,
          },
          attachments: { maxFiles: 4, maxBytesPerFile: 10_485_760, allowedMediaTypes: ['text/plain'] },
        },
      },
      secrets: [],
    }
    const requests: unknown[] = []
    Object.defineProperty(dom.window, '__cordisxServiceConfigRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; operation: 'list' | 'mutate' }
        queueMicrotask(() =>
          (dom.window as unknown as { __cordisxServiceConfigReceiveV1?: (response: string) => void })
            .__cordisxServiceConfigReceiveV1?.(JSON.stringify({
              requestId: request.requestId,
              ok: true,
              value: request.operation === 'list'
                ? [descriptor]
                : {
                  contract: 'cordisx.service-config-result/v1',
                  schemaVersion: 1,
                  identity: descriptor.identity,
                  scope: descriptor.scope,
                  revision: 5,
                  status: 'applied',
                  configApplies: 'service-restart',
                  serviceGeneration: 'next',
                },
            }))
        )
      },
    })
    Object.defineProperty(dom.window, '__cordisxChannelCredentialRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; secret?: string; mutation?: unknown }
        requests.push(request)
        queueMicrotask(() =>
          (dom.window as unknown as { __cordisxChannelCredentialReceiveV1?: (response: string) => void })
            .__cordisxChannelCredentialReceiveV1?.(JSON.stringify({
              requestId: request.requestId,
              ok: true,
              value: {
                contract: 'cordisx.service-config-result/v1',
                schemaVersion: 1,
                identity: descriptor.identity,
                scope: descriptor.scope,
                revision: 5,
                status: 'applied',
                configApplies: 'service-restart',
                serviceGeneration: 'next',
              },
            }))
        )
      },
    })
    dom.window.history.replaceState({ usr: null, key: 'native-test', idx: 0 }, '')
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      await waitFor(() => dom.window.document.querySelector('[data-cordisx-manager-trigger]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-tab="plugins"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!
        .click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="list"]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-create="true"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-page="create"]') !== null)
      setControl(
        dom.window,
        dom.window.document.querySelector<HTMLInputElement>('#channel-create-name')!,
        'Feishu smoke',
      )
      dom.window.document.querySelector<HTMLButtonElement>('.cxc-channel-platform-select .cxr-ui-select-trigger')!
        .click()
      await waitFor(() =>
        [...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
          .some(option => option.textContent?.includes('Feishu') === true)
      )
      ;[...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.textContent?.includes('Feishu') === true)!.click()
      await waitFor(() => dom.window.document.querySelector('#channel-create-app-id') !== null)
      setControl(
        dom.window,
        dom.window.document.querySelector<HTMLInputElement>('#channel-create-app-id')!,
        'cli_smoke',
      )
      const credential = dom.window.document.querySelector<HTMLInputElement>(
        '[data-channel-credential-capture="true"]',
      )!
      setControl(dom.window, credential, 'test-only-credential')
      await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      dom.window.document.querySelector<HTMLButtonElement>('[data-channel-create-submit="true"]')!.click()
      await new Promise(resolve => dom.window.setTimeout(resolve, 50))
      await waitFor(() => requests.length === 1)
      expect(requests[0]).toMatchObject({
        token: credentialToken,
        secret: 'test-only-credential',
        account: { adapterId: 'feishu', accountId: 'cli_smoke' },
      })
      expect(dom.window.document.body.textContent).not.toContain('test-only-credential')
      expect(dom.window.document.documentElement.outerHTML).not.toMatch(/secretRef|keychain:/i)
    } finally {
      await runtime.dispose()
      dom.window.close()
    }
  }, 25_000)

  it('exposes a stable React store snapshot and reprojects local candidates without leaking secrets', () => {
    const manager = new CordisXChannelManagerService(new Context(), projection)
    const first = manager.snapshot()
    expect(manager.snapshot()).toBe(first)
    let updates = 0
    const dispose = manager.subscribe(() => {
      updates += 1
    })
    manager.rememberLocalCandidate({
      ref: { adapterId: 'simulator', accountId: 'local-smoke', tenantId: 'local' },
      displayName: 'Local smoke',
      adapterKind: 'simulator',
      enabled: true,
      transportMode: 'simulator',
      secretState: 'unavailable',
    })
    const next = manager.snapshot()
    expect(next).not.toBe(first)
    expect(next.connections).toContainEqual(expect.objectContaining({
      displayName: 'Local smoke',
      ref: { adapterId: 'simulator', accountId: 'local-smoke', tenantId: 'local' },
    }))
    expect(updates).toBe(1)
    expect(JSON.stringify(next)).not.toMatch(/secretRef|keychain:|host-secret:/i)
    dispose()
  })

  it('keeps configuration and transient credential writes behind narrow Host bridges', async () => {
    const requests: unknown[] = []
    const credentialRequests: unknown[] = []
    const descriptor = {
      contract: 'cordisx.service-config-descriptor/v1',
      schemaVersion: 1,
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation: 'channel-test-generation' },
      schema: { id: 'https://example.test/channel', projection: { kind: 'standard', renderable: false } },
      revision: 4,
      lastGoodRevision: 4,
      configApplies: 'service-restart',
      writable: true,
      restartRequired: false,
      configuration: { connections: [], routes: [] },
      secrets: [],
    } as const
    const result = {
      contract: 'cordisx.service-config-result/v1',
      schemaVersion: 1,
      identity: descriptor.identity,
      scope: descriptor.scope,
      revision: 5,
      status: 'applied',
      configApplies: 'service-restart',
      serviceGeneration: 'next',
    } as const
    const manager = new CordisXChannelManagerService(new Context(), {
      projection,
      serviceConfig: {
        list: async () => [descriptor] as never,
        mutate: async mutation => {
          requests.push(mutation)
          return result
        },
      },
      createCredentialedConnection: async input => {
        credentialRequests.push(input)
        return result
      },
    })
    expect(await manager.serviceConfiguration()).toEqual(descriptor)
    const mutation = {
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: descriptor.identity,
      scope: descriptor.scope,
      expectedRevision: 4,
      configuration: { connections: [], routes: [] },
    } as const
    await manager.mutateServiceConfiguration(mutation as never)
    await manager.createConnection({
      account: { adapterId: 'feishu', accountId: 'cli_smoke', tenantId: 'default' },
      secret: 'test-only-credential',
      mutation: mutation as never,
    })
    expect(requests).toHaveLength(1)
    expect(credentialRequests).toContainEqual(expect.objectContaining({
      secret: 'test-only-credential',
      account: { adapterId: 'feishu', accountId: 'cli_smoke', tenantId: 'default' },
    }))
    expect(JSON.stringify(manager.snapshot())).not.toContain('test-only-credential')
  })

  it('forwards only allowlisted runtime and binding actions through the Host action bridge', async () => {
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
    expect(manager.actionsAvailable()).toBe(true)
    await manager.runAction('reconnect', { ref: projection.connections[0]!.ref })
    await manager.runAction('archive', { bindingId: 'binding-1' })
    expect(requests).toEqual([
      { action: 'reconnect', input: { ref: projection.connections[0]!.ref } },
      { action: 'archive', input: { bindingId: 'binding-1' } },
    ])
  })
})
