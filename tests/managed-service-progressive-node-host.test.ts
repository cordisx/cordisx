import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedServiceNodeHost } from '../packages/cli/src/launcher/managed-service-node-host.js'
import { ManagedServiceRuntime } from '../packages/cli/src/launcher/managed-service-runtime.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from '../packages/cli/src/launcher/packages/authority-access.js'
import { declaration, deferred, definition } from './managed-service-runtime-fixture.js'

function capability(id: string, dependencies: readonly string[] = []) {
  return {
    id,
    serviceId: 'gateway',
    kind: 'provider' as const,
    providerId: id,
    compositionOrigin: 'api',
    dependsOn: dependencies.map(capabilityId => ({ pluginId: 'example', capabilityId })),
    wait: { interactive: 'background' as const, command: 'when-selected' as const },
    milestones: [],
    success: {
      allOf: [{ kind: 'service-ready' as const }, { kind: 'catalog-known' as const }, {
        kind: 'provider-published' as const,
      }],
    },
  }
}

describe('progressive Node service preparation', () => {
  it('cancels an awaited base apply before adopting or publishing the late generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-base-cancel-'))
    const started = deferred<void>()
    const fixtureKey = `__cancel_${Date.now()}`
    Object.assign(globalThis, { [fixtureKey]: started.resolve })
    await mkdir(path.join(root, 'services'))
    await writeFile(
      path.join(root, 'services/gateway.mjs'),
      `export async function apply(ctx, input) {
      globalThis[${JSON.stringify(fixtureKey)}]()
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))
    }`,
    )
    const runtime = new ManagedServiceRuntime({ homeDir: path.join(root, 'home') })
    const host = new ManagedServiceNodeHost(runtime)
    const access: ManagedBackendRuntimeServiceModuleAccess = {
      packageIdentity: { pluginId: 'example', version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` },
      pluginIdentity: { pluginId: 'example', source: 'https://example.test/plugin', generation: 'one' },
      serviceId: 'gateway',
      hostGeneration: 'host',
      serviceKind: 'managed-backend',
      declaration: declaration('gateway', 'example', []),
      artifactDirectory: root,
      runtimeEntry: './services/gateway.mjs',
    }
    try {
      const replacing = host.replace([access])
      const rejected = expect(replacing).rejects.toThrow('disposed')
      await started.promise
      await host.dispose()
      await rejected
      expect(runtime.listRegistrationIdentities()).toEqual([])
    } finally {
      await host.dispose()
      Reflect.deleteProperty(globalThis, fixtureKey)
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('keeps v15 undeclared services in core adoption (mixed: %s)', async mixed => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-v15-blocking-'))
    await mkdir(path.join(root, 'services'))
    const release = deferred<void>()
    const entered = deferred<void>()
    const key = `__v15_blocking_${Date.now()}_${mixed}`
    Object.assign(globalThis, { [key]: { release: release.promise, entered: entered.resolve } })
    await writeFile(
      path.join(root, 'services/legacy.mjs'),
      `export async function apply(ctx) {
      globalThis[${JSON.stringify(key)}].entered()
      await globalThis[${JSON.stringify(key)}].release
      await ctx.managedServices.register(${JSON.stringify(definition('legacy'))}, { revision: 'sha256:${
        'a'.repeat(64)
      }' })
    }
    apply.inject = ['managedServices']`,
    )
    await writeFile(
      path.join(root, 'services/gateway.mjs'),
      `export async function apply(ctx) {
      await ctx.managedServices.register(${JSON.stringify(definition('gateway'))}, { revision: 'sha256:${
        'a'.repeat(64)
      }' })
    }
    apply.inject = ['managedServices']
    export function prepare() {}`,
    )
    const runtime = new ManagedServiceRuntime({ homeDir: path.join(root, 'home') })
    const host = new ManagedServiceNodeHost(runtime)
    const services = [declaration('legacy', 'example', []), ...(mixed ? [declaration('gateway', 'example', [])] : [])]
    const startup = {
      pluginId: 'example',
      pluginGeneration: 'one',
      source: 'https://example.test/plugin',
      sourceRevision: `sha256:${'a'.repeat(64)}`,
      dependencies: [],
      services,
      startup: {
        contract: 'cordisx.startup-declaration/v1' as const,
        pages: [],
        capabilities: mixed ? [capability('provider')] : [],
      },
    }
    const accesses: ManagedBackendRuntimeServiceModuleAccess[] = services.map(service => ({
      packageIdentity: { pluginId: 'example', version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` },
      pluginIdentity: { pluginId: 'example', source: 'https://example.test/plugin', generation: 'one' },
      serviceId: service.id,
      hostGeneration: 'host',
      serviceKind: 'managed-backend',
      declaration: service,
      artifactDirectory: root,
      runtimeEntry: `./services/${service.id}.mjs`,
      startup,
    }))
    try {
      const activation = await host.replace(accesses, { isolateStartupFailures: true })
      await entered.promise
      let coreReady = false
      let groupReady = false
      void activation.coreReady!.then(() => {
        coreReady = true
      })
      void activation.groups[0]!.coreReady.then(() => {
        groupReady = true
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(coreReady).toBe(false)
      expect(groupReady).toBe(false)
      release.resolve()
      await activation.coreReady
      await activation.groups[0]!.coreReady
      expect(coreReady).toBe(true)
      expect(groupReady).toBe(true)
      expect(runtime.listRegistrationIdentities()).toHaveLength(mixed ? 2 : 1)
    } finally {
      release.resolve()
      await host.dispose()
      Reflect.deleteProperty(globalThis, key)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adopts once, prepares independent targets, rejects early execution and preserves borrowed process on cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-progressive-'))
    await mkdir(path.join(root, 'services'))
    const release = deferred<void>()
    const entered = deferred<void>()
    const observations: string[] = []
    const attempts: Record<string, number> = {}
    const configurations: unknown[] = []
    const selectedConfiguration = { account: { root: './selected' } }
    const fixtureKey = `__progressive_${Date.now()}`
    Object.assign(globalThis, {
      [fixtureKey]: { release: release.promise, entered: entered.resolve, observations, attempts, configurations },
    })
    const value = definition('gateway', { fixedPort: 41231 })
    let spawns = 0
    const runtime = new ManagedServiceRuntime({
      homeDir: path.join(root, 'home'),
      fetch: async () => new Response(null, { status: 204 }),
      spawn: (() => {
        spawns += 1
        throw new Error('must borrow synthetic endpoint')
      }) as never,
    })
    const host = new ManagedServiceNodeHost(runtime)
    const accesses: ManagedBackendRuntimeServiceModuleAccess[] = [{
      packageIdentity: { pluginId: 'example', version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` },
      pluginIdentity: { pluginId: 'example', source: 'https://example.test/plugin', generation: 'one' },
      serviceId: 'gateway',
      hostGeneration: 'host-one',
      serviceKind: 'managed-backend',
      declaration: declaration('gateway', 'example', []),
      artifactDirectory: root,
      runtimeEntry: './services/gateway.mjs',
      selectedConfiguration,
      startup: {
        pluginId: 'example',
        pluginGeneration: 'one',
        source: 'https://example.test/plugin',
        sourceRevision: `sha256:${'a'.repeat(64)}`,
        dependencies: [],
        services: [declaration('gateway', 'example', [])],
        startup: {
          contract: 'cordisx.startup-declaration/v1',
          pages: [],
          capabilities: [
            capability('slow'),
            capability('fast'),
            capability('failed'),
            capability('dependent', ['fast']),
          ],
        },
      },
    }]
    await writeFile(
      path.join(root, 'services/gateway.mjs'),
      `
import { createHash } from 'node:crypto'
const fixture = globalThis[${JSON.stringify(fixtureKey)}]
export const Config = { type: 'object', '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value }) }, toJSON: () => ({ type: 'object', dict: { account: { type: 'object', dict: { root: { type: 'string' } } } } }) }
export async function apply(ctx, input) {
  fixture.configurations.push(input.configuration)
  fixture.observations.push('apply')
  await ctx.managedServices.register(${JSON.stringify(value)}, { revision: 'sha256:${'a'.repeat(64)}' })
}
apply.inject = ['managedServices']
export async function prepare(ctx, input) {
  fixture.configurations.push(input.configuration)
  const id = input.capability.id
  fixture.observations.push('prepare:' + id)
  const attempt = fixture.attempts[id] = (fixture.attempts[id] || 0) + 1
  if (id === 'failed') throw new Error('one provider failed')
  await input.registration.ensureReady()
  const generation = id + '-catalog'
  const catalog = { state: 'known', generation, modelIds: ['model'], digest: 'sha256:' + createHash('sha256').update(JSON.stringify([generation,['model']])).digest('hex') }
  await input.startup.reportCatalog({ contract: 'cordisx.startup-catalog-report/v1', target: { pluginId: 'example', capabilityId: id }, generation: input.generation, sequence: attempt, catalog })
  const routes = [{ alias: 'model', gatewayModelId: 'gateway-model' }]
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify([generation, 'model', [['model','gateway-model']]])).digest('hex')
  const result = await input.registration.publishNativeProvider({ providerId: id, compositionOrigin: 'api', catalog: { generation, digest, defaultAlias: 'model', routes } })
  fixture.observations.push('publication:' + id + ':' + result.status)
  if (id === 'slow' && attempt === 1) { fixture.entered(); await fixture.release; throw new Error('old attempt returned late') }
}
`,
    )
    try {
      const invalid = new Proxy({}, {
        ownKeys() {
          throw new Error('must not invoke')
        },
      })
      await expect(host.replace([{ ...accesses[0]!, selectedConfiguration: invalid }])).rejects.toThrow('safe JSON')
      expect(observations).toEqual([])
      expect(runtime.listRegistrationIdentities()).toEqual([])
      const pending = host.replace(accesses, { isolateStartupFailures: true })
      selectedConfiguration.account.root = './later'
      const activation = await pending
      await entered.promise
      const authority = activation.startup!
      expect(observations.filter(item => item === 'apply')).toHaveLength(1)
      expect(authority.availability({ pluginId: 'example', capabilityId: 'slow' })).toMatchObject({ available: false })
      expect(activation.nativeProviderIds).not.toContain('slow')
      await expect(authority.wait({ pluginId: 'example', capabilityId: 'fast' })).resolves.toEqual({ available: true })
      await expect(authority.wait({ pluginId: 'example', capabilityId: 'dependent' })).resolves.toEqual({
        available: true,
      })
      expect(authority.availability({ pluginId: 'example', capabilityId: 'failed' })).toMatchObject({
        reason: 'failed',
      })
      expect(observations.indexOf('prepare:dependent')).toBeGreaterThan(
        observations.indexOf('publication:fast:accepted'),
      )
      activation.retryStartup!({ pluginId: 'example', capabilityId: 'slow' })
      await expect(authority.wait({ pluginId: 'example', capabilityId: 'slow' })).resolves.toEqual({ available: true })
      release.resolve()
      await new Promise(resolve => setImmediate(resolve))
      expect(activation.nativeProviderIds).toContain('slow')
      expect(observations.filter(item => item === 'apply')).toHaveLength(1)
      await expect(authority.wait({ pluginId: 'example', capabilityId: 'slow' })).resolves.toEqual({ available: true })
      expect(configurations.length).toBeGreaterThan(5)
      expect(configurations.every(value => value === configurations[0])).toBe(true)
      expect(configurations[0]).toEqual({
        contract: 'cordisx.managed-service-instance-configuration/v1',
        value: { account: { root: './selected' } },
      })
      expect(Object.isFrozen(configurations[0])).toBe(true)
      expect(Object.isFrozen((configurations[0] as { value: { account: object } }).value.account)).toBe(true)
      expect(spawns).toBe(0)
      await host.dispose()
      expect(runtime.listNativeProviderIds()).toEqual([])
    } finally {
      release.resolve()
      await host.dispose()
      Reflect.deleteProperty(globalThis, fixtureKey)
      await rm(root, { recursive: true, force: true })
    }
  })
})
