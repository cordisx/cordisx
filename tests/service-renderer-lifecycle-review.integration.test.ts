import { mkdir } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import {
  createServiceRendererManagementPlans,
  ServiceRendererManagementPlans,
} from '../packages/cli/src/cli/service-renderer-management-plans.js'
import { projectManagementRequest } from '../packages/cli/src/cli/service-renderer-management-projection.js'
import { createServiceRendererLifecycleReview } from '../packages/cli/src/cli/service-renderer-lifecycle-review.js'
import { ServiceRendererRuntimeGrants } from '../packages/cli/src/cli/service-renderer-runtime-grants.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { openPluginManagementService } from '../packages/cli/src/management/service.js'
import type { DeferredPermissionDecision } from '../packages/cli/src/permission-deferral.js'
import {
  FormalRuntime,
  localPackageV5,
  registerCleanup,
  request,
  workspace,
} from './suites/plugin-lifecycle.fixtures.js'

registerCleanup()

it('uses a signed Web review to activate the exact candidate and records its originating client', async () => {
  const { root, home } = await workspace()
  await mkdir(home, { mode: 0o700 })
  const runtime = new FormalRuntime()
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: 'owner-1',
    permissionPolicies: [],
    runtime,
  })
  const staged = await coordinator.stagePackageSource({
    kind: 'local-directory',
    location: pathToFileURL(await localPackageV5(root)).href,
  })
  const inspected = await coordinator.inspectStagedPackage(staged, 'inspect-1')
  const ownerPlan = (await coordinator.permissionReviewPlanV7({
    requestId: 'review-1',
    profileId: 'work',
    runtimeGeneration: 'owner-1',
    expectedRevision: 0,
    target: { kind: 'candidate', candidateId: inspected.candidateId! },
  }))!
  const plans = new ServiceRendererManagementPlans(() => {}, true, async () => true)
  const intent = {
    kind: 'plugin-plan-marketplace' as const,
    pluginId: staged.manifest.id,
    sourceUrl: 'https://example.test/marketplace.json',
    version: staged.manifest.version,
    expectedCanonicalSource: staged.identitySource,
    expectedArtifactIntegrity: `sha256:${'a'.repeat(64)}`,
  }
  const protectedPlans = createServiceRendererManagementPlans({
    homeDir: home,
    profileId: 'work',
    generation: 'owner-1',
    protectProfileInputs: true,
    restrictedManagement: { discardPlan: () => {} },
    permissionProof: { authorizeLifecycle: () => true },
  }).managementPlans!
  expect(await protectedPlans.issueReview({ intent, managementRevision: 1, activationRevision: 0, ownerPlan }))
    .toBeUndefined()
  protectedPlans.close()
  const issued = (await plans.issueReview({ intent, managementRevision: 1, activationRevision: 0, ownerPlan }))!
  const item = issued.plan.declarations.find(declaration => declaration.decisionRequired)!
  const decision: DeferredPermissionDecision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
    schemaVersion: 7,
    origin: 'explicit-user',
    planId: issued.plan.planId,
    operation: issued.plan.operation,
    profileId: issued.plan.profileId,
    identity: issued.plan.identity,
    binding: issued.plan.binding,
    decisions: [{
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: 'allow-once',
    }],
  }
  const controller = new AbortController()
  const context = {
    rendererId: 'a'.repeat(64),
    profileId: 'work',
    ownerGeneration: 'owner-1',
    signal: controller.signal,
  }
  const signer = await createStandalonePermissionSigner({
    rendererId: context.rendererId,
    profileId: 'work',
    generation: 'owner-1',
  }, {
    crypto: webcrypto as unknown as Crypto,
  })
  const authority = new ManagerPermissionProofAuthority({
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: () => true,
  })
  authority.register(context, signer.publicKey)
  const before = { active: await coordinator.store.loadActive(), registryEpoch: 0 }
  const entry = {
    confirmed: true,
    current: () => true,
    unchanged: async () => true,
    snapshot: before,
    restricted: { plans, writableIds: new Set<string>() },
  }
  const bootstrap = {
    managementEntry: () => entry,
    managementRequest: async (_context: unknown, _operation: unknown, dispatch: () => Promise<unknown>) =>
      await dispatch(),
    permissionAccess: { runtimeOnceGrants: new ServiceRendererRuntimeGrants() },
  }
  const service = {
    query: async () => ({ revision: 1, activationRevision: (await coordinator.store.loadActive()).revision }),
  }
  const journal = new PermissionDecisionJournal({ homeDir: home, profileId: 'work' })
  const review = createServiceRendererLifecycleReview({
    homeDir: home,
    profileId: 'work',
    generation: 'owner-1',
    coordinator,
    journal,
    proof: authority,
    bootstrap: bootstrap as never,
    service: service as never,
  })
  const proof = await signer.signLifecycle('apply-web', issued.token, issued.plan, decision)
  const operation = { kind: 'plugin-review-apply' as const, reviewToken: issued.token, decision, proof }
  try {
    const wrong = await review({ ...operation, decision: { ...decision, planId: 'forged' } }, 'apply-web', {
      ...context,
      admitted: true,
    })
    expect(wrong).toMatchObject({ value: { status: 'rejected' } })
    expect((await coordinator.store.loadActive()).revision).toBe(0)
    const result = await review(operation, 'apply-web', { ...context, admitted: true })
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'applied', request: intent, snapshot: { activationRevision: 1 } },
    })
    expect(runtime.lastStaged?.authorizationDecision).toMatchObject({
      identity: ownerPlan.identity,
      binding: ownerPlan.binding,
    })
    expect(await journal.recentLifecycle({ id: staged.manifest.id, source: staged.identitySource })).toMatchObject([{
      client: 'web',
      operation: 'install',
      committedAt: expect.any(String),
      decisions: [{ capability: 'models.read', decision: 'allow-once' }],
    }])
    expect(await review(operation, 'apply-web', { ...context, admitted: true })).toMatchObject({
      value: { status: 'rejected' },
    })
  } finally {
    controller.abort()
    signer.close()
    authority.close()
    plans.close()
  }
})

