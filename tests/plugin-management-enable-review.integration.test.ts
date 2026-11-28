import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { openPluginManagementService } from '../packages/cli/src/management/service.js'
import type { DeferredPermissionDecision, DeferredPermissionPlan } from '../packages/cli/src/permission-deferral.js'
import {
  FormalRuntime,
  localPackageV5,
  registerCleanup,
  request,
  workspace,
} from './suites/plugin-lifecycle.fixtures.js'

registerCleanup()

function allowRequired(plan: DeferredPermissionPlan): DeferredPermissionDecision {
  return {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
    schemaVersion: 7,
    origin: 'explicit-user',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: 'allow-once',
    })),
  }
}

it('returns the actual candidate for a permission-reviewed plugin enable', async () => {
  const { root, home } = await workspace()
  await mkdir(home, { mode: 0o700 })
  const configPath = path.join(home, 'config.json')
  await ensureHomeConfig(configPath)
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'default',
    runtimeGeneration: 'runtime-1',
    permissionPolicies: [],
    runtime: new FormalRuntime(),
  })
  const staged = await coordinator.stagePackageSource({
    kind: 'local-directory',
    location: pathToFileURL(await localPackageV5(root)).href,
  })
  const inspected = await coordinator.inspectStagedPackage(staged, 'inspect-1')
  const installPlan = (await coordinator.permissionReviewPlanV7({
    requestId: 'install-review',
    profileId: 'default',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 0,
    target: { kind: 'candidate', candidateId: inspected.candidateId! },
  }))!
  expect(
    (await coordinator.applyPermissionReviewV7({
      requestId: 'install',
      profileId: 'default',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision: allowRequired(installPlan),
    })).outcome,
  ).toBe('applied')

  const probe = await coordinator.handle({
    ...request({ kind: 'disable', pluginId: staged.manifest.id, impactToken: 'probe' }, 1),
    profileId: 'default',
  })
  expect(
    (await coordinator.handle({
      ...request({ kind: 'disable', pluginId: staged.manifest.id, impactToken: probe.impactToken! }, 1),
      profileId: 'default',
    })).outcome,
  ).toBe('applied')

  const service = await openPluginManagementService({
    homeDir: home,
    configPath,
    profileId: 'default',
    watch: false,
    lifecycle: { coordinator, runtimeGeneration: 'runtime-1', mode: 'service' },
  })
  try {
    const planned = await service.plan({ kind: 'plugin-enable', pluginId: staged.manifest.id })
    expect(planned.status).toBe('planned')
    const result = await service.execute(planned.executionRequest!)
    if (result.status !== 'permission-review-required' || result.permissionPlan.schemaVersion !== 7) {
      throw new Error(`expected a deferred permission review, got ${result.status}`)
    }
    expect(result.candidateId).toBe(result.permissionPlan.binding.requestId)
    const candidate = await coordinator.store.loadCandidate(result.candidateId)
    expect(candidate.plugins.find(item => item.id === staged.manifest.id)?.enabled).toBe(true)
    expect(
      (await coordinator.applyPermissionReviewV7({
        requestId: 'enable',
        profileId: 'default',
        runtimeGeneration: 'runtime-1',
        expectedRevision: result.snapshot.activationRevision,
        decision: allowRequired(result.permissionPlan),
      })).outcome,
    ).toBe('applied')
    expect((await coordinator.store.loadActive()).plugins.find(item => item.id === staged.manifest.id)?.enabled)
      .toBe(true)
  } finally {
    service.close()
  }
})
