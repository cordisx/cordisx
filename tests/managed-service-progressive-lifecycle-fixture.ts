import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { ManagedServiceNodeHost } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import type { StartupPluginAdmission } from '../packages/cli/src/launcher/managed-service-startup-admission.js'
import { ManagedServiceRuntime } from '../packages/cli/src/launcher/managed-service-runtime.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from '../packages/cli/src/launcher/packages/authority-access.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
} from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { declaration, deferred, definition, syntheticChild } from './managed-service-runtime-fixture.js'

export interface ComponentSpec {
  readonly pluginId: string
  readonly serviceId?: string
  readonly legacy?: boolean
  readonly slow?: boolean
  readonly slowPrepare?: boolean
  readonly configuration?: { one: Record<string, unknown>; two: Record<string, unknown> }
  readonly fail?: boolean
  readonly dependsOn?: string
  readonly slowContext?: boolean
  readonly providesContext?: boolean
  readonly consumesContext?: boolean
}

export async function progressiveLifecycleFixture(specs: readonly ComponentSpec[], assigned = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-progressive-lifecycle-'))
  const fixtureKey = `__progressive_${randomUUID()}`
  const release = deferred<void>()
  const releaseCandidate = deferred<void>()
  const observations: string[] = []
  const configurations: { phase: string; pluginId: string; generation: string; input: unknown; keys: string[] }[] = []
  Object.assign(globalThis, {
    [fixtureKey]: {
      release: release.promise,
      releaseCandidate: releaseCandidate.promise,
      observations,
      configurations,
    },
  })
  const accesses: (Omit<ManagedBackendRuntimeServiceModuleAccess, 'startup'> & { startup?: StartupPluginAdmission })[] =
    specs.map((spec, index) => {
      const serviceId = spec.serviceId ?? 'gateway'
      const pluginId = spec.pluginId
      return {
        pluginIdentity: { pluginId, generation: 'one', source: `https://example.test/${pluginId}` },
        packageIdentity: { pluginId, version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` },
        serviceId,
        hostGeneration: 'runtime',
        serviceKind: 'managed-backend',
        artifactDirectory: root,
        runtimeEntry: `./${index}.mjs`,
        declaration: declaration(
          serviceId,
          pluginId,
          specs.filter(item => item.dependsOn === pluginId).map(item => ({ pluginId: item.pluginId, operations: [] })),
        ),
      }
    })
  for (const [index, access] of accesses.entries()) {
    const spec = specs[index]!
    if (!spec.legacy) {
      const siblings = accesses.filter(item => item.pluginIdentity.pluginId === access.pluginIdentity.pluginId)
      access.startup = {
        pluginId: access.pluginIdentity.pluginId,
        pluginGeneration: 'one',
        source: access.pluginIdentity.source,
        sourceRevision: access.packageIdentity.integrity,
        dependencies: [
          ...new Set(
            specs.filter(item => item.pluginId === spec.pluginId).flatMap(item =>
              item.dependsOn ? [item.dependsOn] : []
            ),
          ),
        ],
        services: siblings.map(item => item.declaration),
        startup: {
          contract: 'cordisx.startup-declaration/v1',
          pages: [],
          capabilities: siblings.map(item => ({
            id: item.serviceId,
            serviceId: item.serviceId,
            kind: 'provider',
            providerId: `${spec.pluginId}-${item.serviceId}`,
            compositionOrigin: 'api',
            dependsOn: spec.dependsOn ? [{ pluginId: spec.dependsOn, capabilityId: 'gateway' }] : [],
            wait: { interactive: 'background', command: 'when-selected' },
            milestones: [],
            success: { allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }] },
          })),
        },
      }
    }
    const value = definition(access.serviceId, assigned ? {} : { fixedPort: 42000 + index })
    if (assigned) value.launch.executable = { kind: 'named-command', command: 'synthetic' }
    await writeFile(
      path.join(root, `${index}.mjs`),
      `
import { createHash } from 'node:crypto'
const fixture = globalThis[${JSON.stringify(fixtureKey)}]
${
        spec.configuration && !spec.legacy
          ? `export const Config = { type: 'object', '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value }) }, toJSON: () => ({ type: 'object', dict: { root: { type: 'string' } } }) }`
          : ''
      }
export async function apply(ctx, input) {
  fixture.configurations.push({ phase: 'apply', pluginId: input.owner.pluginId, generation: input.owner.pluginGeneration, input: input.configuration, keys: Object.keys(input).sort() })
  const definition = ${JSON.stringify(value)}
  if (input.owner.pluginGeneration !== 'one' && definition.discovery.kind === 'fixed-loopback') definition.discovery.port += 100
  const registration = await ctx.managedServices.register(definition, { revision: 'sha256:${'a'.repeat(64)}' })
  fixture.observations.push('apply:${spec.pluginId}:${access.serviceId}:' + input.owner.pluginGeneration)
  if (input.owner.pluginGeneration !== 'one') await Promise.race([fixture.releaseCandidate, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))])
  ${
        spec.slow
          ? "await Promise.race([fixture.release, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))])"
          : ''
      }
  ${spec.fail ? "throw new Error('synthetic base adoption failure')" : ''}
  ${spec.legacy ? 'await registration.ensureReady()' : ''}
}
apply.inject = ['managedServices'${spec.consumesContext ? ", 'sharedContext'" : ''}]
${
        spec.providesContext
          ? `export const contextServices = [{ service: 'sharedContext', async create(input) { ${
            spec.slowContext
              ? "fixture.observations.push('context-entered'); await Promise.race([fixture.release, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))])"
              : ''
          }; return { providerValue: {}, bind() { return { value: {}, dispose() { fixture.observations.push('binding-disposed') } } }, dispose() { fixture.observations.push('root-disposed') } } } }]`
          : ''
      }
export async function prepare(ctx, input) {
  fixture.configurations.push({ phase: 'prepare', pluginId: input.owner.pluginId, generation: input.owner.pluginGeneration, input: input.configuration, keys: Object.keys(input).sort() })
  ${
        spec.slowPrepare
          ? "if (input.owner.pluginGeneration === 'one') await Promise.race([fixture.release, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))])"
          : ''
      }
  fixture.observations.push('prepare:${spec.pluginId}:${access.serviceId}:' + input.owner.pluginGeneration)
  await input.registration.ensureReady()
  const generation = 'catalog'
  const catalog = { state: 'known', generation, modelIds: ['model'], digest: 'sha256:' + createHash('sha256').update(JSON.stringify([generation,['model']])).digest('hex') }
  await input.startup.reportCatalog({ contract: 'cordisx.startup-catalog-report/v1', target: { pluginId: input.owner.pluginId, capabilityId: input.capability.id }, generation: input.generation, sequence: 1, catalog })
  const routes = [{ alias: 'model', gatewayModelId: 'gateway-model' }]
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify([generation, 'model', [['model','gateway-model']]])).digest('hex')
  await input.registration.publishNativeProvider({ providerId: input.capability.providerId, compositionOrigin: 'api', catalog: { generation, digest, defaultAlias: 'model', routes } })
}
`,
    )
  }
  function record(revision = 1): CordisXPluginActivationRecordV1 {
    return {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      profileId: 'work',
      revision,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime',
      plugins: [...new Set(specs.map(spec => spec.pluginId))].map(id => ({
        id,
        version: '1.0.0',
        enabled: true,
        digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`,
        moduleGeneration: revision === 1 ? 'one' : 'two',
        dependencies: [],
      })),
    }
  }
  function selected(record: CordisXPluginActivationRecordV1) {
    return accesses.map((access, index) => {
      const plugin = record.plugins.find(item => item.id === access.pluginIdentity.pluginId)!
      return {
        ...access,
        selectedConfiguration: specs[index]!.configuration?.[plugin.moduleGeneration === 'one' ? 'one' : 'two'],
        pluginIdentity: { ...access.pluginIdentity, generation: plugin.moduleGeneration },
        packageIdentity: { ...access.packageIdentity, integrity: plugin.digest },
        ...(access.startup
          ? { startup: { ...access.startup, pluginGeneration: plugin.moduleGeneration, sourceRevision: plugin.digest } }
          : {}),
      }
    })
  }
  const stage = vi.fn(async (_input: PluginRuntimeMutation) => {})
  const base = {
    stage,
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    publish: vi.fn(async () => ({})),
    rollback: vi.fn(async () => ({})),
  } as unknown as PluginLifecycleRuntime
  const nodes: ManagedServiceNodeActivation[] = []
  const runtimes: ManagedServiceRuntime[] = []
  const children: ReturnType<typeof syntheticChild>[] = []
  let port = 43000
  const spawns = vi.fn(() => {
    if (!assigned) throw new Error('fixture must borrow synthetic endpoint')
    const child = syntheticChild({ exitOnKill: 'SIGTERM' })
    children.push(child)
    return child.child
  })
  const lifecycle = new ManagedServicePluginLifecycleRuntime({
    runtime: base,
    profileId: 'work',
    runtimeGeneration: 'runtime',
    readStartupAdmissions: async record => [...new Map(
      selected(record).flatMap(access =>
        access.startup ? [[access.pluginIdentity.pluginId, access.startup] as const] : []
      ),
    ).values()],
    activate: async (record, options) => {
      const runtime = new ManagedServiceRuntime({
        homeDir: path.join(root, 'home'),
        findFreePort: async () => ++port,
        ...options,
        fetch: async () => new Response(null, { status: 204 }),
        spawn: spawns as never,
      })
      runtimes.push(runtime)
      const node = await new ManagedServiceNodeHost(runtime, 'work', 'runtime', options.startupAuthority).replace(
        selected(record).filter(access => options.pluginIds.includes(access.pluginIdentity.pluginId)),
        options,
      )
      nodes.push(node)
      return node
    },
  })
  return {
    lifecycle,
    record,
    nodes,
    runtimes,
    observations,
    configurations,
    release,
    releaseCandidate,
    children,
    stage,
    spawns,
    async cleanup() {
      release.resolve()
      releaseCandidate.resolve()
      await lifecycle.dispose()
      Reflect.deleteProperty(globalThis, fixtureKey)
      await rm(root, { recursive: true, force: true })
    },
  }
}