it('returns the actual reviewed candidate when enabling a plugin requires authorization', async () => {
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
  const plan = (await coordinator.permissionReviewPlanV7({
    requestId: 'install-review',
    profileId: 'default',
    runtimeGeneration: 'runtime-1',
    expectedRevision: 0,
    target: { kind: 'candidate', candidateId: inspected.candidateId! },
  }))!
  const required = plan.declarations.find(item => item.decisionRequired)!
  const decision: DeferredPermissionDecision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
    schemaVersion: 7,
    origin: 'explicit-user',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: [{
      capability: required.capability,
      scope: required.scope,
      securityFingerprint: required.securityFingerprint,
      decision: 'allow-once',
    }],
  }
  expect(
    (await coordinator.applyPermissionReviewV7({
      requestId: 'install',
      profileId: 'default',
      runtimeGeneration: 'runtime-1',
      expectedRevision: 0,
      decision,
    })).outcome,
  ).toBe('applied')
  const disablePlan = await coordinator.handle(
    { ...request({ kind: 'disable', pluginId: staged.manifest.id, impactToken: 'probe' }, 1), profileId: 'default' },
  )
  expect(
    (await coordinator.handle(
      {
        ...request({ kind: 'disable', pluginId: staged.manifest.id, impactToken: disablePlan.impactToken! }, 1),
        profileId: 'default',
      },
    )).outcome,
  ).toBe('applied')
  const service = await openPluginManagementService({
    homeDir: home,
    configPath,
    profileId: 'default',
    watch: false,
    lifecycle: { coordinator, runtimeGeneration: 'runtime-1', mode: 'service' },
  })
  try {
    const active = await coordinator.store.loadActive()
    const ownerSnapshot = () => ({ active, registryEpoch: 0 }) as any
    const plans = new ServiceRendererManagementPlans(
      token => service.discardExecutionPlan?.(token),
      true,
      async () => true,
    )
    const alias = `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}`
    const identity = {
      resolveHistory: () => ({ id: staged.manifest.id, source: staged.identitySource }),
      assertInstalledProjection: () => {},
    }
    const entry = () =>
      ({
        confirmed: true,
        current: () => true,
        unchanged: async () => true,
        identity,
        aliases: new Map([[staged.manifest.id, alias]]),
        snapshot: ownerSnapshot(),
        scopedLifecycle: true,
        restricted: { plans, writableIds: new Set([staged.manifest.id]) },
      }) as any
    const context = {
      profileId: 'default',
      rendererId: 'c'.repeat(64),
      ownerGeneration: 'runtime-1',
      signal: new AbortController().signal,
      admitted: true,
    }
    const intent = { kind: 'plugin-enable' as const, pluginId: staged.manifest.id }
    const prepared = await projectManagementRequest({
      context,
      operation: { kind: 'plan', request: intent },
      entry,
      ownerSnapshot,
      dispatch: async () => await service.plan(intent),
    }) as any
    expect(prepared.status).toBe('planned')
    const result = await projectManagementRequest({
      context,
      operation: { kind: 'execute', request: prepared.executionRequest, expectedRevision: prepared.snapshot.revision },
      entry,
      ownerSnapshot,
      dispatch: async operation =>
        await service.execute((operation as any).request, (operation as any).expectedRevision),
    }) as any
    expect(result.status).toBe('permission-review-required')
    expect(result.candidateId).toBe(result.permissionPlan.binding.requestId)
    const ownerReview = plans.peekReview(result.candidateId)!
    expect(
      (await coordinator.store.loadCandidate(ownerReview.ownerPlan.binding.requestId!)).plugins.find(item =>
        item.id === staged.manifest.id
      )
        ?.enabled,
    ).toBe(true)
    plans.close()
  } finally {
    service.close()
  }
})
