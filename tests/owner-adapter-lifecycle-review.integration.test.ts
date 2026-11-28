import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createOwnerAdapterLifecycleReview } from '../packages/cli/src/cli/owner-adapter-lifecycle-review.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { ServiceRendererRuntimeGrants } from '../packages/cli/src/cli/service-renderer-runtime-grants.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2 } from '../packages/cli/src/permission-contracts.js'
import { normalizePermissionPolicyRecordV2 } from '../packages/cli/src/permission-model-v2.js'
import type { OwnerAdapterManagementContext } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { handlePluginLifecycleBindingRequest } from '../packages/cli/src/launcher/plugin-lifecycle-rpc.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import type { DeferredPermissionDecision, DeferredPermissionPlan } from '../packages/cli/src/permission-deferral.js'
import { FormalRuntime, localPackageV5, registerCleanup, workspace } from './suites/plugin-lifecycle.fixtures.js'

registerCleanup()

it('attributes an exact native install review to its service-owned journal without exposing its source', async () => {
  const { root, home } = await workspace()
  await mkdir(home, { mode: 0o700 })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: home,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    permissionPolicies: [],
    runtime: new FormalRuntime(),
  })
  const staged = await coordinator.stagePackageSource({
    kind: 'local-directory',
    location: pathToFileURL(await localPackageV5(root, false, false)).href,
  })
  const planned = await coordinator.inspectStagedPackage(staged, 'inspect-1')
  const handler = { token: 'private', profileId: 'work', generation: 'runtime-1', coordinator }
  const journal = new PermissionDecisionJournal({ homeDir: home, profileId: 'work' })
  let pendingObserved = false
  let webGrantObserved = false
  const grants = new ServiceRendererRuntimeGrants()
  const review = createOwnerAdapterLifecycleReview({
    homeDir: home,
    coordinator,
    journal,
    runtimeGrants: () => grants,
    dispatch: async request => {
      if (request.kind === 'permission-review-apply-v7') {
        const pending = await journal.recentLifecycle({ id: staged.manifest.id, source: staged.identitySource })
        pendingObserved = pending.length === 1 && pending[0]?.committedAt === undefined
        const decision = request.request.decision
        const item = (await coordinator.store.loadCandidate(decision.binding.requestId!)).plugins
          .find(plugin => plugin.id === decision.identity.pluginId)!
        const choice = decision.decisions.find(value => value.capability === 'models.read')!
        const record = normalizePermissionPolicyRecordV2({
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
          schemaVersion: 2,
          key: {
            profileId: decision.profileId,
            identity: decision.identity,
            capability: choice.capability,
            scope: choice.scope,
            securityFingerprint: choice.securityFingerprint,
          },
          policy: 'ask',
        })
        webGrantObserved = grants.consumeActivation({
          transactionId: decision.binding.requestId,
          moduleGeneration: item.moduleGeneration,
          digest: item.digest,
          record,
          rendererId: 'b'.repeat(64),
        })
      }
      return await handlePluginLifecycleBindingRequest(handler, request)
    },
  })
  const controller = new AbortController()
  const context: OwnerAdapterManagementContext = {
    rendererId: 'a'.repeat(64),
    signal: controller.signal,
    secret: 'adapter-secret',
    live: () => !controller.signal.aborted,
    current: () => !controller.signal.aborted,
  }
  const scope = { profileId: 'work', runtimeGeneration: 'runtime-1', expectedRevision: 0 }
  const plan = await review({
    kind: 'permission-review-plan-v7',
    requestId: 'review-1',
    request: { ...scope, requestId: 'review-1', target: { kind: 'candidate', candidateId: planned.candidateId! } },
  }, context) as DeferredPermissionPlan
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
  const apply = {
    kind: 'permission-review-apply-v7' as const,
    requestId: 'apply-1',
    request: { ...scope, requestId: 'apply-1', decision },
  }
  const otherController = new AbortController()
  const other = { ...context, rendererId: 'b'.repeat(64), signal: otherController.signal }
  await expect(review(apply, other)).rejects.toThrow('adapter-review-unavailable')
  await expect(review({
    ...apply,
    request: {
      ...apply.request,
      decision: { ...decision, identity: { ...decision.identity, source: 'file:///other' } },
    },
  }, context)).rejects.toThrow()
  await review({
    kind: 'permission-review-plan-v7',
    requestId: 'review-2',
    request: { ...scope, requestId: 'review-2', target: { kind: 'candidate', candidateId: planned.candidateId! } },
  }, context)
  expect(await review(apply, context)).toMatchObject({ outcome: 'applied' })
  expect(pendingObserved).toBe(true)
  expect(webGrantObserved).toBe(true)
  expect(await journal.recentLifecycle({ id: staged.manifest.id, source: staged.identitySource })).toMatchObject([{
    operation: 'install',
    client: 'codex',
    committedAt: expect.any(String),
    decisions: [{ capability: 'models.read', decision: 'allow-once' }],
  }])
  expect(await journal.recentLifecycle({ id: staged.manifest.id, source: 'file:///other' })).toEqual([])
  const events = await journal.recent([{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v2.schema.json',
    schemaVersion: 2,
    key: {
      profileId: 'work',
      identity: plan.identity,
      capability: required.capability as 'models.read',
      scope: required.scope,
      securityFingerprint: required.securityFingerprint,
    },
    policy: 'ask',
  }])
  const file = path.join(home, 'state', 'profiles', 'work', 'permission-decisions', `${events[0]!.entry.id}.json`)
  const stored = await readFile(file, 'utf8')
  expect(stored).not.toContain(staged.identitySource)
  expect(stored).not.toContain(JSON.stringify(required.scope))
  await expect(review(apply, context)).rejects.toThrow('adapter-review-unavailable')
  controller.abort()
  otherController.abort()
})
