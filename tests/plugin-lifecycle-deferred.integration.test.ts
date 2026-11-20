import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  deferredLifecycleReview,
  lifecycleDeferredPermissionPlan,
} from '../packages/cli/src/launcher/plugin-lifecycle-deferred.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { stageLocalPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { bundleDeferredDecision } from '../packages/cli/src/launcher/plugin-bundle-deferred.js'
import { noDeferredPermissionDecision } from '../packages/cli/src/permission-deferral.js'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import {
  FormalRuntime,
  localPackage,
  localPackageV4,
  localPackageV5,
  registerCleanup,
  request as lifecycleRequest,
  workspace,
} from './suites/plugin-lifecycle.fixtures.js'

registerCleanup()

it('builds a complete deferred plan from a staged manifest', async () => {
  const { root, home } = await workspace()
  const runtime = new FormalRuntime()
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    permissionPolicies: [],
    runtime,
  })
  const staged = await coordinator.stagePackageSource({
    kind: 'local-directory',
    location: pathToFileURL(await localPackageV5(root)).href,
  })
  const plan = lifecycleDeferredPermissionPlan(
    staged,
    'install',
    'work',
    'runtime-1',
    'module-1',
    'candidate-1',
    [],
    [],
  )
  expect(plan).toMatchObject({
    schemaVersion: 7,
    operation: 'install',
    binding: { runtimeGeneration: 'runtime-1', moduleGeneration: 'module-1', requestId: 'candidate-1' },
  })
  expect(plan.declarations).toMatchObject([
    { capability: 'models.read', required: true, authorizationMode: 'explicit-user', decisionRequired: true },
    { capability: 'ui.host-dom.read', required: false, authorizationMode: 'deferred', decisionRequired: false },
  ])
  const planned = await coordinator.inspectStagedPackage(staged, 'inspect-1')
  expect(planned.outcome).toBe('planned')
  const request = {
    requestId: 'review-1',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 0,
    target: { kind: 'candidate' as const, candidateId: planned.candidateId! },
  }
  const candidate = await deferredLifecycleReview(coordinator, request)
  expect(candidate?.declarations).toMatchObject([
    { capability: 'models.read', required: true, decisionRequired: true },
    { capability: 'ui.host-dom.read', required: false, authorizationMode: 'deferred' },
  ])
  await expect(deferredLifecycleReview(coordinator, { ...request, expectedRevision: 1 })).rejects.toThrow()
  const required = candidate!.declarations.find(item => item.required)!
  const decision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json' as const,
    schemaVersion: 7 as const,
    origin: 'explicit-user' as const,
    planId: candidate!.planId,
    operation: candidate!.operation,
    profileId: candidate!.profileId,
    identity: candidate!.identity,
    binding: candidate!.binding,
    decisions: [{
      capability: required.capability,
      scope: required.scope,
      securityFingerprint: required.securityFingerprint,
      decision: 'allow-once' as const,
    }],
  }
  await expect(coordinator.applyPermissionReviewV7({
    ...request,
    decision: { ...decision, decisions: [{ ...decision.decisions[0]!, decision: 'deny-once' }] },
  })).rejects.toThrow()
  expect((await coordinator.store.loadActive()).revision).toBe(0)
  const applied = await coordinator.applyPermissionReviewV7({ ...request, decision })
  expect(applied.outcome).toBe('applied')
  expect(runtime.lastStaged?.authorizationDecision).toEqual(decision)
  expect((await coordinator.store.loadActive()).revision).toBe(1)
})

it('publishes an optional-only candidate with an empty Host decision', async () => {
  const { root, home } = await workspace()
  const source = await localPackageV5(root)
  const runtimePath = path.join(source, 'runtime.json')
  const runtimeManifest = JSON.parse(await readFile(runtimePath, 'utf8'))
  runtimeManifest.capabilities[0].required = false
  const contents = `${JSON.stringify(runtimeManifest, null, 2)}\n`
  await writeFile(runtimePath, contents)
  const packagePath = path.join(source, 'cordisx-package.json')
  const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'))
  packageManifest.runtimeManifest.digest = `sha256:${createHash('sha256').update(contents).digest('hex')}`
  await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)
  const runtime = new FormalRuntime()
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    permissionPolicies: [],
    runtime,
  })
  const staged = await coordinator.stagePackageSource({ kind: 'local-directory', location: pathToFileURL(source).href })
  const planned = await coordinator.inspectStagedPackage(staged, 'inspect-optional')
  const request = {
    requestId: 'optional-review',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 0,
    target: { kind: 'candidate' as const, candidateId: planned.candidateId! },
  }
  const plan = (await deferredLifecycleReview(coordinator, request))!
  expect(plan.declarations.every(item => item.authorizationMode === 'deferred')).toBe(true)
  const decision = noDeferredPermissionDecision(plan)
  expect(decision).toMatchObject({ origin: 'host-no-decision', decisions: [] })
  expect((await coordinator.applyPermissionReviewV7({ ...request, decision })).outcome).toBe('applied')
  expect(runtime.lastStaged?.authorizationDecision).toEqual(decision)
})

