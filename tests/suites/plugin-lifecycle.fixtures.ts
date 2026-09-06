import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect } from 'vitest'
import type { RollbackPlan } from '../../packages/cli/src/launcher/packages/authority.js'
import type { PackageActivationTuple } from '../../packages/cli/src/launcher/packages/types.js'
import {
  PluginLifecycleCoordinator,
  type PluginLifecycleRuntime,
  type PluginRuntimeMutation,
  type RuntimeCleanupObservation,
  type RuntimePublicationObservation,
  type RuntimeReadinessObservation,
} from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import { removeStagedPluginPackage } from '../../packages/cli/src/launcher/plugin-package.js'
import {
  CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V3,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V4,
  type CordisXCertifiedPermissionProjectionV1,
} from '../../packages/cli/src/permission-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
} from '../../packages/cli/src/platform-contracts.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
  type CordisXPluginLifecycleRequestV1,
} from '../../packages/cli/src/plugin-lifecycle-contracts.js'

export const temporary = new Set<string>()

export class FakeRuntime implements PluginLifecycleRuntime {
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

export class FormalRuntime implements PluginLifecycleRuntime {
  readonly calls: string[] = []
  readonly mutations = new Map<string, PluginRuntimeMutation>()
  lastStaged?: PluginRuntimeMutation
  registryEpoch = 0
  failStage = false
  failComplete = false
  failRollback = false
  failFinalizeAttempts = 0
  readonly terminalErrors: unknown[] = []
  adopted?: CordisXPluginActivationRecordV1

  terminal(error: unknown): void {
    this.terminalErrors.push(error)
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    this.adopted = active
    this.registryEpoch = registryEpoch
  }

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
    if (this.failFinalizeAttempts > 0) {
      this.failFinalizeAttempts -= 1
      throw new Error('formal finalization interrupted')
    }
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

  async recoverRollback(
    plan: import('../../packages/cli/src/launcher/packages/authority.js').RollbackPlan,
  ): Promise<RuntimeCleanupObservation> {
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

  async commit(): Promise<void> {
    throw new Error('legacy commit must not run')
  }
  async abort(transactionId: string): Promise<void> {
    this.mutations.delete(transactionId)
  }
  async reload(): Promise<void> {}
}

export function activationFromTuple(tuple: PackageActivationTuple): CordisXPluginActivationRecordV1 {
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

export class BootstrapRecoveryRuntime implements PluginLifecycleRuntime {
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

  async stage(): Promise<void> {
    throw new Error('bootstrap recovery must not stage')
  }
  async commit(): Promise<void> {
    throw new Error('bootstrap recovery must not commit a candidate')
  }
  async abort(): Promise<void> {
    throw new Error('bootstrap recovery must not abort outside rollback completion')
  }
  async reload(): Promise<void> {
    throw new Error('bootstrap recovery must not reload')
  }
}

export async function workspace(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(process.cwd(), '.plugin-lifecycle-test-'))
  temporary.add(root)
  return { root, home: path.join(root, 'home') }
}

export async function localPackage(input: {
  root: string
  id: string
  version?: string
  code?: string
  dependencies?: readonly { id: string; version: string }[]
  requiredCapability?: boolean
}): Promise<string> {
  const source = path.join(input.root, `${input.id}-${Math.random().toString(36).slice(2)}`)
  await mkdir(path.join(source, 'src'), { recursive: true })
  const capabilities = input.requiredCapability === true
    ? [{
      name: 'models.read',
      required: true,
      reason: { key: 'permission.models', fallback: 'Read models' },
      scope: {},
    }]
    : []
  await Promise.all([
    writeFile(
      path.join(source, 'cordisx.plugin.json'),
      `${
        JSON.stringify(
          {
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
          },
          null,
          2,
        )
      }\n`,
    ),
    writeFile(path.join(source, 'src/index.ts'), input.code ?? 'export function apply() {}'),
  ])
  return source
}

export async function localPackageV4(root: string): Promise<string> {
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
  await writeFile(
    path.join(source, 'cordisx-package.json'),
    `${
      JSON.stringify(
        {
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
        },
        null,
        2,
      )
    }\n`,
  )
  return source
}

export async function localPackageV5(root: string, hostDomRequired = false, includeHostDom = true): Promise<string> {
  const source = path.join(root, `permission-v5-${Math.random().toString(36).slice(2)}`)
  await mkdir(path.join(source, 'src'), { recursive: true })
  const rationale = {
    title: { key: 'host-dom-title', fallback: 'Read the Host UI' },
    description: { key: 'host-dom-description', fallback: 'Reads bounded Host UI state.' },
    feature: { key: 'host-dom-feature', fallback: 'Host UI status' },
    deniedBehavior: { key: 'host-dom-denied', fallback: 'The Host UI status stays unavailable.' },
  }
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
    schemaVersion: 5,
    id: 'permission-v5',
    name: 'Permission V5',
    capabilities: [
      { name: 'models.read', required: true, scope: { providers: ['codex'] } },
      ...(includeHostDom
        ? [{
          name: 'ui.host-dom.read',
          required: hostDomRequired,
          rationale,
          security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
          scope: { rootIds: ['app.shell'], operations: ['inspect-structure', 'read-text'] },
        }] as const
        : []),
    ],
    services: [],
  } as const
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await Promise.all([
    writeFile(path.join(source, 'runtime.json'), runtimeText),
    writeFile(path.join(source, 'src/index.ts'), 'export function apply() {}\n'),
  ])
  await writeFile(
    path.join(source, 'cordisx-package.json'),
    `${
      JSON.stringify(
        {
          $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V4,
          schemaVersion: 4,
          id: runtime.id,
          version: '1.0.0',
          entry: './src/index.ts',
          distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
          compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V5] },
          dependencies: [],
          runtimeManifest: {
            path: './runtime.json',
            schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
            digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
          },
        },
        null,
        2,
      )
    }\n`,
  )
  return source
}

export function request(
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

export function decision(
  plan: CordisXPermissionAuthorizationPlanV1,
  choice: 'allow' | 'allow-once' | 'deny' = 'allow',
): CordisXPermissionAuthorizationDecisionV1 {
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

export function exactCertification(
  artifact: Readonly<{
    source: string
    pluginId: string
    version: string
    integrity: `sha256:${string}`
  }>,
): CordisXCertifiedPermissionProjectionV1 {
  const payload = {
    ...artifact,
    reviewPolicy: { id: 'cordisx-marketplace-review' as const, version: '1.0.0' },
    reviewedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z',
    evidence: {
      kind: 'protected-marketplace-review' as const,
      reference: 'https://github.com/cordisx/marketplace/pull/63',
    },
    feed: {
      generatedAt: '2026-08-30T00:00:00.000Z',
      root: 'https://marketplace.example/feed.json',
      authority: 'cordisx.marketplace.codeowners/v1' as const,
    },
  }
  return {
    $schema: CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
    schemaVersion: 1,
    kind: 'cordisx-certified-permission-eligibility',
    status: 'active',
    ...payload,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
    revision: payload.feed.generatedAt,
  }
}

export async function install(
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

export function registerCleanup() {
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
}
