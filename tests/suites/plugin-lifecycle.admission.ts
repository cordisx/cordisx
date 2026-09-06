import { expect, it, vi } from 'vitest'
import { partitionPermissionReviewPlan } from '../../packages/cli/src/capability-risk-catalog.js'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
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
  localPackageV4,
  localPackageV5,
  request,
  workspace,
} from './plugin-lifecycle.fixtures.js'

export function registerAdmissionTests() {
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

  it('reviews package-v4/manifest-v5 through V4 on the same lifecycle authority and consumes Host-owned exact certification', async () => {
    const { root, home } = await workspace()
    const runtime = new FormalRuntime()
    let certified = true
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
        return certified ? exactCertification(artifact) : undefined
      },
      runtime,
    })
    const planned = await coordinator.handle(
      request({ kind: 'inspect-local', sourceDirectory: await localPackageV5(root) }),
    )
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
      authorizationMode: 'certified-implicit',
      decisionRequired: false,
      resourceClass: 'host-dom',
      certification: { integrity: expect.stringMatching(/^sha256:/) },
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
      decisions: plan!.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: 'allow-persistent' as const,
      })),
    }
    certified = false
    await expect(coordinator.applyPermissionReviewV4({
      requestId: 'v4-apply-revoked',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision,
    })).rejects.toThrow('A required plugin capability was not granted')
    certified = true
    const applied = await coordinator.applyPermissionReviewV4({
      requestId: 'v4-apply',
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision,
    })
    expect(applied).toMatchObject({ outcome: 'applied', operation: 'install', revision: 1 })
    expect(lookupArtifacts).toHaveLength(3)
    expect(lookupArtifacts).toEqual([lookupArtifacts[0], lookupArtifacts[0], lookupArtifacts[0]])
    expect(lookupArtifacts[0]).toMatchObject({
      source: expect.stringMatching(/^file:\/\/\/cordisx-store\/sha256\/[a-f0-9]{64}\/entry\.js$/),
      pluginId: 'permission-v5',
      version: '1.0.0',
      integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(runtime.calls).toEqual(['prepare', 'stage', 'publish', 'complete', 'finalize'])
    expect(runtime.lastStaged?.authorizationDecision).toEqual(decision)
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
    const nonDom = await coordinator.handle(request({
      kind: 'inspect-local',
      sourceDirectory: await localPackageV5(root, false, false),
    }))
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

    const hostDom = await coordinator.handle(request({
      kind: 'inspect-local',
      sourceDirectory: await localPackageV5(root),
    }))
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
