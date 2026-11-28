import { expect, it, vi } from 'vitest'
import { createOwnerPolicySigner } from '../packages/cli/src/cli/owner-policy-signature.js'
import { adoptOwnerPolicy } from '../packages/cli/src/renderer/runtime-owner-policy.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

it('acknowledges origin only in the native document with the matching pending write', async () => {
  const signer = createOwnerPolicySigner()
  const rendererId = 'a'.repeat(64)
  const [record] = exactDomPermissionPolicies('default', [{
    id: 'demo',
    entry: '/demo.js',
    pointIds: ['manager.content'],
  }])
  const transition = {
    profileId: 'default',
    ownerGeneration: 'owner-1',
    rendererId,
    handoffId: 'b'.repeat(64),
    requestId: 'write-1',
    origin: true,
    identity: { id: 'demo', source: 'file:///demo.js' },
    moduleGeneration: 'module-1',
    expected: [],
    updates: [record],
    candidate: [record],
  }
  const packet = signer.sign(transition)
  const adopt = vi.fn(async () => true)
  let pending = true
  const runtime = {
    disposed: false,
    metadata: () => ({
      profileId: 'default',
      ownerPermissionSnapshot: true,
      ownerPolicyVerification: { rendererId, publicKey: signer.publicKey },
    }),
    generation: () => 'owner-1',
    permissionStore: () => ({ canAdoptStandaloneV3: () => pending }),
    broker: () => ({ adoptOwnerManagerPolicies: adopt }),
  }
  expect(await adoptOwnerPolicy(runtime as never, packet)).toBe('origin')
  expect(adopt.mock.calls[0]?.[0]).toMatchObject({ origin: true })
  pending = false
  expect(await adoptOwnerPolicy(runtime as never, packet)).toBe(true)
  expect(adopt.mock.calls[1]?.[0]).toMatchObject({ origin: false })
})
