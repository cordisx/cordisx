import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { activateManagedServiceCandidate } from '../packages/cli/src/launcher/managed-service-candidate.js'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { ManagedServiceNodeHost } from '../packages/cli/src/launcher/managed-service-node-host.js'
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
import { definition, DEFINITION_SCHEMA, syntheticChild } from './managed-service-runtime-fixture.js'

function record(revision: number, generations: Record<string, string>): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    profileId: 'work',
    revision,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime',
    plugins: Object.entries(generations).map(([id, moduleGeneration]) => ({
      id,
      version: moduleGeneration,
      moduleGeneration,
      digest: `sha256:${createHash('sha256').update(moduleGeneration).digest('hex')}`,
      enabled: true,
      dependencies: [],
    })),
  }
}

function serviceAccess(root: string, pluginId: string, generation: string): ManagedBackendRuntimeServiceModuleAccess {
  return {
    packageIdentity: { pluginId, version: generation, integrity: `sha256:${'a'.repeat(64)}` },
    pluginIdentity: { source: `https://plugins.example.test/${pluginId}`, pluginId, generation },
    hostGeneration: 'runtime',
    serviceKind: 'managed-backend',
    serviceId: 'gateway',
    declaration: {
      id: 'gateway',
      kind: 'managed-backend',
      owner: 'host',
      entry: './service.mjs',
      definitionSchema: DEFINITION_SCHEMA,
      runtimeResources: [],
      consumerGrants: [],
    },
    artifactDirectory: path.join(root, pluginId),
    runtimeEntry: './service.mjs',
  }
}

async function writeService(root: string, id: string, fixedPort?: number): Promise<void> {
  await mkdir(path.join(root, id), { recursive: true })
  const value = definition('gateway', fixedPort === undefined ? {} : { fixedPort })
  value.launch = {
    executable: { kind: 'named-command', command: 'synthetic' },
    arguments: fixedPort === undefined ? [{ kind: 'host-assigned-loopback', serialization: 'port' }] : [],
    startupTimeoutMs: 150,
  }
  const generation = `${id}-catalog`
  const defaultAlias = 'one'
  const routes = [{ alias: defaultAlias, gatewayModelId: 'model-one' }]
  const digest = `sha256:${
    createHash('sha256').update(JSON.stringify([generation, defaultAlias, [['one', 'model-one']]])).digest('hex')
  }`
  await writeFile(
    path.join(root, id, 'service.mjs'),
    `
export async function apply(ctx) {
  const registration = await ctx.managedServices.register(${JSON.stringify(value)}, { revision: 'sha256:${
      'a'.repeat(64)
    }' })
  const ready = await registration.ensureReady()
  if (ready.status !== 'ready') throw new Error('candidate readiness failed')
  const published = await registration.publishNativeProvider(${
      JSON.stringify({
        providerId: id,
        compositionOrigin: 'api',
        catalog: { generation, defaultAlias, routes, digest },
      })
    })
  if (published.status !== 'accepted') throw new Error('publication failed')
}
apply.inject = ['managedServices']
`,
  )
}

function baseRuntime() {
  const stage = vi.fn(async (_mutation: PluginRuntimeMutation) => {})
  const runtime = {
    stage,
    publish: vi.fn(async () => ({})),
    complete: vi.fn(async () => ({})),
    finalize: vi.fn(async () => {}),
    rollback: vi.fn(async () => ({})),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  } as unknown as PluginLifecycleRuntime
  return { runtime, stage }
}

function mutation(
  previous: CordisXPluginActivationRecordV1,
  candidate: CordisXPluginActivationRecordV1,
  targetId: string,
): PluginRuntimeMutation {
  return {
    transactionId: `transaction-${candidate.revision}`,
    previous,
    candidate,
    targetId,
    operation: 'update',
    affectedPluginIds: [targetId],
  }
}

