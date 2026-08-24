import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PluginLifecycleCoordinator,
  type PluginLifecycleRuntime,
  type PluginRuntimeMutation,
  type RuntimeCleanupObservation,
  type RuntimePublicationObservation,
  type RuntimeReadinessObservation,
} from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
  type CordisXPluginLifecycleRequestV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
} from '../packages/cli/src/platform-contracts.js'
import type { RollbackPlan } from '../packages/cli/src/launcher/packages/authority.js'
import type { PackageActivationTuple } from '../packages/cli/src/launcher/packages/types.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V3,
} from '../packages/cli/src/permission-contracts.js'
import { partitionPermissionReviewPlan } from '../packages/cli/src/capability-risk-catalog.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async directory => {
    const home = path.join(directory, 'home')
    const digestRoot = path.join(home, 'packages', 'sha256')
    const digests = await readdir(digestRoot).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(home, `sha256:${digest}`)))
    await chmod(directory, 0o700).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }))
  temporary.clear()
})

class FakeRuntime implements PluginLifecycleRuntime {
  readonly staged: PluginRuntimeMutation[] = []
  readonly committed: string[] = []
  readonly aborted: string[] = []
  readonly reloaded: { pluginId: string; moduleGeneration: string; runtimeGeneration: string }[] = []
  failStage = false
  failAbort = false

  async stage(mutation: PluginRuntimeMutation): Promise<void> {
    this.staged.push(mutation)
    if (this.failStage) throw new Error('fixture readiness failure')
  }

  async commit(transactionId: string): Promise<void> {
    this.committed.push(transactionId)
  }

  async abort(transactionId: string): Promise<void> {
    this.aborted.push(transactionId)
    if (this.failAbort) throw new Error('fixture rollback failure')
  }

  async reload(input: { pluginId: string; moduleGeneration: string; runtimeGeneration: string }): Promise<void> {
    this.reloaded.push(input)
  }
}

class FormalRuntime implements PluginLifecycleRuntime {
  readonly calls: string[] = []
  readonly mutations = new Map<string, PluginRuntimeMutation>()
  lastStaged?: PluginRuntimeMutation
  registryEpoch = 0
  failStage = false
  failComplete = false
  failRollback = false

  prepare(transactionId: string) {
    this.calls.push('prepare')
    return { transactionEpoch: `${transactionId}:formal`, expectedRegistryEpoch: this.registryEpoch }
  }

  async stage(mutation: PluginRuntimeMutation): Promise<RuntimeReadinessObservation> {
    this.calls.push('stage')
    this.mutations.set(mutation.transactionId, mutation)
    this.lastStaged = mutation
    if (this.failStage) throw new Error('formal readiness failed')
    return {
      transactionId: mutation.transactionId,
      transactionEpoch: mutation.transactionEpoch!,
      expectedRegistryEpoch: mutation.expectedRegistryEpoch!,
      afterRegistryEpoch: mutation.afterRegistryEpoch!,
      observation: mutation.candidate,
    }
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    this.calls.push('publish')
    const mutation = this.mutations.get(transactionId)!
    this.registryEpoch = mutation.afterRegistryEpoch!
    return {
      transactionId,
      transactionEpoch: mutation.transactionEpoch!,
      registryEpoch: this.registryEpoch,
      active: mutation.candidate,
    }
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    this.calls.push('complete')
    if (this.failComplete) throw new Error('formal cleanup interrupted')
    const mutation = this.mutations.get(transactionId)!
    return {
      transactionId,
      transactionEpoch: mutation.transactionEpoch!,
      registryEpoch: this.registryEpoch,
      active: mutation.candidate,
      disposedAfter: mutation.previous,
    }
  }

  async finalize(transactionId: string): Promise<void> {
    this.calls.push('finalize')
    this.mutations.delete(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    this.calls.push('rollback')
    if (this.failRollback) throw new Error('formal rollback interrupted')
    const mutation = this.mutations.get(transactionId)!
    this.registryEpoch = mutation.afterRegistryEpoch! + 1
    this.mutations.delete(transactionId)
    return {
      transactionId,
      transactionEpoch: mutation.transactionEpoch!,
      registryEpoch: this.registryEpoch,
      active: mutation.previous,
      disposedAfter: mutation.candidate,
    }
  }

  async recoverRollback(plan: import('../packages/cli/src/launcher/packages/authority.js').RollbackPlan): Promise<RuntimeCleanupObservation> {
    this.calls.push('recoverRollback')
    const transactionId = plan.transactionId
    const mutation = this.mutations.get(transactionId)!
    this.registryEpoch = mutation.afterRegistryEpoch! + 1
    this.mutations.delete(transactionId)
    return {
      transactionId,
      transactionEpoch: mutation.transactionEpoch!,
      registryEpoch: this.registryEpoch,
      active: mutation.previous,
      disposedAfter: mutation.candidate,
    }
  }

  async commit(): Promise<void> { throw new Error('legacy commit must not run') }
  async abort(transactionId: string): Promise<void> { this.mutations.delete(transactionId) }
  async reload(): Promise<void> {}
}

function activationFromTuple(tuple: PackageActivationTuple): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: tuple.profileId,
    revision: tuple.revision,
    lastGoodRevision: tuple.lastGoodRevision,
    runtimeGeneration: tuple.runtimeGeneration,
    plugins: tuple.plugins,
  }
}

