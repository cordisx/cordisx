import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  buildPermissionAuthorizationPlanV2,
  CapabilityRiskCatalog,
} from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { standalonePermissionPrompt } from '../packages/cli/src/renderer/standalone-runtime-prompt.js'

it('requires a current Web artifact, graph, policy and one-use proof before granting', async () => {
  const scope = { rendererId: 'a'.repeat(64), profileId: 'default', generation: 'owner-1' }
  const identity = { id: 'demo', source: `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}` }
  const artifact = { version: '1.0.0', integrity: `sha256:${'c'.repeat(64)}` as const }
  const plan = buildPermissionAuthorizationPlanV2({
    planId: 'runtime-1',
    operation: 'runtime',
    profileId: scope.profileId,
    identity: { pluginId: identity.id, source: identity.source },
    binding: {
      operationId: 'runtime-1',
      requestId: 'request-1',
      runtimeGeneration: scope.generation,
      moduleGeneration: 'graph-1',
    },
    declarations: [{ name: 'models.read', required: false, scope: { providers: ['codex'] } }],
    policies: [],
    contextFor: () => ({
      operation: 'runtime',
      providerKind: 'current-connection',
      providerTrust: 'configured',
      availability: 'supported',
    }),
  }, new CapabilityRiskCatalog())
  const view = new PermissionAuthorizationViewModel(plan)
  view.select('models.read', 'allow-once')
  const result = view.confirm()
  if (result.status !== 'confirmed' || result.decision.schemaVersion !== 2) throw new Error('fixture failed')
  const ordinary = { request: vi.fn(async () => result.decision) }
  const review = { isReviewing: () => false, dispose() {}, cancelV3() {}, isDomLeaseVisible: () => true }
  const prompt = standalonePermissionPrompt(ordinary, review as never)
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const controller = new AbortController()
  const context = {
    profileId: scope.profileId,
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const authority = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  try {
    authority.register(context, signer.publicKey)
    const signed = await signer.signWebRuntimeOnce('request-1', artifact, plan, result.decision)
    const input = {
      context: { ...context, admitted: true },
      requestId: 'request-1',
      ...signed,
      expected: [],
      moduleGeneration: 'graph-1',
      artifact,
    }
    expect(authority.authorizeWebRuntimeOnce({ ...input, artifact: { ...artifact, version: 'other' } })).toBe(false)
    expect(authority.authorizeWebRuntimeOnce({ ...input, moduleGeneration: 'other' })).toBe(false)
    expect(authority.authorizeWebRuntimeOnce({ ...input, expected: [{ ...signed.record, policy: 'deny-persistent' }] }))
      .toBe(false)
    expect(authority.authorizeWebRuntimeOnce(input)).toBe(true)
    expect(authority.authorizeWebRuntimeOnce(input)).toBe(false)
    expect(await prompt.request(plan, identity, { ownerReviewEligible: true, ownerReviewArtifact: artifact }))
      .toBeUndefined()
    expect(ordinary.request).not.toHaveBeenCalled()
    expect(prompt.bindRuntimeDecision(async () => false)).toBe(true)
    expect(await prompt.request(plan, identity, { ownerReviewEligible: false })).toBeUndefined()
    expect(
      await prompt.request(plan, { ...identity, id: 'other' }, {
        ownerReviewEligible: true,
        ownerReviewArtifact: artifact,
      }),
    ).toBeUndefined()
    expect(ordinary.request).not.toHaveBeenCalled()
    expect(await prompt.request(plan, identity, { ownerReviewEligible: true, ownerReviewArtifact: artifact }))
      .toBeUndefined()
    expect(ordinary.request).toHaveBeenCalledTimes(1)
  } finally {
    prompt.dispose?.()
    signer.close()
    controller.abort()
    authority.close()
  }
})
