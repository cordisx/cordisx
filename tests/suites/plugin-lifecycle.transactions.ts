import { expect, it, vi } from 'vitest'
import type { PluginGenerationArtifactServer } from '../../packages/cli/src/launcher/plugin-generation-loader.js'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import {
  BootstrapRecoveryRuntime,
  decision,
  FakeRuntime,
  FormalRuntime,
  install,
  localPackage,
  request,
  workspace,
} from './plugin-lifecycle.fixtures.js'

export function registerTransactionsTests() {
  it('binds the formal authority epochs, immutable runtime module, receipts, and cleanup sequence', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const { applied } = await install(coordinator, await localPackage({ root, id: 'formal-runtime' }), 0)
    expect(applied).toMatchObject({ outcome: 'applied', revision: 1, affectedPluginIds: ['formal-runtime'] })
    expect(runtime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize'])
    expect(runtime.lastStaged?.runtimeArtifactSource).toContain('globalThis.__cordisxPendingPluginModuleFactoryV1')
    expect((await coordinator.store.loadActive()).plugins.map(plugin => plugin.id)).toEqual(['formal-runtime'])
  })

  it('retries post-commit cleanup without rolling back the durable candidate', async () => {
    const transientWorkspace = await workspace()
    const transientRuntime = new FormalRuntime()
    transientRuntime.failFinalizeAttempts = 1
    const transient = new PluginLifecycleCoordinator({
      homeDir: transientWorkspace.home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime: transientRuntime,
    })
    const transientResult = await install(
      transient,
      await localPackage({ root: transientWorkspace.root, id: 'transient-finalize' }),
      0,
    )
    expect(transientResult.applied).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(transientRuntime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize', 'finalize'])
    expect(transientRuntime.terminalErrors).toEqual([])
    expect((await transient.store.loadActive()).plugins.map(plugin => plugin.id)).toEqual(['transient-finalize'])

    const persistentWorkspace = await workspace()
    const persistentRuntime = new FormalRuntime()
    persistentRuntime.failFinalizeAttempts = 2
    const persistent = new PluginLifecycleCoordinator({
      homeDir: persistentWorkspace.home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime: persistentRuntime,
    })
    const persistentResult = await install(
      persistent,
      await localPackage({ root: persistentWorkspace.root, id: 'persistent-finalize' }),
      0,
    )
    expect(persistentResult.applied).toMatchObject({
      outcome: 'rollback-failed',
      revision: 1,
      error: {
        code: 'rollback-failed',
        message: expect.stringContaining('activation was committed'),
      },
    })
    expect(persistentRuntime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize', 'finalize'])
    expect(persistentRuntime.calls).not.toContain('rollback')
    expect(persistentRuntime.terminalErrors).toEqual([
      expect.objectContaining({ message: 'formal finalization interrupted' }),
    ])
    expect((await persistent.store.loadActive()).plugins.map(plugin => plugin.id)).toEqual(['persistent-finalize'])
  })

  it('durably enters rollback before restoring the formal last-good closure after readiness failure', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    runtime.failStage = true
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const { applied } = await install(coordinator, await localPackage({ root, id: 'formal-failure' }), 0)
    expect(applied).toMatchObject({ outcome: 'rolled-back', error: { code: 'readiness-failed' } })
    expect(runtime.calls).toEqual(['prepare', 'stage', 'rollback'])
    const restored = await coordinator.store.loadActive()
    expect(restored).toMatchObject({ revision: 0, plugins: [] })
    expect(runtime.adopted).toEqual(restored)
    expect(runtime.registryEpoch).toBe(2)
  })

  it('reopens rollback-pending state in a fresh runtime and completes the Host-branded recovery receipt', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    runtime.failComplete = true
    runtime.failRollback = true
    const first = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const failed = await install(first, await localPackage({ root, id: 'recovery-runtime' }), 0)
    expect(failed.applied).toMatchObject({ outcome: 'rollback-failed', error: { code: 'rollback-failed' } })
    expect((await first.store.loadActive()).plugins.map(plugin => plugin.id)).toEqual(['recovery-runtime'])

    const recoveredRuntime = new BootstrapRecoveryRuntime()
    const recovered = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime: recoveredRuntime,
    })
    const plans = await recovered.prepareRecovery()
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      transactionId: failed.planned.candidateId,
      rollbackRegistryEpoch: 2,
    })
    expect(await recovered.recover()).toEqual([failed.planned.candidateId])
    expect(runtime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'rollback'])
    expect(recoveredRuntime.calls).toEqual(['recoverRollback', 'adoptRecoveredActivation'])
    expect(recoveredRuntime.adopted).toMatchObject({ revision: 2, runtimeGeneration: 'runtime-1', plugins: [] })
    expect(await recovered.store.loadActive()).toMatchObject({ revision: 2, plugins: [] })
    expect(await recovered.recover()).toEqual([])
  })

  it('installs dynamically through readiness and durable commit without exposing the local source', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const source = await localPackage({ root, id: 'notes' })
    const { planned, applied } = await install(coordinator, source, 0)
    expect(JSON.stringify(planned)).not.toContain(source)
    expect(applied).toMatchObject({
      outcome: 'applied',
      operation: 'install',
      revision: 1,
      affectedPluginIds: ['notes'],
    })
    expect(runtime.staged).toHaveLength(1)
    expect(runtime.staged[0]).toMatchObject({ operation: 'install', targetId: 'notes', affectedPluginIds: ['notes'] })
    expect(runtime.committed).toEqual([planned.candidateId])
    expect(await coordinator.store.loadActive()).toMatchObject({
      revision: 1,
      plugins: [{ id: 'notes', enabled: true }],
    })
  })

  it('updates only the target dependency closure and preserves an unrelated generation', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    await install(
      coordinator,
      await localPackage({ root, id: 'base', code: 'export const revision = 1; export function apply() {}' }),
      0,
    )
    await install(
      coordinator,
      await localPackage({ root, id: 'consumer', dependencies: [{ id: 'base', version: '1.0.0' }] }),
      1,
    )
    await install(coordinator, await localPackage({ root, id: 'unrelated' }), 2)
    const before = await coordinator.store.loadActive()
    const original = new Map(before.plugins.map(item => [item.id, item.moduleGeneration]))
    const updated = await install(
      coordinator,
      await localPackage({ root, id: 'base', code: 'export const revision = 2; export function apply() {}' }),
      3,
    )
    expect(updated.applied).toMatchObject({ operation: 'update', affectedPluginIds: ['base', 'consumer'] })
    const after = await coordinator.store.loadActive()
    expect(after.plugins.find(item => item.id === 'base')?.moduleGeneration).not.toBe(original.get('base'))
    expect(after.plugins.find(item => item.id === 'consumer')?.moduleGeneration).not.toBe(original.get('consumer'))
    expect(after.plugins.find(item => item.id === 'unrelated')?.moduleGeneration).toBe(original.get('unrelated'))
  })

  it('leases browser modules for the complete enabled dependency closure in activation order', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    const leasedPluginIds: string[] = []
    const artifactServer = {
      origin: 'http://127.0.0.1:43123',
      lease: vi.fn(async (module, moduleGeneration) => {
        const pluginId = module.packageIdentity.pluginId
        leasedPluginIds.push(pluginId)
        return {
          leaseId: `${pluginId}:${moduleGeneration}`,
          pluginId,
          moduleGeneration,
          baseUrl: `http://127.0.0.1:43123/${pluginId}/${moduleGeneration}/`,
          entryUrl: `http://127.0.0.1:43123/${pluginId}/${moduleGeneration}/module.js`,
          initialStyleUrls: [],
          importSource: `Promise.resolve(globalThis.__${pluginId}Module)`,
          publishSource: `globalThis.__${pluginId}Published = true`,
          retireSource: `globalThis.__${pluginId}Retired = true`,
          retire: vi.fn(),
        }
      }),
      requestTrace: () => [],
      close: async () => undefined,
    } satisfies PluginGenerationArtifactServer
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
      pluginGenerationArtifactServer: artifactServer,
    })
    await install(coordinator, await localPackage({ root, id: 'z-base' }), 0)
    await install(
      coordinator,
      await localPackage({ root, id: 'a-consumer', dependencies: [{ id: 'z-base', version: '1.0.0' }] }),
      1,
    )
    await install(
      coordinator,
      await localPackage({
        root,
        id: 'b-disabled-consumer',
        dependencies: [{ id: 'z-base', version: '1.0.0' }],
      }),
      2,
    )
    await install(coordinator, await localPackage({ root, id: 'unrelated' }), 3)
    const disablePlan = await coordinator.handle(
      request({ kind: 'disable', pluginId: 'b-disabled-consumer', impactToken: 'probe' }, 4),
    )
    await coordinator.handle(request({
      kind: 'disable',
      pluginId: 'b-disabled-consumer',
      impactToken: disablePlan.impactToken!,
    }, 4))
    leasedPluginIds.length = 0
    artifactServer.lease.mockClear()

    const updated = await install(
      coordinator,
      await localPackage({ root, id: 'z-base', code: 'export const revision = 2; export function apply() {}' }),
      5,
    )

    expect(updated.applied).toMatchObject({
      outcome: 'applied',
      affectedPluginIds: ['z-base', 'a-consumer', 'b-disabled-consumer'],
    })
    expect(leasedPluginIds).toEqual(['z-base', 'a-consumer'])
    expect(runtime.lastStaged?.runtimeArtifactLeases?.map(lease => lease.pluginId)).toEqual([
      'z-base',
      'a-consumer',
    ])
    expect(runtime.lastStaged?.runtimeArtifactLease?.pluginId).toBe('z-base')
    expect(leasedPluginIds).not.toContain('b-disabled-consumer')
    expect(leasedPluginIds).not.toContain('unrelated')
  })

  it('keeps last-good active after permission denial or readiness failure', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const source = await localPackage({ root, id: 'protected', requiredCapability: true })
    const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }))
    const denied = await coordinator.handle(request({
      kind: 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!, 'deny'),
    }))
    expect(denied).toMatchObject({ outcome: 'rejected', error: { code: 'permission-denied' } })
    expect((await coordinator.store.loadActive()).revision).toBe(0)

    runtime.failStage = true
    const retry = await coordinator.handle(request({
      kind: 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!, 'allow-once'),
    }))
    expect(retry).toMatchObject({ outcome: 'rolled-back', error: { code: 'readiness-failed' } })
    expect((await coordinator.store.loadActive()).revision).toBe(0)
  })

  it('requires exact impact confirmation, disables/uninstalls the dependent closure, and reloads one fiber', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    await install(coordinator, await localPackage({ root, id: 'base' }), 0)
    await install(
      coordinator,
      await localPackage({ root, id: 'consumer', dependencies: [{ id: 'base', version: '1.0.0' }] }),
      1,
    )
    await install(coordinator, await localPackage({ root, id: 'unrelated' }), 2)

    const reload = await coordinator.handle(request({ kind: 'reload', pluginId: 'base' }, 3))
    expect(reload).toMatchObject({ outcome: 'applied', scope: 'plugin-restart', affectedPluginIds: ['base'] })
    expect(runtime.reloaded).toHaveLength(1)

    const disablePlan = await coordinator.handle(
      request({ kind: 'disable', pluginId: 'base', impactToken: 'probe' }, 3),
    )
    expect(disablePlan).toMatchObject({ outcome: 'planned', affectedPluginIds: ['base', 'consumer'] })
    const disabled = await coordinator.handle(request({
      kind: 'disable',
      pluginId: 'base',
      impactToken: disablePlan.impactToken!,
    }, 3))
    expect(disabled).toMatchObject({ outcome: 'applied', revision: 4, affectedPluginIds: ['base', 'consumer'] })
    expect((await coordinator.store.loadActive()).plugins.find(item => item.id === 'unrelated')?.enabled).toBe(true)

    const uninstallPlan = await coordinator.handle(
      request({ kind: 'uninstall', pluginId: 'base', impactToken: 'probe' }, 4),
    )
    const uninstalled = await coordinator.handle(request({
      kind: 'uninstall',
      pluginId: 'base',
      impactToken: uninstallPlan.impactToken!,
    }, 4))
    expect(uninstalled).toMatchObject({ outcome: 'applied', affectedPluginIds: ['base', 'consumer'] })
    expect((await coordinator.store.loadActive()).plugins.map(item => item.id)).toEqual(['unrelated'])
  })

  it('rejects stale activation/runtime generations and restores runtime after durable publication failure', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const source = await localPackage({ root, id: 'notes' })
    expect(await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }, 1))).toMatchObject({
      outcome: 'conflict',
      error: { code: 'stale-revision' },
    })
    expect(await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }, 0, 'runtime-old')))
      .toMatchObject({
        outcome: 'conflict',
        error: { code: 'stale-generation' },
      })

    const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }))
    coordinator.store.commitCandidate = async () => {
      throw new Error('fixture durable failure')
    }
    const applied = await coordinator.handle(request({
      kind: 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!),
    }))
    expect(applied).toMatchObject({ outcome: 'rolled-back', error: { code: 'activation-failed' } })
    expect(runtime.aborted).toEqual([planned.candidateId])
  })
}
