import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareNativeManagedGatewayConnection } from '../packages/cli/src/launcher/managed-service-native-connection.js'
import {
  declaration,
  definition,
  fixture,
  owner,
  restrictedPortDefinition,
  runtime,
} from './managed-service-runtime-fixture.js'

describe('managed service runtime gateway lifecycle', () => {
  it('rejects invalid runtime and definition configuration before launch', async () => {
    const { root, home } = await fixture()
    expect(() => runtime(home, { failuresBeforeUnhealthy: Number.NaN })).toThrow('threshold is invalid')
    const host = runtime(home, { fetch: async () => new Response(null, { status: 204 }) })
    const binding = host.bind({
      owner: owner('home-plugin', 'home-one'),
      source: 'https://plugins.example.test/home',
      declaration: declaration('home-service', 'home-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = definition('home-service', { fixedPort: 41_231 })
    value.environment = [{ variable: 'HOME', source: 'literal', value: '/tmp/not-allowed' }]
    const registration = await binding.registry.register(value, { revision: `sha256:${'2'.repeat(64)}` })
    expect((await registration.ensureReady()).status).toBe('failed')
    await binding.dispose()
  })

  it('rejects unsafe restricted port files before launch', async () => {
    const { root, home } = await fixture()
    let spawnCount = 0
    const host = runtime(home, {
      spawn: (() => {
        spawnCount += 1
        throw new Error('must not spawn')
      }) as never,
    })
    for (
      const [serviceId, prepare] of [
        ['symlink-port', async (serviceHome: string) => {
          const target = path.join(root, 'outside.port')
          await writeFile(target, '41231')
          await symlink(target, path.join(serviceHome, 'service.port'))
        }],
        ['oversized-port', async (serviceHome: string) => {
          await writeFile(path.join(serviceHome, 'service.port'), '1'.repeat(33))
        }],
      ] as const
    ) {
      const serviceHome = path.join(home, 'managed-services', 'unsafe-plugin', serviceId)
      await mkdir(serviceHome, { recursive: true })
      await prepare(serviceHome)
      const binding = host.bind({
        owner: owner('unsafe-plugin', serviceId),
        source: 'https://plugins.example.test/unsafe',
        declaration: declaration(serviceId, 'unsafe-plugin', []),
        artifactDirectory: root,
      }, new AbortController().signal)
      const registration = await binding.registry.register(restrictedPortDefinition(serviceId), {
        revision: `sha256:${serviceId === 'symlink-port' ? 'c' : 'd'}`.padEnd(
          71,
          serviceId === 'symlink-port' ? 'c' : 'd',
        ) as `sha256:${string}`,
      })
      expect((await registration.ensureReady()).status).toBe('failed')
      await binding.dispose()
    }
    expect(spawnCount).toBe(0)
  })

  it('never terminates a healthy borrowed fixed-port process', async () => {
    const { root, home } = await fixture()
    const bootstrap = runtime(home)
    const owned = bootstrap.bind({
      owner: owner('borrowed-plugin', 'bootstrap'),
      source: 'https://plugins.example.test/borrowed',
      declaration: declaration('borrowed-service', 'borrowed-plugin', [
        { pluginId: 'borrowed-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const first = await owned.registry.register(definition('borrowed-service', { hostSecret: true }), {
      revision: `sha256:${'4'.repeat(64)}`,
    })
    const ready = await first.ensureReady()
    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') throw new Error('bootstrap service failed')
    const native = prepareNativeManagedGatewayConnection(bootstrap, {
      binding: first.binding,
      compositionOrigin: 'api',
      models: { generation: 'one', defaultAlias: 'one', aliases: [{ alias: 'one', gatewayModelId: 'one/one' }] },
    })
    const port = Number(new URL(native.value.endpoint.origin).port)
    const borrower = runtime(path.join(home, 'borrower'))
    const borrowed = borrower.bind({
      owner: owner('borrowed-plugin', 'borrower'),
      source: 'https://plugins.example.test/borrowed',
      declaration: declaration('borrowed-service', 'borrowed-plugin', [
        { pluginId: 'borrowed-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await borrowed.registry.register(
      definition('borrowed-service', { fixedPort: port, hostSecret: true }),
      { revision: `sha256:${'5'.repeat(64)}` },
    )
    const borrowedReady = await registration.ensureReady()
    expect(borrowedReady.status).toBe('ready')
    if (borrowedReady.status !== 'ready') throw new Error('borrowed service failed')
    expect(borrowedReady.projection.processOwnership).toBe('borrowed')
    expect((await registration.restart()).status).toBe('unavailable')
    await borrowed.dispose()
    expect(
      (await fetch(`${native.value.endpoint.origin}/health`, {
        headers: { Authorization: `Bearer ${native.value.endpoint.auth.token}` },
      })).status,
    ).toBe(204)
    native.dispose()
    await owned.dispose()
  }, 20_000)

  it('restarts a gateway with new upstreams while keeping its registration handle stable', async () => {
    const { root, home } = await fixture()
    const host = runtime(home)
    const bind = (pluginId: string, serviceId: string) =>
      host.bind({
        owner: owner(pluginId, `${pluginId}-one`),
        source: `https://plugins.example.test/${pluginId}`,
        declaration: declaration(serviceId, pluginId, [{ pluginId: 'gateway-plugin', operations: ['models.list'] }]),
        artifactDirectory: root,
      }, new AbortController().signal)
    const sourceA = bind('source-a-plugin', 'source-a-service')
    const sourceB = bind('source-b-plugin', 'source-b-service')
    const gateway = bind('gateway-plugin', 'gateway-service')
    const regA = await sourceA.registry.register(definition('source-a-service'), {
      revision: `sha256:${'a'.repeat(64)}`,
    })
    expect((await regA.ensureReady()).status).toBe('ready')
    const leaseA = await gateway.client.acquire(regA.binding.identity)
    if (leaseA.status !== 'ready') throw new Error('lease A unavailable')
    const gatewayReg = await gateway.registry.register(
      definition('gateway-service', { configured: true, assignedInConfiguration: true }),
      { revision: `sha256:${'c'.repeat(64)}` },
    )
    const registrationHandle = gatewayReg.binding.registrationHandle
    const bindingsFor = (source: string, index: number) => [{
      targetSlot: 'sources',
      targetPointer: `/${index}` as `/${string}`,
      source: { kind: 'safe-literal' as const, value: { id: source, baseUrl: null, apiKey: null } },
    }, {
      targetSlot: 'sources',
      targetPointer: `/${index}/baseUrl` as `/${string}`,
      source: { kind: 'source-origin' as const, source, origin: 'api' },
    }, {
      targetSlot: 'sources',
      targetPointer: `/${index}/apiKey` as `/${string}`,
      source: { kind: 'source-authorization' as const, source },
    }]
    const matA = await gateway.client.materialize({
      target: gatewayReg.binding,
      revision: `sha256:${'1'.repeat(64)}`,
      sources: [{ source: 'source-a', lease: leaseA.lease }],
      bindings: bindingsFor('source-a', 0),
    })
    if (matA.status !== 'accepted') throw new Error('matA rejected')
    expect(
      (await gatewayReg.ensureReady({
        materialization: { materializationHandle: matA.materializationHandle, revision: matA.revision },
      })).status,
    ).toBe('ready')
    const genA = gatewayReg.binding.serviceGeneration
    const cfgPathA = path.join(home, 'managed-services', 'gateway-plugin', 'gateway-service', genA, 'config.json')
    expect((JSON.parse(await readFile(cfgPathA, 'utf8')) as { sources: { id: string }[] }).sources[0]?.id)
      .toBe('source-a')
    const regB = await sourceB.registry.register(definition('source-b-service'), {
      revision: `sha256:${'b'.repeat(64)}`,
    })
    expect((await regB.ensureReady()).status).toBe('ready')
    const leaseB = await gateway.client.acquire(regB.binding.identity)
    if (leaseB.status !== 'ready') throw new Error('lease B unavailable')
    const matAB = await gateway.client.materialize({
      target: gatewayReg.binding,
      revision: `sha256:${'2'.repeat(64)}`,
      sources: [{ source: 'source-a', lease: leaseA.lease }, { source: 'source-b', lease: leaseB.lease }],
      bindings: [...bindingsFor('source-a', 0), ...bindingsFor('source-b', 1)],
    })
    if (matAB.status !== 'accepted') throw new Error('matAB rejected')
    expect(
      (await gatewayReg.ensureReady({
        materialization: { materializationHandle: matAB.materializationHandle, revision: matAB.revision },
      })).status,
    ).toBe('ready')
    expect(gatewayReg.binding.registrationHandle).toBe(registrationHandle)
    expect(gatewayReg.binding.serviceGeneration).not.toBe(genA)
    const cfgPathAB = path.join(
      home,
      'managed-services',
      'gateway-plugin',
      'gateway-service',
      gatewayReg.binding.serviceGeneration,
      'config.json',
    )
    expect((JSON.parse(await readFile(cfgPathAB, 'utf8')) as { sources: { id: string }[] }).sources.map(s => s.id))
      .toEqual(['source-a', 'source-b'])
    await expect(import('node:fs/promises').then(m => m.access(cfgPathA))).rejects.toBeTruthy()
    gateway.client.release(leaseA.lease)
    gateway.client.release(leaseB.lease)
    await Promise.all([sourceA.dispose(), sourceB.dispose(), gateway.dispose()])
  }, 20_000)
})
