import { expect, it } from 'vitest'
import { createOwnerPolicySigner } from '../packages/cli/src/cli/owner-policy-signature.js'
import type { OwnerPolicyTransition } from '../packages/cli/src/owner-policy-handoff.js'
import { verifyOwnerPolicyPacket } from '../packages/cli/src/renderer/owner-policy-verification.js'

it('accepts only an unmodified policy transition from this exact owner and adapter session', async () => {
  const owner = createOwnerPolicySigner()
  const other = createOwnerPolicySigner()
  const scope = { profileId: 'work', generation: 'runtime-1', rendererId: 'a'.repeat(64), key: owner.publicKey }
  const transition: OwnerPolicyTransition = {
    profileId: scope.profileId,
    ownerGeneration: scope.generation,
    rendererId: scope.rendererId,
    handoffId: 'b'.repeat(64),
    requestId: 'permission-1',
    origin: false,
    identity: { id: 'demo', source: 'https://example.com/demo' },
    moduleGeneration: 'module-1',
    expected: [],
    updates: [{}],
    candidate: [{}],
  }
  const packet = owner.sign(transition)
  expect(await verifyOwnerPolicyPacket(packet, scope)).toEqual(transition)
  expect(await verifyOwnerPolicyPacket({ ...packet, payload: `${packet.payload} ` }, scope)).toBeUndefined()
  expect(await verifyOwnerPolicyPacket(packet, { ...scope, key: other.publicKey })).toBeUndefined()
  expect(await verifyOwnerPolicyPacket(packet, { ...scope, rendererId: 'c'.repeat(64) })).toBeUndefined()
  expect(await verifyOwnerPolicyPacket(packet, { ...scope, generation: 'runtime-2' })).toBeUndefined()
})