class BootstrapRecoveryRuntime implements PluginLifecycleRuntime {
  readonly calls: string[] = []
  adopted?: CordisXPluginActivationRecordV1

  async recoverRollback(plan: RollbackPlan): Promise<RuntimeCleanupObservation> {
    this.calls.push('recoverRollback')
    return {
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      registryEpoch: plan.rollbackRegistryEpoch,
      active: activationFromTuple(plan.rollbackTarget),
      disposedAfter: activationFromTuple(plan.expectedPublished),
    }
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1): Promise<void> {
    this.calls.push('adoptRecoveredActivation')
    this.adopted = active
  }

  async stage(): Promise<void> { throw new Error('bootstrap recovery must not stage') }
  async commit(): Promise<void> { throw new Error('bootstrap recovery must not commit a candidate') }
  async abort(): Promise<void> { throw new Error('bootstrap recovery must not abort outside rollback completion') }
  async reload(): Promise<void> { throw new Error('bootstrap recovery must not reload') }
}

async function workspace(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(process.cwd(), '.plugin-lifecycle-test-'))
  temporary.add(root)
  return { root, home: path.join(root, 'home') }
}

async function localPackage(input: {
  root: string
  id: string
  version?: string
  code?: string
  dependencies?: readonly { id: string; version: string }[]
  requiredCapability?: boolean
}): Promise<string> {
  const source = path.join(input.root, `${input.id}-${Math.random().toString(36).slice(2)}`)
  await mkdir(path.join(source, 'src'), { recursive: true })
  const capabilities = input.requiredCapability === true ? [{
    name: 'models.read',
    required: true,
    reason: { key: 'permission.models', fallback: 'Read models' },
    scope: {},
  }] : []
  await Promise.all([
    writeFile(path.join(source, 'cordisx.plugin.json'), `${JSON.stringify({
      $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
      schemaVersion: 1,
      id: input.id,
      version: input.version ?? '1.0.0',
      entry: './src/index.ts',
      compatibility: { runtimeAbi: 1, protocol: 1 },
      dependencies: input.dependencies ?? [],
      runtimeManifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: input.id,
        name: input.id.toUpperCase(),
        capabilities,
      },
    }, null, 2)}\n`),
    writeFile(path.join(source, 'src/index.ts'), input.code ?? 'export function apply() {}'),
  ])
  return source
}

async function localPackageV4(root: string): Promise<string> {
  const source = path.join(root, `permission-v4-${Math.random().toString(36).slice(2)}`)
  await mkdir(path.join(source, 'src'), { recursive: true })
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: 'permission-v4',
    name: 'Permission V4',
    capabilities: [
      { name: 'models.read', required: true, scope: { providers: ['codex'] } },
      {
        name: 'tasks.control',
        required: false,
        rationale: {
          title: { key: 'control-title', fallback: 'Control selected tasks' },
          description: { key: 'control-description', fallback: 'Archives one selected task.' },
          feature: { key: 'control-feature', fallback: 'Task cleanup' },
          deniedBehavior: { key: 'control-denied', fallback: 'Task cleanup stays disabled.' },
        },
        security: { dataUse: 'ephemeral', retention: 'none', externalTransfer: false },
        scope: { sessions: [{ providerId: 'codex', remoteSessionId: 'task-1' }] },
      },
    ],
    services: [],
  } as const
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await Promise.all([
    writeFile(path.join(source, 'runtime.json'), runtimeText),
    writeFile(path.join(source, 'src/index.ts'), 'export function apply() {}\n'),
  ])
  await writeFile(path.join(source, 'cordisx-package.json'), `${JSON.stringify({
    $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: runtime.id,
    version: '1.0.0',
    entry: './src/index.ts',
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4] },
    dependencies: [],
    runtimeManifest: {
      path: './runtime.json',
      schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
    },
  }, null, 2)}\n`)
  return source
}

