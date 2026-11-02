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
  it('adopts once, prepares independent targets, rejects early execution and preserves borrowed process on cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-progressive-'))
    await mkdir(path.join(root, 'services'))
    const release = deferred<void>()
    const entered = deferred<void>()
    const observations: string[] = []
    const fixtureKey = `__progressive_${Date.now()}`
    Object.assign(globalThis, { [fixtureKey]: { release: release.promise, entered: entered.resolve, observations } })
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
export async function apply(ctx) {
  fixture.observations.push('apply')
  await ctx.managedServices.register(${JSON.stringify(value)}, { revision: 'sha256:${'a'.repeat(64)}' })
}
apply.inject = ['managedServices']
export async function prepare(ctx, input) {
  const id = input.capability.id
  fixture.observations.push('prepare:' + id)
  if (id === 'failed') throw new Error('one provider failed')
  await input.registration.ensureReady()
  const generation = id + '-catalog'
  const catalog = { state: 'known', generation, modelIds: ['model'], digest: 'sha256:' + createHash('sha256').update(JSON.stringify([generation,['model']])).digest('hex') }
  await input.startup.reportCatalog({ contract: 'cordisx.startup-catalog-report/v1', target: { pluginId: 'example', capabilityId: id }, generation: input.generation, sequence: 1, catalog })
  const routes = [{ alias: 'model', gatewayModelId: 'gateway-model' }]
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify([generation, 'model', [['model','gateway-model']]])).digest('hex')
  const result = await input.registration.publishNativeProvider({ providerId: id, compositionOrigin: 'api', catalog: { generation, digest, defaultAlias: 'model', routes } })
  fixture.observations.push('publication:' + id + ':' + result.status)
  if (id === 'slow') { fixture.entered(); await fixture.release }
}
`,
    )
    try {
      const activation = await host.replace(accesses, { isolateStartupFailures: true })
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
      release.resolve()
      await expect(authority.wait({ pluginId: 'example', capabilityId: 'slow' })).resolves.toEqual({ available: true })
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
