import type { StartupEventV1, StartupObserverV1, StartupSnapshotV1 } from '@cordisx/protocol/startup/v1'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { ManagedServiceNodeHost } from '../packages/cli/src/launcher/managed-service-node-host.js'
import { ManagedServiceRuntime } from '../packages/cli/src/launcher/managed-service-runtime.js'
import { createManagedServiceUIBridgeHandler } from '../packages/cli/src/launcher/managed-service-ui-rpc.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from '../packages/cli/src/launcher/packages/authority-access.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { declaration, deferred, definition } from './managed-service-runtime-fixture.js'

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const target = { pluginId: 'example', capabilityId: 'provider' }
const snapshots = (events: StartupEventV1[]): StartupSnapshotV1[] =>
  events.flatMap(event => event.kind === 'snapshot' ? [event.snapshot] : [])

it('carries the immutable R lifecycle and Node producer through B before adoption, preparation and execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-producer-bridge-'))
  const adoption = deferred<void>(), preparation = deferred<void>(), entered = deferred<void>()
  const key = `__startup_bridge_${Date.now()}`
  Object.assign(globalThis, { [key]: { preparation: preparation.promise, entered: entered.resolve } })
  const service = declaration('gateway', 'example', [])
  const admission = {
    pluginId: 'example',
    pluginGeneration: 'plugin-one',
    source: 'https://example.test/plugin',
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    dependencies: [],
    services: [service],
    startup: {
      contract: 'cordisx.startup-declaration/v1' as const,
      capabilities: [{
        id: target.capabilityId,
        serviceId: 'gateway',
        kind: 'provider' as const,
        providerId: 'provider',
        compositionOrigin: 'api',
        dependsOn: [],
        wait: { interactive: 'background' as const, command: 'when-selected' as const },
        milestones: [],
        success: {
          allOf: [{ kind: 'service-ready' as const }, { kind: 'catalog-known' as const }, {
            kind: 'provider-published' as const,
          }],
        },
      }],
      pages: [{ pageId: 'status', observes: [target], actions: [{ actionId: 'execute', requires: [target] }] }],
    },
  }
  const generation = 'host-one'
  const accesses: ManagedBackendRuntimeServiceModuleAccess[] = [{
    packageIdentity: { pluginId: 'example', version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` },
    pluginIdentity: { pluginId: 'example', source: admission.source, generation: admission.pluginGeneration },
    serviceId: 'gateway',
    hostGeneration: generation,
    serviceKind: 'managed-backend',
    declaration: service,
    artifactDirectory: root,
    runtimeEntry: './services/gateway.mjs',
    startup: admission,
  }]
  await mkdir(path.join(root, 'services'))
  await writeFile(
    path.join(root, 'services/gateway.mjs'),
    `
import { createHash } from 'node:crypto'
const fixture = globalThis[${JSON.stringify(key)}]
export async function apply(ctx) { await ctx.managedServices.register(${
      JSON.stringify(definition('gateway', { fixedPort: 41237 }))
    }, { revision: 'sha256:${'a'.repeat(64)}' }) }
apply.inject = ['managedServices']
export async function prepare(ctx, input) {
  await input.registration.ensureReady()
  const generation = 'catalog-one'
  const modelIds = ['model']
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify([generation,modelIds])).digest('hex')
  await input.startup.reportCatalog({ contract: 'cordisx.startup-catalog-report/v1', target: ${
      JSON.stringify(target)
    }, generation: input.generation, sequence: 1, catalog: { state: 'known', generation, modelIds, digest } })
  const routes = [{alias:'model',gatewayModelId:'gateway-model'}]
  const published = 'sha256:' + createHash('sha256').update(JSON.stringify([generation,'model',[['model','gateway-model']]])).digest('hex')
  await input.registration.publishNativeProvider({providerId:'provider',compositionOrigin:'api',catalog:{generation,digest:published,defaultAlias:'model',routes}})
  fixture.entered()
  await fixture.preparation
}
`,
  )
  const spawn = vi.fn(() => {
    throw new Error('synthetic endpoint must be borrowed')
  })
  const runtime = new ManagedServiceRuntime({
    homeDir: path.join(root, 'home'),
    fetch: async () => new Response(null, { status: 204 }),
    spawn: spawn as never,
  })
  let host: ManagedServiceNodeHost | undefined
  const lifecycle = new ManagedServicePluginLifecycleRuntime({
    runtime: {} as PluginLifecycleRuntime,
    profileId: 'work',
    runtimeGeneration: generation,
    readStartupAdmissions: async () => [admission],
    activate: async (_record, options) => {
      await adoption.promise
      host = new ManagedServiceNodeHost(runtime, 'work', generation, options.startupAuthority)
      return await host.replace(accesses, options)
    },
  })
  let bridge: BrowserManagedServiceUIBridge | undefined
  let hostHandler: ReturnType<typeof createManagedServiceUIBridgeHandler> | undefined
  try {
    const session = await lifecycle.initialize({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: generation,
      plugins: [{
        id: 'example',
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}`,
        moduleGeneration: admission.pluginGeneration,
        enabled: true,
        dependencies: [],
      }],
    })
    const capability = lifecycle.capabilities()[0]!
    expect(capability.startup).toBe(true)
    const hostCapability = lifecycle.hostStartupCapability()
    expect(hostCapability.token).not.toBe(capability.token)
    hostHandler = createManagedServiceUIBridgeHandler({
      token: capability.token,
      profileId: 'work',
      generation,
      services: [],
      hostStartup: hostCapability,
    })
    const wires: Record<string, unknown>[] = []
    globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
      const request = JSON.parse(payload)
      wires.push(request)
      const response = request.token === hostCapability.token
        ? hostHandler!.hostStartup!.handleBindingValue(payload)
        : lifecycle.managedServiceUI.handleBindingValue(payload)
      void response.then(value => globalThis.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify(value)))
    }
    bridge = BrowserManagedServiceUIBridge.connect(lifecycle.capabilities(), 'work', generation, {
      token: hostCapability.token,
    })
    const owner = { pluginId: 'example', pluginGeneration: admission.pluginGeneration }
    const observer = bridge.bindStartup(owner)!
    const events: StartupEventV1[] = []
    const subscription = await bounded(observer.subscribe(event => events.push(event)), 'initial subscription')
    expect(snapshots(events).at(-1)!.entries[0]).toMatchObject({
      identity: { providerId: 'provider' },
      state: 'declared',
      generation: { service: null },
      actions: { execute: { available: false } },
    })
    expect(await bridge.bind(owner)!.get({ serviceId: 'gateway' })).toMatchObject({
      status: 'unavailable',
      message: 'binding-unavailable',
    })
    const hostSnapshot = await bridge.bindHostStartup()!.read()
    expect(hostSnapshot.entries).toHaveLength(1)
    expect(hostSnapshot.cursor.scopeId).not.toBe(snapshots(events)[0]!.cursor.scopeId)
    await expect(observer.subscribe(() => {}, { after: hostSnapshot.cursor })).rejects.toThrow()
    // Real R sends zero events for an already-current retained cursor; B must not hang.
    const resumed = await bounded(
      observer.subscribe(() => {}, { after: snapshots(events).at(-1)!.cursor }),
      'current cursor subscription',
    )
    resumed.close()
    adoption.resolve()
    await bounded(session.adopted, 'base adoption')
    await bounded(entered.promise, 'prepare entry')
    expect(lifecycle.capabilities()[0]!.token).toBe(capability.token)
    await vi.waitFor(() =>
      expect(snapshots(events).at(-1)!.entries[0]).toMatchObject({
        state: 'preparing',
        catalog: { state: 'known', modelIds: ['model'] },
        actions: { execute: { available: false } },
      })
    )
    expect(lifecycle.nativeActivation().nativeProviderIds).not.toContain('provider')
    preparation.resolve()
    await vi.waitFor(() =>
      expect(snapshots(events).at(-1)!.entries[0]).toMatchObject({
        state: 'ready',
        actions: { execute: { available: true } },
      })
    )
    expect(lifecycle.nativeActivation().nativeProviderIds).toContain('provider')
    expect((await bridge.bind(owner)!.get({ serviceId: 'gateway' })).status).toBe('available')
    const connectedBefore = events.filter(event =>
      event.kind === 'connection' && event.connection.state === 'connected'
    ).length
    bridge.transportDisconnected()
    await vi.waitFor(() =>
      expect(events.filter(event => event.kind === 'connection' && event.connection.state === 'connected'))
        .toHaveLength(connectedBefore + 1)
    )
    expect(wires.filter(wire => wire.operation === 'startupSubscribe').length).toBeGreaterThanOrEqual(3)
    await lifecycle.dispose()
    await vi.waitFor(() => expect(events.filter(event => event.kind === 'closed')).toHaveLength(1))
    expect(events.at(-1)).toMatchObject({ kind: 'closed', reason: 'scope-revoked' })
    const count = events.length
    subscription.close()
    await Promise.resolve()
    expect(events).toHaveLength(count)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    adoption.resolve()
    preparation.resolve()
    bridge?.dispose()
    await hostHandler?.dispose()
    await lifecycle.dispose()
    await host?.dispose()
    delete globalThis.__cordisxManagedServiceUIRequestV1
    delete globalThis.__cordisxManagedServiceUIReceiveV1
    Reflect.deleteProperty(globalThis, key)
    await rm(root, { recursive: true, force: true })
  }
})
