import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { c as createTar } from 'tar'
import { expect, it, vi } from 'vitest'
import { partitionPermissionReviewPlan } from '../../packages/cli/src/capability-risk-catalog.js'
import {
  PluginLifecycleCoordinator,
  type PluginRuntimeMutation,
} from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import { isPermissionReviewV4ManifestVersion } from '../../packages/cli/src/launcher/plugin-lifecycle-model.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PERMISSION_POLICY_SCHEMA_V4,
} from '../../packages/cli/src/permission-contracts.js'
import {
  decision,
  exactCertification,
  FormalRuntime,
  install,
  localPackage,
  localPackageV14,
  localPackageV4,
  localPackageV5,
  request,
  workspace,
} from './plugin-lifecycle.fixtures.js'

const execFileAsync = promisify(execFile)

async function stageVerifiedArchive(
  coordinator: PluginLifecycleCoordinator,
  sourceDirectory: string,
  archive: string,
) {
  await createTar({ cwd: sourceDirectory, file: archive, gzip: true }, ['.'])
  const integrity = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}` as const
  return await coordinator.stagePackageSource({
    kind: 'downloaded-tarball',
    location: pathToFileURL(archive).href,
    downloadedFrom: 'https://registry.example/' + path.basename(archive),
    distributionIntegrity: integrity,
  })
}

export function registerAdmissionTests() {
  it('routes normalized manifest-v5 through manifest-v14 to V4 permission review', () => {
    expect([5, 6, 7, 8, 9, 10, 11, 12, 13, 14].every(isPermissionReviewV4ManifestVersion)).toBe(true)
    expect([1, 4, 15].some(isPermissionReviewV4ManifestVersion)).toBe(false)
  })

  it('rejects first browser graph admission before authority prepare and preserves durable last-good', async () => {
    const { root, home } = await workspace()
    class AdmissionRejectingRuntime extends FormalRuntime {
      async prepareBrowserGraph(): Promise<never> {
        this.calls.push('prepareBrowserGraph')
        throw new Error('fixture browser graph admission failed')
      }
    }
    const runtime = new AdmissionRejectingRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const sourceDirectory = await localPackage({ root, id: 'admission-fixture' })
    const planned = await coordinator.handle(request({ kind: 'inspect-local', sourceDirectory }))
    expect(planned).toMatchObject({ outcome: 'planned', operation: 'install' })
    const before = await coordinator.store.loadActive()
    const applied = await coordinator.handle(request({
      kind: 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!),
    }))
    expect(applied).toMatchObject({
      outcome: 'rejected',
      revision: 0,
      error: { code: 'readiness-failed' },
    })
    expect(runtime.calls).toEqual(['prepareBrowserGraph'])
    expect(await coordinator.store.loadActive()).toEqual(before)
    await expect(coordinator.store.loadCandidate(planned.candidateId!)).rejects.toThrow()
    await expect(coordinator.prepareRecovery()).resolves.toEqual([])
  })

  it('routes browser graph update and enable through pre-authority admission', async () => {
    for (const operation of ['update', 'enable'] as const) {
      const { root, home } = await workspace()
      class AdmissionRuntime extends FormalRuntime {
        rejectAdmission = false
        async prepareBrowserGraph(transactionId: string) {
          this.calls.push('prepareBrowserGraph')
          if (this.rejectAdmission) throw new Error('fixture browser graph admission failed')
          return super.prepare(transactionId)
        }
      }
      const runtime = new AdmissionRuntime()
      const coordinator = new PluginLifecycleCoordinator({
        homeDir: home,
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
        permissionPolicies: [],
        runtime,
      })
      const first = await install(
        coordinator,
        await localPackage({ root, id: `admission-${operation}`, version: '1.0.0' }),
        0,
      )
      expect(first.applied.outcome).toBe('applied')
      let expectedRevision = 1
      if (operation === 'enable') {
        const disablePlan = await coordinator.handle(
          request({ kind: 'disable', pluginId: `admission-${operation}`, impactToken: 'probe' }, expectedRevision),
        )
        const disabled = await coordinator.handle(request({
          kind: 'disable',
          pluginId: `admission-${operation}`,
          impactToken: disablePlan.impactToken!,
        }, expectedRevision))
        expect(disabled.outcome).toBe('applied')
        expectedRevision = 2
      }
      runtime.calls.length = 0
      const before = await coordinator.store.loadActive()
      const planned = operation === 'update'
        ? await coordinator.handle(request({
          kind: 'inspect-local',
          sourceDirectory: await localPackage({ root, id: 'admission-update', version: '2.0.0' }),
        }, expectedRevision))
        : await coordinator.handle(request({ kind: 'enable', pluginId: 'admission-enable' }, expectedRevision))
      expect(planned).toMatchObject({ outcome: 'planned', operation })
      runtime.rejectAdmission = true
      const applied = await coordinator.handle(request(
        operation === 'update'
          ? {
            kind: 'update',
            candidateId: planned.candidateId!,
            authorizationDecision: decision(planned.authorizationPlan!),
          }
          : {
            kind: 'enable',
            pluginId: 'admission-enable',
            authorizationDecision: decision(planned.authorizationPlan!),
          },
        expectedRevision,
      ))
      expect(applied).toMatchObject({
        outcome: 'rejected',
        revision: expectedRevision,
        error: { code: 'readiness-failed' },
      })
      expect(runtime.calls).toEqual(['prepareBrowserGraph'])
      expect(await coordinator.store.loadActive()).toEqual(before)
      await expect(coordinator.prepareRecovery()).resolves.toEqual([])
    }
  })

  it('reviews package-v4/manifest-v5 through V4 without extending Certified beyond the Host allowlist', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    const lookupArtifacts: Array<
      Readonly<{
        source: string
        pluginId: string
        version: string
        integrity: `sha256:${string}`
      }>
    > = []
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      certifiedPermissionForArtifact: async artifact => {
        lookupArtifacts.push(artifact)
        return exactCertification(artifact)
      },
      runtime,
    })
    const source = await localPackageV5(root)
    const packagePath = path.join(source, 'cordisx-package.json')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>
    packageManifest.canonicalSource = 'https://github.com/example/permission-v5-certified'
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)
    const staged = await stageVerifiedArchive(
      coordinator,
      source,
      path.join(root, 'permission-v5-certified.tgz'),
    )
    const planned = await coordinator.inspectStagedPackage(staged, 'permission-v5-certified')
    expect(planned).toMatchObject({ outcome: 'planned', operation: 'install', package: { id: 'permission-v5' } })
    expect(planned.authorizationPlan).toBeUndefined()
    expect(
      await coordinator.permissionReviewPlanV2({
        requestId: 'v2-probe',
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
        expectedRevision: 0,
        target: { kind: 'candidate', candidateId: planned.candidateId! },
      }),
    ).toBeUndefined()
    const plan = await coordinator.permissionReviewPlanV4({
      requestId: 'v4-plan',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: planned.candidateId! },
    })
    expect(plan).toMatchObject({ schemaVersion: 4, operation: 'install' })
    expect(plan?.declarations.find(item => item.capability === 'models.read')).toMatchObject({
      authorizationMode: 'explicit-user',
      decisionRequired: true,
      resourceClass: 'non-dom',
    })
    expect(plan?.declarations.find(item => item.capability === 'ui.host-dom.read')).toMatchObject({
      authorizationMode: 'explicit-user',
      decisionRequired: true,
      resourceClass: 'host-dom',
    })
    expect(plan?.declarations.find(item => item.capability === 'ui.host-dom.read')).not.toHaveProperty('certification')
    const decision = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
      schemaVersion: 4 as const,
      origin: 'explicit-user' as const,
      planId: plan!.planId,
      operation: plan!.operation,
      profileId: plan!.profileId,
      identity: plan!.identity,
      binding: plan!.binding,
      decisions: plan!.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: 'allow-persistent' as const,
      })),
    }
    const applied = await coordinator.applyPermissionReviewV4({
      requestId: 'v4-apply',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision,
    })
    expect(applied).toMatchObject({ outcome: 'applied', operation: 'install', revision: 1 })
    expect(lookupArtifacts).toHaveLength(2)
    expect(lookupArtifacts).toEqual([lookupArtifacts[0], lookupArtifacts[0]])
    expect(lookupArtifacts[0]).toMatchObject({
      source: 'https://github.com/example/permission-v5-certified',
      pluginId: 'permission-v5',
      version: '1.0.0',
      integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(runtime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize'])
    expect(runtime.lastStaged?.authorizationDecision).toEqual(decision)
  })

  it('binds lifecycle certification to the exact downloaded artifact rather than its normalized store digest', async () => {
    const { root, home } = await workspace()
    const source = await localPackageV5(root)
    const canonicalSource = 'https://github.com/example/certified-permission-v5'
    const packagePath = path.join(source, 'cordisx-package.json')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>
    packageManifest.canonicalSource = canonicalSource
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)
    const archive = path.join(root, 'permission-v5.tgz')
    await createTar({ cwd: source, file: archive, gzip: true }, ['.'])
    const artifactIntegrity = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}` as const
    const lookup = vi.fn(async artifact => exactCertification(artifact))
    class CertificationProbeCoordinator extends PluginLifecycleCoordinator {
      certificationFor(staged: Parameters<PluginLifecycleCoordinator['inspectStagedPackage']>[0]) {
        return this.certifiedPermission(staged)
      }
    }
    const coordinator = new CertificationProbeCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      certifiedPermissionForArtifact: lookup,
      runtime: new FormalRuntime(),
    })
    const staged = await coordinator.stagePackageSource({
      kind: 'downloaded-tarball',
      location: pathToFileURL(archive).href,
      downloadedFrom: 'https://registry.example/permission-v5.tgz',
      distributionIntegrity: artifactIntegrity,
    })
    expect(staged.digest).not.toBe(artifactIntegrity)
    const certification = await coordinator.certificationFor(staged)
    expect(lookup).toHaveBeenCalledWith({
      source: canonicalSource,
      pluginId: 'permission-v5',
      version: '1.0.0',
      integrity: artifactIntegrity,
    })
    expect(certification).toMatchObject({
      source: canonicalSource,
      pluginId: 'permission-v5',
      version: '1.0.0',
      integrity: artifactIntegrity,
    })

    lookup.mockClear()
    const sourceBuilt = await coordinator.stagePackageSource({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    })
    expect(sourceBuilt).not.toHaveProperty('artifactIntegrity')
    await expect(coordinator.certificationFor(sourceBuilt)).resolves.toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()

    const mismatched = new CertificationProbeCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      certifiedPermissionForArtifact: async artifact =>
        exactCertification({
          ...artifact,
          integrity: `sha256:${'0'.repeat(64)}`,
        }),
      runtime: new FormalRuntime(),
    })
    await expect(mismatched.certificationFor(staged)).resolves.toBeUndefined()

    const wrongVersion = new CertificationProbeCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      certifiedPermissionForArtifact: async artifact =>
        exactCertification({
          ...artifact,
          version: '2.0.0',
        }),
      runtime: new FormalRuntime(),
    })
    await expect(wrongVersion.certificationFor(staged)).resolves.toBeUndefined()
  })

  it('reviews and applies a manifest-v14 managed backend through an exact V4 candidate binding', async () => {
    const { root, home } = await workspace()
    class LaunchCheckingRuntime extends FormalRuntime {
      readonly launched: PluginRuntimeMutation['operation'][] = []

      override async stage(mutation: PluginRuntimeMutation) {
        const observation = await super.stage(mutation)
        if (mutation.package?.manifest.runtimeManifest.schemaVersion === 14) {
          const executable = path.join(
            home,
            'packages',
            'sha256',
            mutation.package.digest.slice('sha256:'.length),
            'managed-service.mjs',
          )
          if (process.platform === 'win32') await execFileAsync(process.execPath, [executable])
          else await execFileAsync(executable)
          this.launched.push(mutation.operation)
        }
        return observation
      }
    }
    const runtime = new LaunchCheckingRuntime()
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime,
    })
    const review = async (version: string, expectedRevision: number) => {
      const planned = await coordinator.handle(request({
        kind: 'inspect-local',
        sourceDirectory: await localPackageV14(root, version),
      }, expectedRevision))
      expect(planned).toMatchObject({
        outcome: 'planned',
        operation: expectedRevision === 0 ? 'install' : 'update',
        package: { id: 'permission-v14', version },
      })
      expect(planned.authorizationPlan).toBeUndefined()
      const candidate = await coordinator.store.loadCandidate(planned.candidateId!)
      const target = candidate.plugins.find(plugin => plugin.id === 'permission-v14')!
      const plan = await coordinator.permissionReviewPlanV4({
        requestId: `v14-plan-${version}`,
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
        expectedRevision,
        target: { kind: 'candidate', candidateId: planned.candidateId! },
      })
      expect(plan).toMatchObject({
        schemaVersion: 4,
        operation: expectedRevision === 0 ? 'install' : 'update',
        identity: { pluginId: 'permission-v14' },
        binding: {
          runtimeGeneration: 'runtime-1',
          moduleGeneration: target.moduleGeneration,
          requestId: planned.candidateId,
        },
        declarations: [],
      })
      const decision = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
        schemaVersion: 4 as const,
        origin: 'explicit-user' as const,
        planId: plan!.planId,
        operation: plan!.operation,
        profileId: plan!.profileId,
        identity: plan!.identity,
        binding: plan!.binding,
        decisions: [],
      }
      return { planned, target, decision }
    }

    const installed = await review('1.0.0', 0)
    expect(
      await coordinator.applyPermissionReviewV4({
        requestId: 'v14-install',
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
        expectedRevision: 0,
        decision: installed.decision,
      }),
    ).toMatchObject({ outcome: 'applied', operation: 'install', revision: 1 })

    const updated = await review('2.0.0', 1)
    await expect(coordinator.applyPermissionReviewV4({
      requestId: 'v14-forged',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 1,
      decision: {
        ...updated.decision,
        binding: { ...updated.decision.binding, moduleGeneration: 'forged-generation' },
      },
    })).rejects.toThrow()
    await expect(coordinator.applyPermissionReviewV4({
      requestId: 'v14-stale',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision: updated.decision,
    })).rejects.toMatchObject({ code: 'stale-revision' })
    expect(
      await coordinator.applyPermissionReviewV4({
        requestId: 'v14-update',
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
        expectedRevision: 1,
        decision: updated.decision,
      }),
    ).toMatchObject({ outcome: 'applied', operation: 'update', revision: 2 })
    expect(await coordinator.store.loadActive()).toMatchObject({
      revision: 2,
      plugins: [{
        id: 'permission-v14',
        version: '2.0.0',
        digest: updated.target.digest,
        enabled: true,
      }],
    })
    expect(runtime.lastStaged?.authorizationDecision).toEqual(updated.decision)
    expect(runtime.launched).toEqual(['install', 'update'])
  })

  it('persists a safe managed-service readiness diagnostic instead of only a generic rollback code', async () => {
    const { root, home } = await workspace()
    class MissingManagedServiceRuntime extends FormalRuntime {
      override async stage(mutation: PluginRuntimeMutation) {
        await super.stage(mutation)
        throw new Error('plugin dependencies are unavailable: managedServices')
      }
    }
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      runtime: new MissingManagedServiceRuntime(),
    })
    const planned = await coordinator.handle(request({
      kind: 'inspect-local',
      sourceDirectory: await localPackage({ root, id: 'missing-managed-service' }),
    }))
    const applied = await coordinator.handle(request({
      kind: 'install',
      candidateId: planned.candidateId!,
      authorizationDecision: decision(planned.authorizationPlan!),
    }))
    expect(applied).toMatchObject({
      outcome: 'rolled-back',
      error: {
        code: 'readiness-failed',
        message: 'The candidate managed-service generation was unavailable during renderer readiness.',
      },
    })
    const journal = JSON.parse(
      await readFile(
        path.join(home, 'state', 'profiles', 'work', 'package-authority', 'journal.v1.json'),
        'utf8',
      ),
    ) as { transactions: Record<string, { failureCode?: string }> }
    expect(Object.values(journal.transactions)).toContainEqual(expect.objectContaining({
      failureCode: 'managed-service-dependency-unavailable',
    }))
  })

  it('queries certification only for catalog DOM capabilities and falls back to explicit review on lookup failure', async () => {
    const { root, home } = await workspace()
    const lookup = vi.fn(async () => {
      throw new Error('trust source offline')
    })
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      certifiedPermissionForArtifact: lookup,
      runtime: new FormalRuntime(),
    })
    const nonDom = await coordinator.inspectStagedPackage(
      await stageVerifiedArchive(
        coordinator,
        await localPackageV5(root, false, false),
        path.join(root, 'permission-v5-non-dom.tgz'),
      ),
      'permission-v5-non-dom',
    )
    const nonDomPlan = await coordinator.permissionReviewPlanV4({
      requestId: 'non-dom-v4-plan',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: nonDom.candidateId! },
    })
    expect(nonDomPlan?.declarations).toHaveLength(1)
    expect(nonDomPlan?.declarations[0]).toMatchObject({
      capability: 'models.read',
      authorizationMode: 'explicit-user',
      decisionRequired: true,
    })
    expect(lookup).not.toHaveBeenCalled()

    const hostDom = await coordinator.inspectStagedPackage(
      await stageVerifiedArchive(
        coordinator,
        await localPackageV5(root),
        path.join(root, 'permission-v5-host-dom.tgz'),
      ),
      'permission-v5-host-dom',
    )
    const hostDomPlan = await coordinator.permissionReviewPlanV4({
      requestId: 'host-dom-v4-plan',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: hostDom.candidateId! },
    })
    expect(hostDomPlan?.declarations.find(item => item.capability === 'ui.host-dom.read')).toMatchObject({
      authorizationMode: 'explicit-user',
      decisionRequired: true,
    })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('refuses lifecycle activation when an exact persistent policy denies required Host DOM access', async () => {
    const { root, home } = await workspace()
    const policies: Array<import('../../packages/cli/src/permission-contracts.js').CordisXPermissionPolicyRecordV4> = []
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: home,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      permissionPolicies: [],
      loadPermissionPolicies: async () => policies,
      runtime: new FormalRuntime(),
    })
    const staged = await coordinator.handle(request({
      kind: 'inspect-local',
      sourceDirectory: await localPackageV5(root, true),
    }))
    const first = await coordinator.permissionReviewPlanV4({
      requestId: 'required-v4-first',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: staged.candidateId! },
    })
    const hostDom = first!.declarations.find(item => item.capability === 'ui.host-dom.read')!
    policies.push({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key: {
        profileId: first!.profileId,
        identity: first!.identity,
        capability: hostDom.capability,
        scope: hostDom.scope,
        securityFingerprint: hostDom.securityFingerprint,
      },
      policy: 'deny-persistent',
    })
    const deniedPlan = await coordinator.permissionReviewPlanV4({
      requestId: 'required-v4-denied',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: staged.candidateId! },
    })
    expect(deniedPlan?.declarations.find(item => item.capability === 'ui.host-dom.read')).toMatchObject({
      required: true,
      policy: 'deny-persistent',
      authorizationMode: 'persistent-policy',
      decisionRequired: false,
    })
    const decision = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
      schemaVersion: 4 as const,
      origin: 'explicit-user' as const,
      planId: deniedPlan!.planId,
      operation: deniedPlan!.operation,
      profileId: deniedPlan!.profileId,
      identity: deniedPlan!.identity,
      binding: deniedPlan!.binding,
      decisions: deniedPlan!.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: 'allow-once' as const,
      })),
    }
    await expect(coordinator.applyPermissionReviewV4({
      requestId: 'required-v4-apply',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision,
    })).rejects.toThrow('A required plugin capability was not granted')
  })

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
    const planned = await coordinator.handle(
      request({ kind: 'inspect-local', sourceDirectory: await localPackageV4(root) }),
    )
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

    const disablePlan = await coordinator.handle(
      request({ kind: 'disable', pluginId: 'permission-v4', impactToken: 'probe' }, 1),
    )
    expect(disablePlan).toMatchObject({ outcome: 'planned', operation: 'disable', revision: 1 })
    expect(disablePlan.authorizationPlan).toBeUndefined()
    const disabled = await coordinator.handle(request({
      kind: 'disable',
      pluginId: 'permission-v4',
      impactToken: disablePlan.impactToken!,
    }, 1))
    expect(disabled).toMatchObject({ outcome: 'applied', operation: 'disable', revision: 2 })
    expect(runtime.lastStaged?.authorizationDecision).toMatchObject({ schemaVersion: 2, operation: 'enable' })

    const uninstallPlan = await coordinator.handle(
      request({ kind: 'uninstall', pluginId: 'permission-v4', impactToken: 'probe' }, 2),
    )
    expect(uninstallPlan).toMatchObject({ outcome: 'planned', operation: 'uninstall', revision: 2 })
    expect(uninstallPlan.authorizationPlan).toBeUndefined()
    const uninstalled = await coordinator.handle(request({
      kind: 'uninstall',
      pluginId: 'permission-v4',
      impactToken: uninstallPlan.impactToken!,
    }, 2))
    expect(uninstalled).toMatchObject({ outcome: 'applied', operation: 'uninstall', revision: 3 })
    expect((await coordinator.store.loadActive()).plugins).toEqual([])
  })
}