it('projects a manifest-v4 review without changing its required decision or v2 policy key', async () => {
  const { root, home } = await workspace()
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    permissionPolicies: [],
    runtime: new FormalRuntime(),
  })
  const staged = await coordinator.stagePackageSource({
    kind: 'local-directory',
    location: pathToFileURL(await localPackageV4(root)).href,
  })
  const planned = await coordinator.inspectStagedPackage(staged, 'inspect-v4')
  const request = {
    requestId: 'review-v4',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 0,
    target: { kind: 'candidate' as const, candidateId: planned.candidateId! },
  }
  const previous = (await coordinator.permissionReviewPlanV2(request))!
  const plan = (await deferredLifecycleReview(coordinator, request))!
  expect(plan.declarations).toMatchObject([
    { capability: 'models.read', required: true, decisionRequired: true, authorizationMode: 'explicit-user' },
    { capability: 'tasks.control', required: false, decisionRequired: false, authorizationMode: 'deferred' },
  ])
  expect(plan.declarations.map(item => item.securityFingerprint)).toEqual(
    previous.declarations.map(item => item.securityFingerprint),
  )
  const required = plan.declarations[0]!
  const decision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json' as const,
    schemaVersion: 7 as const,
    origin: 'explicit-user' as const,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: [{
      capability: required.capability,
      scope: required.scope,
      securityFingerprint: required.securityFingerprint,
      decision: 'allow-once' as const,
    }],
  }
  const store = new MemoryPermissionPolicyStore()
  const broker = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    100,
    'work',
    'runtime-1',
  )
  const identity = { source: plan.identity.source, id: plan.identity.pluginId }
  try {
    broker.register(identity, normalizePluginManifest(staged.manifest.runtimeManifest, identity.id), {
      pluginId: identity.id,
      moduleGeneration: plan.binding.moduleGeneration,
    })
    await broker.authorizeActivationV7(identity, decision, 'install')
    expect(store.readV2()).toEqual([])
    const optional = await broker.authorize(identity, 'tasks.control', {
      session: { providerId: 'codex', remoteSessionId: 'task-1' },
    })
    expect(optional.ok).toBe(false)
  } finally {
    broker.dispose()
  }
  expect((await coordinator.applyPermissionReviewV7({ ...request, decision })).outcome).toBe('applied')
  const disablePlan = await coordinator.handle(
    lifecycleRequest({ kind: 'disable', pluginId: 'permission-v4', impactToken: 'probe' }, 1),
  )
  expect(
    (await coordinator.handle(lifecycleRequest({
      kind: 'disable',
      pluginId: 'permission-v4',
      impactToken: disablePlan.impactToken!,
    }, 1))).outcome,
  ).toBe('applied')
  const enableRequest = {
    requestId: 'review-v4-enable',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 2,
    target: { kind: 'enable' as const, pluginId: 'permission-v4' },
  }
  const enablePlan = (await deferredLifecycleReview(coordinator, enableRequest))!
  expect(enablePlan.declarations[1]).toMatchObject({ authorizationMode: 'deferred', decisionRequired: false })
  const enableRequired = enablePlan.declarations[0]!
  const enableDecision = {
    ...decision,
    planId: enablePlan.planId,
    operation: enablePlan.operation,
    binding: enablePlan.binding,
    decisions: [{
      capability: enableRequired.capability,
      scope: enableRequired.scope,
      securityFingerprint: enableRequired.securityFingerprint,
      decision: 'allow-once' as const,
    }],
  }
  expect((await coordinator.applyPermissionReviewV7({ ...enableRequest, decision: enableDecision })).outcome).toBe(
    'applied',
  )
})

