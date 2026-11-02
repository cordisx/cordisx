import path from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { ManagedServiceStartupAuthority } from '../packages/cli/src/launcher/managed-service-startup-authority.js'
import type { ModelProvidersV1 } from '@cordisx/protocol/model-providers/v1'
import { declaration } from './managed-service-runtime-fixture.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'
import type { StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

it('carries startup authorization through the production bundle and registers a plugin page before execution exists', async () => {
  const generation = 'startup-host'
  const owner = { pluginId: 'startup-fixture', pluginGeneration: 'startup-plugin' }
  const authority = new ManagedServiceStartupAuthority({ profileId: 'work', hostGeneration: generation })
  const hostOwners = ['provider-one', 'provider-two'].map(pluginId => ({ pluginId, pluginGeneration: 'one' }))
  authority.admit(hostOwners.map(owner => ({
    ...owner,
    source: `https://example.test/${owner.pluginId}`,
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    dependencies: [],
    services: [declaration('gateway', owner.pluginId, [])],
    startup: {
      contract: 'cordisx.startup-declaration/v1',
      pages: [],
      capabilities: [{
        id: 'models',
        serviceId: 'gateway',
        kind: 'provider',
        providerId: owner.pluginId,
        compositionOrigin: 'api',
        dependsOn: [],
        wait: { interactive: 'background', command: 'when-selected' },
        milestones: [],
        success: { allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }] },
      }],
    },
  })))
  authority.selectOwners(hostOwners)
  const observer: StartupObserverV1 = {
    contract: 'cordisx.startup-observer/v1',
    async read() {
      return {
        contract: 'cordisx.startup-snapshot/v1',
        cursor: { scopeId: 'startup-owner', hostGeneration: generation, epoch: 'epoch', sequence: 0 },
        entries: [],
        pages: [],
      }
    },
    async subscribe(listener) {
      listener({ kind: 'snapshot', reason: 'initial', snapshot: await this.read() })
      return { close() {} }
    },
  }
  const handler = createManagedServiceUIBridgeHandler({
    token: 'startup-token',
    profileId: 'work',
    generation,
    services: [],
    startupObservers: [{ ...owner, observer }],
    hostStartup: {
      token: 'host-startup-token',
      observer: authority.observer({ scopeId: 'host-models', authorize: () => true }),
    },
  })
  const plugin = {
    id: owner.pluginId,
    entry: path.resolve('tests/fixtures/startup-observer-plugin.ts'),
    enabled: true,
    config: {},
    package: {
      version: '1.0.0',
      digest: `sha256:${'1'.repeat(64)}` as `sha256:${string}`,
      moduleGeneration: owner.pluginGeneration,
      dependencies: [],
    },
  }
  const source = await buildRendererBundle({
    version: 1,
    rootDir: process.cwd(),
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [plugin],
  }, {
    profileId: 'work',
    generation,
    pluginActivation: {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: generation,
      plugins: [{ id: plugin.id, ...plugin.package, enabled: true }],
    },
    managedServiceUICapabilities: [{ ...owner, token: handler.token, startup: true }],
    startupHostCapability: { token: handler.hostStartup!.token },
  })
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'dangerously', url: 'https://codex.local/' })
  const globals = dom.window as unknown as typeof globalThis & {
    __cordisxBoot: Promise<void>
    startupFixture?: StartupObserverV1
    startupModelProviders?: ModelProvidersV1
    __cordisxRuntime: {
      snapshot(): {
        plugins: readonly { id: string; status: string }[]
        navigation: { pages: readonly { qualifiedId: string }[] }
      }
      dispose(): Promise<void>
    }
  }
  Object.assign(dom.window, { structuredClone: globalThis.structuredClone })
  const hostResponses: Record<string, unknown>[] = []
  let hostCloseRequests = 0
  globals.__cordisxManagedServiceUIRequestV1 = payload => {
    const parsed = JSON.parse(payload)
    if (parsed.token === handler.hostStartup!.token) {
      if (parsed.operation === 'startupClose') hostCloseRequests++
      void handler.hostStartup!.handleBindingValue(payload).then(value => {
        hostResponses.push(value)
        globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify(value))
      })
      return
    }
    void handler.handle(owner, parseManagedServiceUIBindingRequest(parsed, handler, owner)).then(value =>
      globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({ requestId: parsed.requestId, ok: true, value }))
    )
  }
  try {
    dom.window.eval(source)
    await globals.__cordisxBoot
    const failed = globals.__cordisxRuntime.snapshot().plugins.filter(plugin => plugin.status === 'failed')
    if (failed.length) {
      throw new Error(
        JSON.stringify(
          failed.map(({ id, status, ...rest }) => ({ id, status, error: (rest as { error?: string }).error })),
        ),
      )
    }
    expect(globals.__cordisxRuntime.snapshot().plugins).toMatchObject([{ id: owner.pluginId, status: 'active' }])
    expect(globals.__cordisxRuntime.snapshot().navigation.pages).toEqual(
      expect.arrayContaining([expect.objectContaining({ qualifiedId: `${owner.pluginId}:startup-status` })]),
    )
    expect((await globals.startupFixture!.read()).cursor.scopeId).toBe('startup-owner')
    await vi.waitFor(() =>
      expect(globals.startupModelProviders!.list().map(provider => provider.providerId).sort())
        .toEqual(['provider-one', 'provider-two'])
    )
    expect(globals.startupModelProviders!.list().every(provider => provider.models.length === 0)).toBe(true)
    expect(hostResponses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            initial: expect.objectContaining({
              kind: 'snapshot',
              snapshot: expect.objectContaining({ cursor: expect.objectContaining({ scopeId: 'work:host-models' }) }),
            }),
          }),
        }),
      ]),
    )
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
    await globals.__cordisxRuntime.dispose()
    await vi.waitFor(() => expect(hostCloseRequests).toBeGreaterThan(0))
  } finally {
    await globals.__cordisxRuntime?.dispose()
    await handler.dispose()
    authority.dispose()
    dom.window.close()
  }
})
