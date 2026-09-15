import type { PluginManifestManagedBackendServiceV14 } from '@cordisx/protocol/plugin-manifest/v14'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedServiceNodeHost } from '../packages/cli/src/launcher/managed-service-node-host.js'
import { ManagedServiceRuntime } from '../packages/cli/src/launcher/managed-service-runtime.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from '../packages/cli/src/launcher/packages/authority-access.js'
import { syntheticChild } from './managed-service-runtime-fixture.js'

const DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json'
const eventsKey = '__cordisxManagedContextEvents'

declare global {
  var __cordisxManagedContextEvents: string[] | undefined
}

function declaration(id: string): PluginManifestManagedBackendServiceV14 {
  return {
    id,
    kind: 'managed-backend',
    owner: 'host',
    entry: `./services/${id}.mjs`,
    definitionSchema: DEFINITION_SCHEMA,
    runtimeResources: [],
    consumerGrants: [],
  }
}

function access(
  root: string,
  pluginId: string,
  serviceId: string,
  generation: string,
): ManagedBackendRuntimeServiceModuleAccess {
  return {
    packageIdentity: { pluginId, version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` },
    pluginIdentity: { source: `https://plugins.example.test/${pluginId}`, pluginId, generation },
    serviceId,
    hostGeneration: 'host-one',
    serviceKind: 'managed-backend',
    declaration: declaration(serviceId),
    artifactDirectory: root,
    runtimeEntry: `./services/${serviceId}.mjs`,
  }
}

function nativePublication(providerId: string, alias: string, gatewayModelId: string) {
  const generation = `${providerId}-catalog`
  const routes = [{ alias, gatewayModelId }]
  const digest = `sha256:${
    createHash('sha256').update(
      JSON.stringify([generation, alias, routes.map(route => [route.alias, route.gatewayModelId])]),
    ).digest('hex')
  }`
  return {
    providerId,
    compositionOrigin: 'api',
    catalog: { generation, digest, defaultAlias: alias, routes },
  }
}

afterEach(() => {
  delete globalThis.__cordisxManagedContextEvents
})

describe('managed service Node context providers', () => {
  it('publishes logout only for a declared helper and projects the completed action', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    const authenticated = {
      executable: { kind: 'named-command', command: 'synthetic-auth' },
      arguments: [],
      timeoutMs: 100,
      outcomes: [{ exitCode: 0, state: 'authenticated' }],
    }
    const definition = {
      $schema: DEFINITION_SCHEMA,
      contract: 'cordisx.managed-service-definition/v1',
      schemaVersion: 1,
      serviceId: 'gateway',
      launch: {
        executable: { kind: 'named-command', command: 'unused' },
        arguments: [],
        startupTimeoutMs: 100,
      },
      compositionOrigins: [{ id: 'api', path: '/v1' }],
      protectedBindings: [],
      authentication: {
        mode: 'cli',
        status: authenticated,
        login: authenticated,
        logout: {
          ...authenticated,
          outcomes: [{ exitCode: 0, state: 'authentication-required' }],
        },
      },
      httpAuthentication: { mode: 'none' },
      discovery: { kind: 'fixed-loopback', port: 41_231 },
      operations: [{
        operationId: 'models.list',
        method: 'GET',
        path: '/v1/models',
        responseSchema: 'https://schemas.example.test/models.v1.json',
        timeoutMs: 100,
      }],
      health: { path: '/health', intervalMs: 250, timeoutMs: 100 },
    }
    await writeFile(
      path.join(root, 'services', 'gateway.mjs'),
      `
export async function apply(ctx) {
  const registration = await ctx.managedServices.register(${JSON.stringify(definition)}, {
    revision: 'sha256:${'d'.repeat(64)}',
  })
  const result = await registration.ensureReady()
  if (result.status !== 'ready') throw new Error('gateway not ready')
}
apply.inject = ['managedServices']
`,
    )
    const runtime = new ManagedServiceRuntime({
      homeDir: path.join(root, 'home'),
      fetch: async () => new Response(null, { status: 204 }),
      spawn: (() => {
        const action = syntheticChild()
        queueMicrotask(() => action.exit(0))
        return action.child
      }) as ConstructorParameters<typeof ManagedServiceRuntime>[0]['spawn'],
    })
    const host = new ManagedServiceNodeHost(runtime)
    const activation = await host.replace([access(root, 'gateway-plugin', 'gateway', 'gateway-one')])
    expect(activation.sources[0]?.loginTimeoutMs).toBe(100)
    const source = activation.sources[0]!.source
    const before = await source.snapshot()
    expect(before.status).toBe('available')
    if (before.status !== 'available') throw new Error('snapshot unavailable')
    expect(before.projection).toMatchObject({
      auth: { state: 'authenticated' },
      capabilities: { logout: true },
    })

    const logout = await source.logout({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-node-host',
      binding: source.binding,
      action: 'logout',
      expectedSequence: before.projection.sequence,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    })
    expect(logout).toMatchObject({ status: 'accepted', stateAt: 'logged-out' })
    const after = await source.snapshot()
    expect(after).toMatchObject({
      status: 'available',
      projection: { readiness: 'stopped', auth: { state: 'logged-out' } },
    })
    await activation.dispose()
  })

  it.each(['bearer', 'none'] as const)(
    'resolves an accepted native publication with %s authentication',
    async scheme => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
      await mkdir(path.join(root, 'services'))
      const definition = {
        $schema: DEFINITION_SCHEMA,
        contract: 'cordisx.managed-service-definition/v1',
        schemaVersion: 1,
        serviceId: 'gateway',
        launch: {
          executable: { kind: 'named-command', command: 'unused' },
          arguments: [],
          startupTimeoutMs: 100,
        },
        compositionOrigins: [{ id: 'api', path: '/v1' }],
        protectedBindings: [{
          slot: 'service_key',
          source: 'generated-local-key',
          target: 'environment',
          variable: 'SERVICE_TOKEN',
        }],
        authentication: { mode: 'none' },
        httpAuthentication: scheme === 'none'
          ? { mode: 'none' }
          : { mode: 'authorization-header', scheme: 'Bearer', slot: 'service_key' },
        discovery: { kind: 'fixed-loopback', port: 41_231 },
        operations: [{
          operationId: 'models.list',
          method: 'GET',
          path: '/v1/models',
          responseSchema: 'https://schemas.example.test/models.v1.json',
          timeoutMs: 100,
        }],
        health: { path: '/health', intervalMs: 250, timeoutMs: 100 },
      }
      await writeFile(
        path.join(root, 'services', 'gateway.mjs'),
        `
export async function apply(ctx) {
  const registration = await ctx.managedServices.register(${JSON.stringify(definition)}, {
    revision: 'sha256:${'e'.repeat(64)}',
  })
  const result = await registration.ensureReady()
  if (result.status !== 'ready') throw new Error('gateway not ready')
  const publication = await registration.publishNativeProvider(${
          JSON.stringify(nativePublication('gateway-alpha', 'source-alpha', 'source-alpha/model-one'))
        })
  if (publication.status !== 'accepted') throw new Error('gateway publication rejected')
}
apply.inject = ['managedServices']
`,
      )
      const host = new ManagedServiceNodeHost(
        new ManagedServiceRuntime({
          homeDir: path.join(root, 'home'),
          fetch: async () => new Response(null, { status: 204 }),
        }),
      )
      const activation = await host.replace([access(root, 'gateway-plugin', 'gateway', 'gateway-one')])
      expect(activation.nativeProviderIds).toEqual(['gateway-alpha'])
      const session = activation.prepareNativeConnection('gateway-alpha')
      expect(session.value).toMatchObject({
        service: { pluginId: 'gateway-plugin', serviceId: 'gateway' },
        endpoint: { origin: 'http://127.0.0.1:41231', apiPath: '/v1', auth: { scheme } },
        models: {
          defaultAlias: 'source-alpha',
          aliases: [{ alias: 'source-alpha', gatewayModelId: 'source-alpha/model-one' }],
        },
      })
      expect(Object.isFrozen(session.value.models.aliases)).toBe(true)
      if (scheme === 'none') expect(session.value.endpoint.auth).toEqual({ scheme: 'none' })
      expect(JSON.stringify(session.value)).not.toContain(root)
      expect(() => activation.prepareNativeConnection('missing-provider')).toThrow('unavailable')
      await activation.dispose()
      expect(() => activation.prepareNativeConnection('gateway-alpha')).toThrow('unavailable')
    },
  )

  it('binds opaque producer services before apply and disposes binding before provider root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    await writeFile(
      path.join(root, 'services', 'provider.mjs'),
      `
const events = globalThis.${eventsKey}
export const contextServices = [{
  service: 'testService',
  create({ target }) {
    events.push('root:create:' + target.pluginGeneration)
    let active = true
    return {
      providerValue: { role: 'provider', target },
      bind({ producer, target }) {
        events.push('bind:' + producer.pluginId + ':' + target.pluginGeneration)
        return {
          value: { role: 'consumer', producer },
          dispose() { events.push('binding:dispose:' + producer.pluginId) },
        }
      },
      dispose() { active = false; events.push('root:dispose:' + String(active)) },
    }
  },
}]
export async function apply(ctx) {
  events.push('provider:apply:' + ctx.testService.role)
}
apply.inject = ['testService']
`,
    )
    await writeFile(
      path.join(root, 'services', 'consumer.mjs'),
      `
const events = globalThis.${eventsKey}
export async function apply(ctx) {
  events.push('consumer:apply:' + ctx.testService.producer.pluginId)
}
apply.inject = ['testService']
`,
    )
    globalThis.__cordisxManagedContextEvents = []
    const host = new ManagedServiceNodeHost(new ManagedServiceRuntime({ homeDir: path.join(root, 'home') }))
    const activation = await host.replace([
      access(root, 'provider-plugin', 'provider', 'provider-one'),
      access(root, 'consumer-plugin', 'consumer', 'consumer-one'),
    ])
    expect(activation.authorities).toHaveLength(2)
    expect(globalThis.__cordisxManagedContextEvents).toEqual([
      'root:create:provider-one',
      'bind:consumer-plugin:provider-one',
      'consumer:apply:consumer-plugin',
      'provider:apply:provider',
    ])
    const firstDispose = activation.dispose()
    expect(activation.dispose()).toBe(firstDispose)
    await firstDispose
    expect(globalThis.__cordisxManagedContextEvents?.slice(-2)).toEqual([
      'binding:dispose:consumer-plugin',
      'root:dispose:false',
    ])
  })

  it('rejects duplicate provider names before any managed apply runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    const source = `
export const contextServices = [{
  service: 'testService',
  create() { return { providerValue: {}, bind() { return { value: {}, dispose() {} } }, dispose() {} } },
}]
export async function apply() { globalThis.${eventsKey}.push('apply') }
`
    await Promise.all([
      writeFile(path.join(root, 'services', 'one.mjs'), source),
      writeFile(path.join(root, 'services', 'two.mjs'), source),
    ])
    globalThis.__cordisxManagedContextEvents = []
    const host = new ManagedServiceNodeHost(new ManagedServiceRuntime({ homeDir: path.join(root, 'home') }))
    await expect(host.replace([
      access(root, 'one-plugin', 'one', 'one'),
      access(root, 'two-plugin', 'two', 'two'),
    ])).rejects.toThrow('invalid or duplicated')
    expect(globalThis.__cordisxManagedContextEvents).toEqual([])
  })

  it('owns the runtime binding before module import validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    await writeFile(path.join(root, 'services', 'invalid.mjs'), 'export const invalid = true\n')
    const runtime = new ManagedServiceRuntime({ homeDir: path.join(root, 'home') })
    const bind = runtime.bind.bind(runtime)
    let disposed = false
    vi.spyOn(runtime, 'bind').mockImplementation((input, signal) => {
      const binding = bind(input, signal)
      return Object.freeze({
        ...binding,
        dispose: async () => {
          disposed = true
          await binding.dispose()
        },
      })
    })
    const host = new ManagedServiceNodeHost(runtime)
    await expect(host.replace([access(root, 'invalid-plugin', 'invalid', 'invalid-one')])).rejects.toThrow(
      'exports no apply function',
    )
    expect(disposed).toBe(true)
  })

  it('drains and disposes a binding that resolves after a sibling apply fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    await writeFile(
      path.join(root, 'services', 'provider.mjs'),
      `
const events = globalThis.${eventsKey}
export const contextServices = [{
  service: 'testService',
  create() {
    events.push('root:create')
    return {
      providerValue: {},
      async bind({ producer }) {
        events.push('bind:start:' + producer.pluginId)
        await new Promise(resolve => setTimeout(resolve, 30))
        events.push('bind:return:' + producer.pluginId)
        return { value: {}, dispose() { events.push('binding:dispose:' + producer.pluginId) } }
      },
      dispose() { events.push('root:dispose') },
    }
  },
}]
export async function apply() { events.push('provider:apply') }
`,
    )
    await writeFile(
      path.join(root, 'services', 'slow.mjs'),
      `
export async function apply() { globalThis.${eventsKey}.push('slow:apply') }
apply.inject = ['testService']
`,
    )
    await writeFile(
      path.join(root, 'services', 'failing.mjs'),
      `export async function apply() { globalThis.${eventsKey}.push('failing:apply'); throw new Error('fail') }\n`,
    )
    globalThis.__cordisxManagedContextEvents = []
    const host = new ManagedServiceNodeHost(new ManagedServiceRuntime({ homeDir: path.join(root, 'home') }))
    await expect(host.replace([
      access(root, 'provider-plugin', 'provider', 'provider-one'),
      access(root, 'slow-plugin', 'slow', 'slow-one'),
      access(root, 'failing-plugin', 'failing', 'failing-one'),
    ])).rejects.toThrow('fail')
    expect(globalThis.__cordisxManagedContextEvents).toEqual([
      'root:create',
      'bind:start:slow-plugin',
      'failing:apply',
      'bind:return:slow-plugin',
      'binding:dispose:slow-plugin',
      'root:dispose',
    ])
  })

  it('rejects reserved Host context service names before creating roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    await writeFile(
      path.join(root, 'services', 'reserved.mjs'),
      `
export const contextServices = [{
  service: 'managedServices',
  create() { globalThis.${eventsKey}.push('root:create'); return { providerValue: {}, bind() {}, dispose() {} } },
}]
export async function apply() { globalThis.${eventsKey}.push('apply') }
`,
    )
    globalThis.__cordisxManagedContextEvents = []
    const host = new ManagedServiceNodeHost(new ManagedServiceRuntime({ homeDir: path.join(root, 'home') }))
    await expect(host.replace([access(root, 'reserved-plugin', 'reserved', 'reserved-one')])).rejects.toThrow(
      'reserved',
    )
    expect(globalThis.__cordisxManagedContextEvents).toEqual([])
  })

  it('serializes concurrent replacements through complete generation cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
    await mkdir(path.join(root, 'services'))
    await writeFile(
      path.join(root, 'services', 'provider.mjs'),
      `
const events = globalThis.${eventsKey}
export const contextServices = [{
  service: 'testService',
  create({ target }) {
    const generation = target.pluginGeneration
    events.push('root:create:' + generation)
    return {
      providerValue: { generation },
      bind() { return { value: {}, dispose() {} } },
      async dispose() {
        events.push('root:dispose:start:' + generation)
        await new Promise(resolve => setTimeout(resolve, 20))
        events.push('root:dispose:end:' + generation)
      },
    }
  },
}]
export async function apply(ctx) { events.push('apply:' + ctx.testService.generation) }
apply.inject = ['testService']
`,
    )
    globalThis.__cordisxManagedContextEvents = []
    const host = new ManagedServiceNodeHost(new ManagedServiceRuntime({ homeDir: path.join(root, 'home') }))
    await host.replace([access(root, 'provider-plugin', 'provider', 'one')])
    const second = host.replace([access(root, 'provider-plugin', 'provider', 'two')])
    const third = host.replace([access(root, 'provider-plugin', 'provider', 'three')])
    await Promise.all([second, third])
    expect(globalThis.__cordisxManagedContextEvents).toEqual([
      'root:create:one',
      'apply:one',
      'root:dispose:start:one',
      'root:dispose:end:one',
      'root:create:two',
      'apply:two',
      'root:dispose:start:two',
      'root:dispose:end:two',
      'root:create:three',
      'apply:three',
    ])
    await host.dispose()
  })
})

it('exposes managedServiceUI extension with readCatalog in source capabilities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-node-'))
  await mkdir(path.join(root, 'services'))
  const definition = {
    $schema: DEFINITION_SCHEMA,
    contract: 'cordisx.managed-service-definition/v1',
    schemaVersion: 1,
    serviceId: 'gateway',
    launch: {
      executable: { kind: 'named-command', command: 'unused' },
      arguments: [],
      startupTimeoutMs: 100,
    },
    compositionOrigins: [{ id: 'api', path: '/v1' }],
    protectedBindings: [{
      slot: 'service_key',
      source: 'generated-local-key',
      target: 'environment',
      variable: 'SERVICE_TOKEN',
    }],
    authentication: { mode: 'none' },
    httpAuthentication: { mode: 'authorization-header', scheme: 'Bearer', slot: 'service_key' },
    discovery: { kind: 'fixed-loopback', port: 41_232 },
    operations: [{
      operationId: 'models.list',
      method: 'GET',
      path: '/v1/models',
      responseSchema: 'https://schemas.example.test/models.v1.json',
      timeoutMs: 100,
    }],
    health: { path: '/health', intervalMs: 250, timeoutMs: 100 },
  }
  const catalogValue = { providers: [{ id: 'traex', models: [{ id: 'm1', name: 'Model 1' }] }] }
  await writeFile(
    path.join(root, 'services', 'gateway.mjs'),
    `
export const managedServiceUI = {
  serviceId: 'gateway',
  create({ binding, registration, client, signal }) {
    return {
      async readCatalog() {
        return ${JSON.stringify(catalogValue)}
      },
      async readAccounts() {
        return { accounts: [] }
      },
      async toggleAccount(request) {
        return { status: 'success', accountId: request.accountId }
      },
    }
  },
}
export async function apply(ctx) {
  const registration = await ctx.managedServices.register(${JSON.stringify(definition)}, {
    revision: 'sha256:${'f'.repeat(64)}',
  })
  await registration.ensureReady()
}
apply.inject = ['managedServices']
`,
  )
  const host = new ManagedServiceNodeHost(
    new ManagedServiceRuntime({
      homeDir: path.join(root, 'home'),
      fetch: async () => new Response(null, { status: 204 }),
    }),
  )
  const activation = await host.replace([access(root, 'gateway-plugin', 'gateway', 'gateway-one')])
  expect(activation.sources).toHaveLength(1)
  const svc = activation.sources[0]
  expect(svc.pluginId).toBe('gateway-plugin')
  expect(svc.serviceId).toBe('gateway')

  // Snapshot should show readCatalog capability
  const snapshot = await svc.source.snapshot()
  expect(snapshot.status).toBe('available')
  if (snapshot.status !== 'available') throw new Error('snapshot unavailable')
  expect(snapshot.projection.capabilities.readCatalog).toBe(true)

  // readCatalog should be callable and return the catalog
  const source = svc.source as Record<string, unknown>
  expect(source.readCatalog).toBeTypeOf('function')
  const catalog = await (source.readCatalog as () => Promise<unknown>)()
  expect(catalog).toEqual(catalogValue)

  // readAccounts and toggleAccount should also be callable
  expect(source.readAccounts).toBeTypeOf('function')
  const accounts = await (source.readAccounts as () => Promise<unknown>)()
  expect(accounts).toEqual({ accounts: [] })

  expect(source.toggleAccount).toBeTypeOf('function')
  const toggle = await (source.toggleAccount as (req: unknown) => Promise<unknown>)({ accountId: 'acct-1' })
  expect(toggle).toEqual({ status: 'success', accountId: 'acct-1' })

  await activation.dispose()
})
