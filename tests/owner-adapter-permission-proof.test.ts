import { webcrypto } from 'node:crypto'
import { expect, it } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { OwnerAdapterPermissionProof } from '../packages/cli/src/cli/owner-adapter-permission-proof.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { normalizePermissionPolicyRecordV3 } from '../packages/cli/src/permission-model-v3.js'

it('accepts one native document decision only for its owner session and exact package', async () => {
  const scope = { rendererId: 'a'.repeat(64), profileId: 'default', generation: 'owner-1' }
  const identity = { id: 'demo', source: 'file:///demo.js' }
  const artifact = { version: '1.2.3', integrity: `sha256:${'c'.repeat(64)}` as const }
  const plan = buildDomPermissionAuthorizationPlanV3({
    planId: 'review-1',
    profileId: scope.profileId,
    identity: { source: identity.source, pluginId: identity.id },
    binding: { operationId: 'review-1', runtimeGeneration: scope.generation, moduleGeneration: 'module-1' },
    declaration: {
      name: 'ui.extension-points.render',
      required: false,
      scope: { extensionPoints: ['manager.content'] },
    },
    policies: [],
  })
  const view = new PermissionAuthorizationViewModel(plan)
  view.select('ui.extension-points.render', 'allow-persistent')
  const decision = view.confirm()
  if (decision.status !== 'confirmed' || decision.decision.schemaVersion !== 3) throw new Error('fixture failed')
  const declaration = plan.declarations[0]!
  const record = normalizePermissionPolicyRecordV3({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
    schemaVersion: 3,
    key: {
      profileId: scope.profileId,
      identity: plan.identity,
      capability: declaration.capability,
      scope: declaration.scope,
      securityFingerprint: declaration.securityFingerprint,
    },
    policy: 'allow-persistent',
  })
  const signer = await createStandalonePermissionSigner(scope, {
    crypto: webcrypto as unknown as Crypto,
    target: 'native',
  })
  const controller = new AbortController()
  let live = true
  const context = {
    rendererId: scope.rendererId,
    signal: controller.signal,
    current: () => live,
    live: () => live,
  } as never
  const authority = new OwnerAdapterPermissionProof(scope)
  const keyId = 'd'.repeat(64)
  try {
    authority.register(context, keyId, signer.publicKey)
    expect(() => authority.register(context, keyId, signer.publicKey)).toThrow()
    expect(
      signer.noteConfirmed(
        {
          identity,
          pointId: 'manager.content',
          profileId: scope.profileId,
          runtimeGeneration: scope.generation,
          moduleGeneration: 'module-1',
          artifact,
        },
        plan,
        decision.decision,
      ),
    ).toBe(true)
    const proof = { keyId, proof: await signer.sign('request-1', [record]) }
    const input = {
      context,
      requestId: 'request-1',
      records: [record],
      expected: [],
      moduleGeneration: 'module-1',
      artifact,
      proof,
    }
    expect(authority.authorize({ ...input, proof: { ...proof, keyId: 'e'.repeat(64) } })).toBe(false)
    expect(authority.authorize({ ...input, artifact: { ...artifact, version: '2.0.0' } })).toBe(false)
    expect(authority.authorize(input)).toBe(true)
    expect(authority.authorize(input)).toBe(false)
    controller.abort()
    live = false
    expect(authority.authorize(input)).toBe(false)
  } finally {
    authority.close()
    signer.close()
  }
})
