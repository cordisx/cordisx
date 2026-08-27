import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PackageLifecycleAuthority,
  createHostPermissionReviewAuthority,
  createHostRegistryReceiptAuthority,
  type CandidateAccess,
  type HostPermissionReviewDecision,
  type PackageCandidatePlan,
  type PackageRollbackToken,
  type PackageRuntimeObservation,
} from '../packages/cli/src/launcher/packages/index.js'
import { removeStagedPluginPackage, stageLocalPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'

const temporary = new Set<string>()
afterEach(async () => {
  await Promise.all([...temporary].map(async (root) => {
    const homeDir = path.join(root, 'home')
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(digest => removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }))
  temporary.clear()
})

async function setup(
  decision?: Partial<HostPermissionReviewDecision>,
  generation: { readonly transactionEpoch?: string; readonly expectedRegistryEpoch?: number } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-authority-'))
  temporary.add(root)
  const homeDir = path.join(root, 'home')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await writeFile(path.join(source, 'src/index.ts'), 'export function apply() {}\n')
  await writeFile(path.join(source, 'cordisx.plugin.json'), `${JSON.stringify({
    $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
    schemaVersion: 1,
    id: 'candidate',
    version: '1.0.0',
    entry: './src/index.ts',
    compatibility: { runtimeAbi: 1, protocol: 1 },
    dependencies: [],
    runtimeManifest: {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id: 'candidate',
      capabilities: [],
    },
  }, null, 2)}\n`)
  const staged = await stageLocalPluginPackage(homeDir, source)
  const revoked: string[][] = []
  const permissionAuthority = createHostPermissionReviewAuthority(async input => ({
    planId: `plan:${input.transactionId}`,
    planRevision: input.permissionPlanRevision,
    decisionId: `decision:${input.transactionId}`,
    decisionFingerprint: 'a'.repeat(64),
    requiredSatisfied: true,
    unresolvedRequired: [],
    deniedRequired: [],
    oneShotGrantIds: ['once:opaque'],
    ...decision,
  }), async grantIds => { revoked.push([...grantIds]) })
  const authority = await PackageLifecycleAuthority.open({
    homeDir,
    profileId: 'default',
    runtimeGeneration: 'runtime-1',
    permissionAuthority,
  })
  const candidate: CordisXPluginActivationRecordV1 = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'candidate',
    transactionId: 'transaction-1',
    profileId: 'default',
    revision: 1,
    lastGoodRevision: 0,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'candidate',
      version: '1.0.0',
      digest: staged.digest,
      moduleGeneration: 'candidate-generation-1',
      enabled: true,
      dependencies: [],
    }],
  }
  await authority.activation.writeCandidate(candidate)
  const prepared = await authority.prepare({
    ownerId: 'generation-runtime',
    operation: 'install',
    candidateId: 'transaction-1',
    transactionEpoch: generation.transactionEpoch ?? 'transaction-epoch-1',
    expectedRegistryEpoch: generation.expectedRegistryEpoch ?? 4,
    permissionPlanRevision: 7,
    permissionPlanFingerprint: 'b'.repeat(64),
  })
  const access: CandidateAccess = {
    ownerId: 'generation-runtime',
    profileId: 'default',
    candidateToken: prepared.candidateToken,
    permissionReviewToken: prepared.permissionReviewToken,
  }
  return { root, homeDir, authority, prepared, access, revoked }
}

function runtimeObservation(tuple: PackageCandidatePlan['after'], registryEpoch: number): PackageRuntimeObservation {
  return {
    profileActivationRevision: tuple.revision,
    registryEpoch,
    runtimeGeneration: tuple.runtimeGeneration,
    plugins: Object.fromEntries(tuple.plugins.map(plugin => [plugin.id, {
      version: plugin.version,
      digest: plugin.digest,
      moduleGeneration: plugin.moduleGeneration,
      dependencies: plugin.dependencies,
    }])),
  }
}

async function ready(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { authority, prepared, access } = setupResult
  const registry = createHostRegistryReceiptAuthority()
  const plan = await authority.requestActivation(access)
  expect((await authority.resolveCandidate(access, 'publish')).candidateFingerprint)
    .toBe(prepared.candidateFingerprint)
  const receipt = registry.issueReadiness({
    transactionId: plan.transactionId,
    transactionEpoch: plan.transactionEpoch,
    candidateFingerprint: plan.candidateFingerprint,
    expectedRegistryEpoch: plan.expectedRegistryEpoch,
    afterRegistryEpoch: plan.afterRegistryEpoch,
    observation: runtimeObservation(plan.after, plan.afterRegistryEpoch),
  })
  await authority.confirmReadiness(access, receipt)
  return { registry, plan }
}

