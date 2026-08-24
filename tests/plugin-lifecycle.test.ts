import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PluginLifecycleCoordinator,
  type PluginLifecycleRuntime,
  type PluginRuntimeMutation,
} from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
  type CordisXPluginLifecycleRequestV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
} from '../packages/cli/src/platform-contracts.js'

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