function request(
  operation: CordisXPluginLifecycleRequestV1['operation'],
  expectedRevision = 0,
  runtimeGeneration = 'runtime-1',
): CordisXPluginLifecycleRequestV1 {
  return {
    $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
    schemaVersion: 1,
    requestId: `request-${Math.random().toString(36).slice(2)}`,
    profileId: 'work',
    expectedRevision,
    runtimeGeneration,
    operation,
  }
}

function decision(plan: CordisXPermissionAuthorizationPlanV1, choice: 'allow' | 'allow-once' | 'deny' = 'allow'): CordisXPermissionAuthorizationDecisionV1 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
    schemaVersion: 1,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    decisions: plan.declarations.map(item => ({ capability: item.capability, scope: item.scope, decision: choice })),
  }
}

async function install(
  coordinator: PluginLifecycleCoordinator,
  sourceDirectory: string,
  expectedRevision: number,
) {
  const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory }, expectedRevision))
  expect(planned.outcome).toBe('planned')
  const operation = planned.operation as 'install' | 'update'
  const applied = await coordinator.handle(request({
    kind: operation,
    candidateId: planned.candidateId!,
    authorizationDecision: decision(planned.authorizationPlan!),
  }, expectedRevision))
  return { planned, applied }
}

describe('launcher plugin lifecycle coordinator', () => {
  it('reviews package-v3/manifest-v4 through the Host-private V2 seam and the existing lifecycle authority', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: await localPackageV4(root) }))
    expect(planned).toMatchObject({ outcome: 'planned', operation: 'install', package: { id: 'permission-v4' } })
    expect(planned.authorizationPlan).toBeUndefined()
    const plan = await coordinator.permissionReviewPlanV2({
      requestId: 'private-plan',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: planned.candidateId! },
    })
    expect(plan).toMatchObject({
      schemaVersion: 2,
      operation: 'install',
      binding: { runtimeGeneration: 'runtime-1', requestId: planned.candidateId },
    })
    const groups = partitionPermissionReviewPlan(plan!)
    expect(groups.batchEligible.map(item => item.capability)).toEqual(['models.read'])
    expect(groups.explicit.map(item => item.capability)).toEqual(['tasks.control'])
    const reviewed = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
      schemaVersion: 2 as const,
      planId: plan!.planId,
      operation: plan!.operation,
      profileId: plan!.profileId,
      identity: plan!.identity,
      binding: plan!.binding,
      decisions: plan!.declarations.map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: item.capability === 'models.read' ? 'allow-persistent' as const : 'deny-once' as const,
      })),
    }
    const applied = await coordinator.applyPermissionReviewV2({
      requestId: 'private-apply',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision: reviewed,
    })
    expect(applied).toMatchObject({ outcome: 'applied', operation: 'install', revision: 1 })
    expect(runtime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize'])
    expect(runtime.lastStaged?.authorizationDecision).toEqual(reviewed)

    const disablePlan = await coordinator.handle(request({ kind: 'disable', pluginId: 'permission-v4', impactToken: 'probe' }, 1))
    expect(disablePlan).toMatchObject({ outcome: 'planned', operation: 'disable', revision: 1 })
    expect(disablePlan.authorizationPlan).toBeUndefined()
    const disabled = await coordinator.handle(request({
      kind: 'disable', pluginId: 'permission-v4', impactToken: disablePlan.impactToken!,
    }, 1))
    expect(disabled).toMatchObject({ outcome: 'applied', operation: 'disable', revision: 2 })
    expect(runtime.lastStaged?.authorizationDecision).toMatchObject({ schemaVersion: 2, operation: 'enable' })

    const uninstallPlan = await coordinator.handle(request({ kind: 'uninstall', pluginId: 'permission-v4', impactToken: 'probe' }, 2))
    expect(uninstallPlan).toMatchObject({ outcome: 'planned', operation: 'uninstall', revision: 2 })
    expect(uninstallPlan.authorizationPlan).toBeUndefined()
    const uninstalled = await coordinator.handle(request({
      kind: 'uninstall', pluginId: 'permission-v4', impactToken: uninstallPlan.impactToken!,
    }, 2))
    expect(uninstalled).toMatchObject({ outcome: 'applied', operation: 'uninstall', revision: 3 })
    expect((await coordinator.store.loadActive()).plugins).toEqual([])
  })

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
    expect(await coordinator.store.loadActive()).toMatchObject({ revision: 0, plugins: [] })
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
    expect(applied).toMatchObject({ outcome: 'applied', operation: 'install', revision: 1, affectedPluginIds: ['notes'] })
    expect(runtime.staged).toHaveLength(1)
    expect(runtime.staged[0]).toMatchObject({ operation: 'install', targetId: 'notes', affectedPluginIds: ['notes'] })
    expect(runtime.committed).toEqual([planned.candidateId])
    expect(await coordinator.store.loadActive()).toMatchObject({ revision: 1, plugins: [{ id: 'notes', enabled: true }] })
  })

  it('updates only the target dependency closure and preserves an unrelated generation', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({ homeDir: home, profileId: 'work', runtimeGeneration: 'runtime-1', permissionPolicies: [], runtime })
    await install(coordinator, await localPackage({ root, id: 'base', code: 'export const revision = 1; export function apply() {}' }), 0)
    await install(coordinator, await localPackage({ root, id: 'consumer', dependencies: [{ id: 'base', version: '1.0.0' }] }), 1)
    await install(coordinator, await localPackage({ root, id: 'unrelated' }), 2)
    const before = await coordinator.store.loadActive()
    const original = new Map(before.plugins.map(item => [item.id, item.moduleGeneration]))
    const updated = await install(coordinator, await localPackage({ root, id: 'base', code: 'export const revision = 2; export function apply() {}' }), 3)
    expect(updated.applied).toMatchObject({ operation: 'update', affectedPluginIds: ['base', 'consumer'] })
    const after = await coordinator.store.loadActive()
    expect(after.plugins.find(item => item.id === 'base')?.moduleGeneration).not.toBe(original.get('base'))
    expect(after.plugins.find(item => item.id === 'consumer')?.moduleGeneration).not.toBe(original.get('consumer'))
    expect(after.plugins.find(item => item.id === 'unrelated')?.moduleGeneration).toBe(original.get('unrelated'))
  })

  it('keeps last-good active after permission denial or readiness failure', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({ homeDir: home, profileId: 'work', runtimeGeneration: 'runtime-1', permissionPolicies: [], runtime })
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
    const coordinator = new PluginLifecycleCoordinator({ homeDir: home, profileId: 'work', runtimeGeneration: 'runtime-1', permissionPolicies: [], runtime })
    await install(coordinator, await localPackage({ root, id: 'base' }), 0)
    await install(coordinator, await localPackage({ root, id: 'consumer', dependencies: [{ id: 'base', version: '1.0.0' }] }), 1)
    await install(coordinator, await localPackage({ root, id: 'unrelated' }), 2)

    const reload = await coordinator.handle(request({ kind: 'reload', pluginId: 'base' }, 3))
    expect(reload).toMatchObject({ outcome: 'applied', scope: 'plugin-restart', affectedPluginIds: ['base'] })
    expect(runtime.reloaded).toHaveLength(1)

    const disablePlan = await coordinator.handle(request({ kind: 'disable', pluginId: 'base', impactToken: 'probe' }, 3))
    expect(disablePlan).toMatchObject({ outcome: 'planned', affectedPluginIds: ['base', 'consumer'] })
    const disabled = await coordinator.handle(request({
      kind: 'disable', pluginId: 'base', impactToken: disablePlan.impactToken!,
    }, 3))
    expect(disabled).toMatchObject({ outcome: 'applied', revision: 4, affectedPluginIds: ['base', 'consumer'] })
    expect((await coordinator.store.loadActive()).plugins.find(item => item.id === 'unrelated')?.enabled).toBe(true)

    const uninstallPlan = await coordinator.handle(request({ kind: 'uninstall', pluginId: 'base', impactToken: 'probe' }, 4))
    const uninstalled = await coordinator.handle(request({
      kind: 'uninstall', pluginId: 'base', impactToken: uninstallPlan.impactToken!,
    }, 4))
    expect(uninstalled).toMatchObject({ outcome: 'applied', affectedPluginIds: ['base', 'consumer'] })
    expect((await coordinator.store.loadActive()).plugins.map(item => item.id)).toEqual(['unrelated'])
  })

  it('rejects stale activation/runtime generations and restores runtime after durable publication failure', async () => {
    const { root, home } = await workspace()
    const runtime = new FakeRuntime()
    const coordinator = new PluginLifecycleCoordinator({ homeDir: home, profileId: 'work', runtimeGeneration: 'runtime-1', permissionPolicies: [], runtime })
    const source = await localPackage({ root, id: 'notes' })
    expect(await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }, 1))).toMatchObject({
      outcome: 'conflict', error: { code: 'stale-revision' },
    })
    expect(await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }, 0, 'runtime-old'))).toMatchObject({
      outcome: 'conflict', error: { code: 'stale-generation' },
    })

    const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory: source }))
    coordinator.store.commitCandidate = async () => { throw new Error('fixture durable failure') }
    const applied = await coordinator.handle(request({
      kind: 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!),
    }))
    expect(applied).toMatchObject({ outcome: 'rolled-back', error: { code: 'activation-failed' } })
    expect(runtime.aborted).toEqual([planned.candidateId])
  })
})