describe('Host-private package lifecycle authority', () => {
  it('binds owner/profile/full activation tuple and shared registry epoch at all four boundaries', async () => {
    const current = await setup()
    expect((await current.authority.resolveCandidate(current.access, 'plan')).after.plugins[0]).toMatchObject({
      id: 'candidate',
      version: '1.0.0',
      moduleGeneration: 'candidate-generation-1',
    })
    expect(current.prepared.candidateFingerprint).toBe(current.prepared.plan.candidateFingerprint)
    for (const boundary of ['plan', 'stage'] as const) {
      expect((await current.authority.resolveCandidate(current.access, boundary)).candidateFingerprint)
        .toBe(current.prepared.candidateFingerprint)
    }
    expect(await current.authority.resolveImpact({
      ownerId: 'generation-runtime',
      profileId: 'default',
      impactToken: current.prepared.impactToken,
    }, 'plan')).toMatchObject({ affectedPluginIds: ['candidate'] })
    await expect(current.authority.resolveCandidate({ ...current.access, ownerId: 'renderer' }, 'plan'))
      .rejects.toMatchObject({ code: 'token-scope-mismatch' })
    await expect(current.authority.resolveCandidate({
      ...current.access,
      candidateToken: 'candidate:forged' as CandidateAccess['candidateToken'],
    }, 'plan')).rejects.toMatchObject({ code: 'candidate-token-invalid' })
    expect(await current.authority.resolveRuntimeModule(current.access, 'plan', 'candidate')).toMatchObject({
      runtimeEntry: './module.js',
      packageIdentity: { pluginId: 'candidate', version: '1.0.0' },
    })
  })

  it('fails closed before stage/readiness/activation when required permission is denied and cleans one-shot grants on abort', async () => {
    const denied = await setup({ requiredSatisfied: false, deniedRequired: ['models.read'] })
    await expect(denied.authority.requestActivation(denied.access)).rejects.toMatchObject({ code: 'permission-review-required' })
    await denied.authority.abort(denied.access, 'permission-denied')
    expect(denied.revoked).toEqual([['once:opaque']])
    const journal = await readFile(path.join(denied.homeDir, 'state/profiles/default/package-authority/journal.v1.json'), 'utf8')
    expect(journal).not.toContain('models.read scope=')
    expect(journal).not.toContain('secret')
  })

  it('accepts only Host-issued readiness receipts and commits through the #73 activation store', async () => {
    const current = await setup()
    const plan = await current.authority.requestActivation(current.access)
    const fingerprint = plan.candidateFingerprint
    await expect(current.authority.confirmReadiness(current.access, {
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      candidateFingerprint: fingerprint,
      expectedRegistryEpoch: plan.expectedRegistryEpoch,
      afterRegistryEpoch: plan.afterRegistryEpoch,
      observation: runtimeObservation(plan.after, plan.afterRegistryEpoch),
      receiptFingerprint: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'stale-readiness-receipt' })
    const registry = createHostRegistryReceiptAuthority()
    await expect(current.authority.confirmReadiness(current.access, registry.issueReadiness({
      transactionId: plan.transactionId,
      transactionEpoch: String(plan.expectedRegistryEpoch),
      candidateFingerprint: fingerprint,
      expectedRegistryEpoch: plan.expectedRegistryEpoch,
      afterRegistryEpoch: plan.afterRegistryEpoch,
      observation: runtimeObservation(plan.after, plan.afterRegistryEpoch),
    }))).rejects.toMatchObject({ code: 'stale-readiness-receipt' })
    await expect(current.authority.confirmReadiness(current.access, registry.issueReadiness({
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      candidateFingerprint: fingerprint,
      expectedRegistryEpoch: plan.expectedRegistryEpoch,
      afterRegistryEpoch: plan.afterRegistryEpoch + 1,
      observation: runtimeObservation(plan.after, plan.afterRegistryEpoch + 1),
    }))).rejects.toMatchObject({ code: 'stale-readiness-receipt' })
    await current.authority.confirmReadiness(current.access, registry.issueReadiness({
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      candidateFingerprint: fingerprint,
      expectedRegistryEpoch: plan.expectedRegistryEpoch,
      afterRegistryEpoch: plan.afterRegistryEpoch,
      observation: runtimeObservation(plan.after, plan.afterRegistryEpoch),
    }))
    expect(await current.authority.commit(current.access)).toMatchObject({ revision: 1, plugins: [{ id: 'candidate' }] })
    await current.authority.completeCommit(current.access, registry.issueCommit({
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      candidateFingerprint: fingerprint,
      registryEpoch: plan.afterRegistryEpoch,
      active: runtimeObservation(plan.after, plan.afterRegistryEpoch),
      disposedAfter: runtimeObservation(plan.expected, plan.expectedRegistryEpoch),
    }))
  })

  it('pins rollback state after atomic publish until a Host-authenticated restore+cleanup receipt', async () => {
    const current = await setup()
    const { registry, plan } = await ready(current)
    await current.authority.commit(current.access)
    const rollback = await current.authority.beginRollback(current.access, 'post-publish-handshake-failed')
    expect((await current.authority.resolveCandidate(current.access, 'rollback')).candidateFingerprint)
      .toBe(current.prepared.candidateFingerprint)
    await expect(current.authority.abort(current.access, 'too-early')).rejects.toMatchObject({ code: 'rollback-required' })
    await expect(current.authority.prepare({
      ownerId: 'generation-runtime',
      operation: 'install',
      candidateId: 'transaction-1',
      transactionEpoch: 'transaction-epoch-2',
      expectedRegistryEpoch: 6,
      permissionPlanRevision: 8,
      permissionPlanFingerprint: 'c'.repeat(64),
    })).rejects.toMatchObject({ code: 'rollback-pending' })
    expect(await current.authority.collectGarbage(0)).toEqual([])

    const active = runtimeObservation(rollback.rollbackTarget, rollback.rollbackRegistryEpoch)
    const disposedAfter = runtimeObservation(rollback.expectedPublished, rollback.expectedRegistryEpoch)
    await expect(current.authority.completeRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken: rollback.rollbackToken,
    }, { ...registry.issueRollback({
      transactionId: rollback.transactionId,
      transactionEpoch: rollback.transactionEpoch,
      candidateFingerprint: rollback.candidateFingerprint,
      registryEpoch: rollback.rollbackRegistryEpoch,
      active,
      disposedAfter,
    }), receiptFingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'stale-rollback-receipt' })

    const restored = await current.authority.completeRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken: rollback.rollbackToken,
    }, registry.issueRollback({
      transactionId: rollback.transactionId,
      transactionEpoch: rollback.transactionEpoch,
      candidateFingerprint: rollback.candidateFingerprint,
      registryEpoch: rollback.rollbackRegistryEpoch,
      active,
      disposedAfter,
    }))
    expect(restored.plugins).toEqual([])
    expect(current.revoked).toEqual([['once:opaque']])
    expect(plan.afterRegistryEpoch).toBe(5)
  })

  it('accepts a monotonic Cdp rollback receipt after the published renderer closes', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    let transactionEpoch = ''
    let previous!: CordisXPluginActivationRecordV1
    let candidate!: CordisXPluginActivationRecordV1
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'transaction-1', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        if (expression.includes('publishPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'transaction-1', transactionEpoch, registryEpoch: 1, active: candidate,
        } } } }
        if (expression.includes('completePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'transaction-1', transactionEpoch, registryEpoch: 1, active: candidate, disposedAfter: previous,
        } } } }
        return {}
      },
    } as never)
    const fence = runtime.prepare('transaction-1')
    transactionEpoch = fence.transactionEpoch
    const current = await setup(undefined, { transactionEpoch, expectedRegistryEpoch: 0 })
    previous = await current.authority.activation.loadActive()
    candidate = await current.authority.activation.loadCandidate('transaction-1')
    const mutation: PluginRuntimeMutation = {
      transactionId: 'transaction-1', ...fence, afterRegistryEpoch: 1, operation: 'install', previous, candidate,
      targetId: 'candidate', affectedPluginIds: ['candidate'],
    }
    const plan = await current.authority.requestActivation(current.access)
    const readiness = await runtime.stage(mutation)
    const registry = createHostRegistryReceiptAuthority()
    await current.authority.confirmReadiness(current.access, registry.issueReadiness({
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      candidateFingerprint: plan.candidateFingerprint,
      expectedRegistryEpoch: readiness.expectedRegistryEpoch,
      afterRegistryEpoch: readiness.afterRegistryEpoch,
      observation: runtimeObservation(plan.after, readiness.afterRegistryEpoch),
    }))
    const publication = await runtime.publish('transaction-1')
    await current.authority.commit(current.access)
    expect(publication).toMatchObject({ registryEpoch: 1, active: candidate })

    const rollback = await current.authority.beginRollback(current.access, 'renderer-closed-after-publish')
    unregister()
    const restored = await runtime.rollback('transaction-1')
    expect(restored).toMatchObject({ registryEpoch: rollback.rollbackRegistryEpoch, active: previous, disposedAfter: candidate })
    const accepted = await current.authority.completeRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken: rollback.rollbackToken,
    }, registry.issueRollback({
      transactionId: rollback.transactionId,
      transactionEpoch: rollback.transactionEpoch,
      candidateFingerprint: rollback.candidateFingerprint,
      registryEpoch: restored.registryEpoch,
      active: runtimeObservation(rollback.rollbackTarget, restored.registryEpoch),
      disposedAfter: runtimeObservation(rollback.expectedPublished, rollback.expectedRegistryEpoch),
    }))
    expect(accepted.plugins).toEqual([])
  })

  it('recovers after-active interruption as rollback-published and never leaks an old review into a new candidate', async () => {
    const current = await setup()
    await current.authority.requestActivation(current.access)
    const reopened = await PackageLifecycleAuthority.open({ ...current.authority.options })
    const firstRecovery = await reopened.recover()
    expect(firstRecovery.directives).toMatchObject([{ transactionId: 'transaction-1', action: 'rollback-published' }])
    const firstToken = firstRecovery.directives[0]?.rollbackToken
    if (firstToken === undefined) throw new Error('rollback token is required')
    const secondRecovery = await reopened.recover()
    const rollbackToken = secondRecovery.directives[0]?.rollbackToken
    if (rollbackToken === undefined) throw new Error('replacement rollback token is required')
    await expect(reopened.resolveRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken: firstToken,
    })).rejects.toMatchObject({ code: 'rollback-token-invalid' })
    await expect(reopened.resolveRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken: 'rollback:forged' as PackageRollbackToken,
    })).rejects.toMatchObject({ code: 'rollback-token-invalid' })
    await expect(reopened.resolveRollback({
      ownerId: 'renderer',
      profileId: 'default',
      rollbackToken,
    })).rejects.toMatchObject({ code: 'token-scope-mismatch' })
    await expect(reopened.resolveRollback({
      ownerId: 'generation-runtime',
      profileId: 'other',
      rollbackToken,
    })).rejects.toMatchObject({ code: 'token-scope-mismatch' })
    const rollback = await reopened.resolveRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken,
    })
    expect(rollback).toMatchObject({
      transactionId: 'transaction-1',
      transactionEpoch: 'transaction-epoch-1',
      candidateFingerprint: current.prepared.candidateFingerprint,
      expectedRegistryEpoch: 5,
      rollbackRegistryEpoch: 6,
    })
    expect(rollback.expectedPublished.plugins).toHaveLength(1)
    expect(rollback.rollbackTarget.plugins).toEqual([])
    await expect(reopened.resolveCandidate(current.access, 'stage')).rejects.toMatchObject({ code: 'invalid-boundary' })
    await expect(reopened.abort(current.access, 'too-early')).rejects.toMatchObject({ code: 'rollback-required' })
    await expect(reopened.prepare({
      ownerId: 'generation-runtime',
      operation: 'install',
      candidateId: 'transaction-1',
      transactionEpoch: 'replacement-epoch',
      expectedRegistryEpoch: 6,
      permissionPlanRevision: 8,
      permissionPlanFingerprint: 'c'.repeat(64),
    })).rejects.toMatchObject({ code: 'rollback-pending' })
    expect(await reopened.collectGarbage(0)).toEqual([])

    const registry = createHostRegistryReceiptAuthority()
    await reopened.completeRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken,
    }, registry.issueRollback({
      transactionId: rollback.transactionId,
      transactionEpoch: rollback.transactionEpoch,
      candidateFingerprint: rollback.candidateFingerprint,
      registryEpoch: rollback.rollbackRegistryEpoch,
      active: runtimeObservation(rollback.rollbackTarget, rollback.rollbackRegistryEpoch),
      disposedAfter: runtimeObservation(rollback.expectedPublished, rollback.expectedRegistryEpoch),
    }))
    await expect(reopened.resolveRollback({
      ownerId: 'generation-runtime',
      profileId: 'default',
      rollbackToken,
    })).rejects.toMatchObject({ code: 'rollback-token-invalid' })
  })
})