describe('managed-service update composition', () => {
  it('keeps independent owned children, source bindings and native sessions through finalize and rollback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-update-'))
    const children: ReturnType<typeof syntheticChild>[] = []
    const childrenByPlugin = new Map<string, ReturnType<typeof syntheticChild>[]>()
    const nodes: Awaited<ReturnType<ManagedServiceNodeHost['replace']>>[] = []
    const calls: string[][] = []
    let nextPort = 47000
    const base = baseRuntime()
    const lifecycle = new ManagedServicePluginLifecycleRuntime({
      runtime: base.runtime,
      profileId: 'work',
      runtimeGeneration: 'runtime',
      activate: async (active, options) => {
        const selected = active.plugins.filter(plugin => options.pluginIds.includes(plugin.id))
        calls.push(selected.map(plugin => plugin.id))
        const runtime = new ManagedServiceRuntime({
          homeDir: path.join(root, 'home'),
          ...options,
          findFreePort: async () => ++nextPort,
          spawn: ((_command: string, _arguments: string[], spawnOptions: { cwd: string }) => {
            const child = syntheticChild({ exitOnKill: 'SIGTERM' })
            children.push(child)
            const id = path.basename(spawnOptions.cwd)
            childrenByPlugin.set(id, [...childrenByPlugin.get(id) ?? [], child])
            return child.child
          }) as never,
          fetch: async () => new Response(null, { status: active.revision === 4 ? 503 : 204 }),
        })
        const node = await new ManagedServiceNodeHost(runtime, 'work', 'runtime').replace(
          selected.map(plugin => serviceAccess(root, plugin.id, plugin.moduleGeneration)),
          options,
        )
        nodes.push(node)
        return node
      },
    })
    try {
      await writeService(root, 'aiden')
      await writeService(root, 'traex')
      await writeService(root, 'fornax')
      const first = record(1, { aiden: 'aiden-1', traex: 'traex-1', fornax: 'fornax-1' })
      await lifecycle.initialize(first)
      const untouched = nodes[0]!.groups!.find(group => group.pluginIds.includes('fornax'))!
      const untouchedSource = untouched.sources[0]!.source
      const untouchedBinding = untouchedSource.binding
      const nativeSession = lifecycle.nativeActivation().prepareNativeConnection('fornax')
      const capabilities = lifecycle.capabilities()
      const oldChildren = ['aiden', 'traex', 'fornax'].map(id => childrenByPlugin.get(id)![0]!)
      const second = record(2, { aiden: 'aiden-2', traex: 'traex-1', fornax: 'fornax-1' })
      const change = mutation(first, second, 'aiden')
      await lifecycle.stage(change)
      expect(calls).toEqual([['aiden', 'traex', 'fornax'], ['aiden']])
      await lifecycle.publish(change.transactionId)
      await lifecycle.complete(change.transactionId)
      await lifecycle.finalize(change.transactionId)
      expect(oldChildren.map(child => child.signals)).toEqual([['SIGTERM'], [], []])
      expect(lifecycle.capabilities().filter(cap => cap.pluginId !== 'aiden')).toEqual(
        capabilities.filter(cap => cap.pluginId !== 'aiden'),
      )
      expect(untouched.sources[0]!.source).toBe(untouchedSource)
      expect(untouchedSource.binding).toBe(untouchedBinding)
      expect((await untouchedSource.snapshot()).status).toBe('available')
      expect(nativeSession.value.service.generation).toBe(untouched.authorities[0]!.serviceGeneration)
      expect(lifecycle.nativeActivation().nativeProviderIds.sort()).toEqual(['aiden', 'fornax', 'traex'])

      const third = record(3, { aiden: 'aiden-3', traex: 'traex-1', fornax: 'fornax-1' })
      const rollback = mutation(second, third, 'aiden')
      await lifecycle.stage(rollback)
      await lifecycle.publish(rollback.transactionId)
      await lifecycle.rollback(rollback.transactionId)
      expect(children[3]!.signals).toEqual([])
      expect(children[4]!.signals).toEqual(['SIGTERM'])
      expect(oldChildren.slice(1).map(child => child.signals)).toEqual([[], []])
      expect((await untouchedSource.snapshot()).status).toBe('available')
      const failed = mutation(second, record(4, { aiden: 'aiden-4', traex: 'traex-1', fornax: 'fornax-1' }), 'aiden')
      await expect(lifecycle.stage(failed)).rejects.toThrow('candidate readiness failed')
      await lifecycle.rollback(failed.transactionId)
      expect(children[5]!.signals).toEqual(['SIGTERM'])
      expect(children[3]!.signals).toEqual([])
      expect(oldChildren.slice(1).map(child => child.signals)).toEqual([[], []])
      expect(lifecycle.nativeActivation().prepareNativeConnection('aiden').value.service.generation)
        .toBe(nodes[1]!.authorities[0]!.serviceGeneration)
      expect((await untouchedSource.snapshot()).status).toBe('available')
      const disabled = {
        ...second,
        revision: 5,
        plugins: second.plugins.map(plugin => plugin.id === 'aiden' ? { ...plugin, enabled: false } : plugin),
      }
      const disable = { ...mutation(second, disabled, 'aiden'), operation: 'disable' as const }
      const beforeDisableCalls = calls.length
      await lifecycle.stage(disable)
      expect(calls).toHaveLength(beforeDisableCalls)
      await lifecycle.publish(disable.transactionId)
      await lifecycle.complete(disable.transactionId)
      await lifecycle.finalize(disable.transactionId)
      expect(children[3]!.signals).toEqual(['SIGTERM'])
      expect(lifecycle.nativeActivation().nativeProviderIds.sort()).toEqual(['fornax', 'traex'])
      expect(oldChildren.slice(1).map(child => child.signals)).toEqual([[], []])
      expect((await untouchedSource.snapshot()).status).toBe('available')
      nativeSession.dispose()
      await lifecycle.dispose()
      expect(children.map(child => child.signals)).toEqual(children.map(() => ['SIGTERM']))
    } finally {
      await lifecycle.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['host-owned', 'borrowed'] as const)(
    'rejects replacement of a %s fixed endpoint through production activation',
    async ownership => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-fixed-update-'))
      const fixedChildren: ReturnType<typeof syntheticChild>[] = []
      const servedPorts = new Set(ownership === 'borrowed' ? ['43189', '43190'] : [])
      const spawn = vi.fn((_command: string, _arguments: string[], spawnOptions: { cwd: string }) => {
        const child = syntheticChild({ exitOnKill: 'SIGTERM' })
        fixedChildren.push(child)
        servedPorts.add(path.basename(spawnOptions.cwd) === 'fornax' ? '43189' : '43190')
        return child.child
      })
      const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0]) =>
        new Response(null, { status: servedPorts.has(new URL(String(url)).port) ? 204 : 503 })
      )
      const base = baseRuntime()
      let previous: Awaited<ReturnType<ManagedServiceNodeHost['replace']>> | undefined
      const calls: string[][] = []
      const lifecycle = new ManagedServicePluginLifecycleRuntime({
        runtime: base.runtime,
        profileId: 'work',
        runtimeGeneration: 'runtime',
        activate: async (active, options) => {
          const selected = active.plugins.filter(plugin => options.pluginIds.includes(plugin.id))
          calls.push(selected.map(plugin => plugin.id))
          const accesses = selected.map(plugin => serviceAccess(root, plugin.id, plugin.moduleGeneration))
          if (previous !== undefined) {
            return await activateManagedServiceCandidate(accesses, {
              homeDir: path.join(root, 'home'),
              environment: process.env,
              profileId: 'work',
              runtimeGeneration: 'runtime',
              ...options,
            })
          }
          previous = await new ManagedServiceNodeHost(
            new ManagedServiceRuntime({ homeDir: path.join(root, 'home'), spawn: spawn as never, fetch }),
            'work',
            'runtime',
          ).replace(accesses, options)
          return previous
        },
      })
      try {
        await writeService(root, 'fornax', 43189)
        await writeService(root, 'traex', 43190)
        const first = record(1, { fornax: 'fornax-1', traex: 'traex-1' })
        await lifecycle.initialize(first)
        expect(spawn).toHaveBeenCalledTimes(ownership === 'borrowed' ? 0 : 2)
        const capabilities = lifecycle.capabilities()
        const oldSession = lifecycle.nativeActivation().prepareNativeConnection('fornax')
        const second = record(2, { fornax: 'fornax-2', traex: 'traex-1' })
        const change = mutation(first, second, 'fornax')
        await expect(lifecycle.stage(change)).rejects.toThrow(
          'update requires restart: prior generation holds the exclusive endpoint',
        )
        expect(calls).toEqual([['fornax', 'traex'], ['fornax']])
        await lifecycle.rollback(change.transactionId)
        expect(lifecycle.capabilities()).toEqual(capabilities)
        expect(lifecycle.nativeActivation().nativeProviderIds).toEqual(['fornax', 'traex'])
        expect(oldSession.value.endpoint.origin).toBe('http://127.0.0.1:43189')
        expect((await previous!.sources[0]!.source.snapshot()).status).toBe('available')
        expect(fixedChildren.map(child => child.signals)).toEqual(fixedChildren.map(() => []))
        oldSession.dispose()
      } finally {
        await lifecycle.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