it('keeps legacy v1 authority in its original ledger while deferring optional use', async () => {
  const { root, home } = await workspace()
  const source = await localPackage({ root, id: 'legacy-v1', requiredCapability: true })
  const manifestPath = path.join(source, 'cordisx.plugin.json')
  const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  packageManifest.runtimeManifest.capabilities.push({
    name: 'tasks.catalog.read',
    required: false,
    reason: { key: 'optional', fallback: 'Optional task list' },
    scope: {},
  })
  await writeFile(manifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`)
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    permissionPolicies: [],
    runtime: new FormalRuntime(),
  })
  const staged = await stageLocalPluginPackage(home, source)
  const planned = await coordinator.inspectStagedPackage(staged, 'legacy-inspect')
  const request = {
    requestId: 'legacy-review',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 0,
    target: { kind: 'candidate' as const, candidateId: planned.candidateId! },
  }
  const plan = (await deferredLifecycleReview(coordinator, request))!
  expect(plan.declarations).toMatchObject([
    { capability: 'models.read', required: true, decisionRequired: true, legacyReason: { fallback: 'Read models' } },
    { capability: 'tasks.catalog.read', required: false, authorizationMode: 'deferred' },
  ])
  const required = plan.declarations[0]!
  const decision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json' as const,
    schemaVersion: 7 as const,
    origin: 'explicit-user' as const,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: [{
      capability: required.capability,
      scope: required.scope,
      securityFingerprint: required.securityFingerprint,
      decision: 'allow-once' as const,
    }],
  }
  const store = new MemoryPermissionPolicyStore()
  const prompt = vi.fn(async () => 'deny' as const)
  const broker = new PermissionBroker(store, { request: prompt }, () => new Date(), 100, 'work', 'runtime-1')
  const identity = { source: plan.identity.source, id: plan.identity.pluginId }
  try {
    broker.register(identity, normalizePluginManifest(staged.manifest.runtimeManifest, identity.id), {
      pluginId: identity.id,
      moduleGeneration: plan.binding.moduleGeneration,
    })
    await broker.authorizeActivationV7(identity, decision, 'install')
    expect(prompt).not.toHaveBeenCalled()
    expect(store.records).toEqual([])
    expect((await broker.authorize(identity, 'tasks.catalog.read', {})).ok).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(store.records).toEqual([])
  } finally {
    broker.dispose()
  }
  const bundleStore = new MemoryPermissionPolicyStore()
  const bundleBroker = new PermissionBroker(
    bundleStore,
    { request: async () => 'deny' },
    () => new Date(),
    100,
    'work',
    'runtime-1',
  )
  try {
    bundleBroker.register(identity, normalizePluginManifest(staged.manifest.runtimeManifest, identity.id), {
      pluginId: identity.id,
      moduleGeneration: plan.binding.moduleGeneration,
    })
    const chosen = bundleDeferredDecision(plan, capability => capability === 'models.read' ? 'allow' : 'deny')
    await expect(bundleBroker.authorizeActivationV7(identity, chosen.decision, 'install')).rejects.toThrow()
    await bundleBroker.authorizeActivationV7(identity, chosen.decision, 'install', undefined, chosen.selections)
    expect(bundleStore.read()).toMatchObject([
      { key: { capability: 'models.read' }, policy: 'allow' },
      { key: { capability: 'tasks.catalog.read' }, policy: 'deny' },
    ])
    expect(bundleStore.readV2()).toEqual([])
  } finally {
    bundleBroker.dispose()
  }
  expect((await coordinator.applyPermissionReviewV7({ ...request, decision })).outcome).toBe('applied')
  const disable = await coordinator.handle(
    lifecycleRequest({ kind: 'disable', pluginId: 'legacy-v1', impactToken: 'probe' }, 1),
  )
  expect(
    (await coordinator.handle(
      lifecycleRequest({ kind: 'disable', pluginId: 'legacy-v1', impactToken: disable.impactToken! }, 1),
    )).outcome,
  ).toBe('applied')
  const enableRequest = {
    requestId: 'legacy-enable',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 2,
    target: { kind: 'enable' as const, pluginId: 'legacy-v1' },
  }
  const enablePlan = (await deferredLifecycleReview(coordinator, enableRequest))!
  expect(enablePlan.declarations[1]).toMatchObject({ authorizationMode: 'deferred', decisionRequired: false })
  const requiredAgain = enablePlan.declarations[0]!
  const enableDecision = {
    ...decision,
    planId: enablePlan.planId,
    operation: enablePlan.operation,
    binding: enablePlan.binding,
    decisions: [{
      capability: requiredAgain.capability,
      scope: requiredAgain.scope,
      securityFingerprint: requiredAgain.securityFingerprint,
      decision: 'allow-once' as const,
    }],
  }
  expect((await coordinator.applyPermissionReviewV7({ ...enableRequest, decision: enableDecision })).outcome).toBe(
    'applied',
  )
  packageManifest.version = '2.0.0'
  await writeFile(manifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`)
  const updated = await stageLocalPluginPackage(home, source)
  const inspectedUpdate = await coordinator.inspectStagedPackage(updated, 'legacy-update-inspect')
  expect(inspectedUpdate.operation).toBe('update')
  const updateRequest = {
    requestId: 'legacy-update',
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 3,
    target: { kind: 'candidate' as const, candidateId: inspectedUpdate.candidateId! },
  }
  const updatePlan = (await deferredLifecycleReview(coordinator, updateRequest))!
  expect(updatePlan.declarations[1]).toMatchObject({ authorizationMode: 'deferred', decisionRequired: false })
  const updatedRequired = updatePlan.declarations[0]!
  const updateDecision = {
    ...decision,
    planId: updatePlan.planId,
    operation: updatePlan.operation,
    identity: updatePlan.identity,
    profileId: updatePlan.profileId,
    binding: updatePlan.binding,
    decisions: [{
      capability: updatedRequired.capability,
      scope: updatedRequired.scope,
      securityFingerprint: updatedRequired.securityFingerprint,
      decision: 'allow-once' as const,
    }],
  }
  expect((await coordinator.applyPermissionReviewV7({ ...updateRequest, decision: updateDecision })).outcome).toBe(
    'applied',
  )
})
