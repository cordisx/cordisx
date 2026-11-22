import { webcrypto } from 'node:crypto'
import { expect, it } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { normalizePermissionPolicyRecordV3 } from '../packages/cli/src/permission-model-v3.js'
import { normalizeStandalonePermissionProofPayload } from '../packages/cli/src/standalone-permission-proof.js'

const scope = { rendererId: 'a'.repeat(64), profileId: 'default', generation: 'owner-1' }
const identity = { id: 'channel', source: `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}` }
const review = {
  identity,
  pointId: 'manager.content',
  profileId: scope.profileId,
  runtimeGeneration: scope.generation,
  moduleGeneration: 'configured-1',
  artifact: { version: '1.2.3', integrity: `sha256:${'c'.repeat(64)}` as const },
}
const plan = buildDomPermissionAuthorizationPlanV3({
  planId: 'review-1',
  profileId: scope.profileId,
  identity: { source: identity.source, pluginId: identity.id },
  binding: { operationId: 'review-1', runtimeGeneration: scope.generation, moduleGeneration: review.moduleGeneration },
  declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [review.pointId] } },
  policies: [],
})
const declaration = plan.declarations[0]!
const record = normalizePermissionPolicyRecordV3({
  $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
  schemaVersion: 3,
  key: {
    profileId: plan.profileId,
    identity: plan.identity,
    capability: declaration.capability,
    scope: declaration.scope,
    securityFingerprint: declaration.securityFingerprint,
  },
  policy: 'allow-persistent',
})

function decision() {
  const view = new PermissionAuthorizationViewModel(plan)
  view.select('ui.extension-points.render', 'allow-persistent')
  const result = view.confirm()
  if (result.status !== 'confirmed' || result.decision.schemaVersion !== 3) throw new Error('fixture decision failed')
  return result.decision
}

it('binds a confirmed decision to one renderer, artifact, request and owner snapshot', async () => {
  let clock = 1_700_000_000_000
  const signer = await createStandalonePermissionSigner(scope, {
    crypto: webcrypto as unknown as Crypto,
    now: () => clock,
  })
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
    now: () => clock,
  })
  try {
    authority.register(context, signer.publicKey)
    expect(() => authority.register(context, signer.publicKey)).toThrow('permission-proof-unavailable')
    const liveReview = { ...review, isCurrent: () => true, verifyCurrent: async () => true, invalidate: () => {} }
    expect(signer.noteConfirmed(liveReview, plan, decision())).toBe(true)
    const proof = await signer.sign('request-1', [record])
    expect(() =>
      normalizeStandalonePermissionProofPayload({
        ...(proof as { payload: Record<string, unknown> }).payload,
        planId: 'invalid' + String.fromCharCode(0),
      })
    ).toThrow('standalone-permission-proof-invalid')
    const input = {
      context: { ...context, admitted: true },
      requestId: 'request-1',
      records: [record],
      expected: [],
      moduleGeneration: review.moduleGeneration,
      artifact: review.artifact,
      proof,
    }
    expect(authority.authorize({ ...input, requestId: 'request-2' })).toBe(false)
    expect(authority.authorize({ ...input, moduleGeneration: 'other' })).toBe(false)
    expect(authority.authorize({ ...input, artifact: { ...review.artifact, version: 'other' } })).toBe(false)
    expect(authority.authorize({ ...input, expected: [{ ...record, policy: 'deny-persistent' }] })).toBe(false)
    expect(authority.authorize(input)).toBe(true)
    expect(authority.authorize(input)).toBe(false)
    await expect(signer.sign('request-1', [record])).rejects.toThrow('decision-unavailable')
    expect(signer.noteConfirmed(review, plan, decision())).toBe(true)
    clock += 60_001
    await expect(signer.sign('request-3', [record])).rejects.toThrow('decision-unavailable')
    controller.abort()
    expect(authority.authorize(input)).toBe(false)
  } finally {
    signer.close()
    authority.close()
  }
})

it('does not sign an unconfirmed or mismatched decision', async () => {
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  try {
    expect(signer.noteConfirmed({ ...review, moduleGeneration: 'other' }, plan, decision())).toBe(false)
    expect(signer.noteConfirmed(review, plan, { ...decision(), origin: 'certified-implicit' } as never)).toBe(false)
    await expect(signer.sign('request-1', [record])).rejects.toThrow('decision-unavailable')
  } finally {
    signer.close()
  }
})
