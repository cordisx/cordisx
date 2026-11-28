import { randomBytes } from 'node:crypto'
import { parseStandalonePolicyHandoff } from '../independent-manager/standalone-policy-handoff.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import type { ManagerRendererCommandPeer, ManagerRendererPeerScope } from './manager-renderer-peer.js'

type PolicyProjection = {
  readonly identity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
}

/**
 * Deliver an owner-read policy transition to the selected Manager peers.
 * The caller owns the profile, admission and writer fences; this helper does
 * not authorize a write or prove that unlisted consumers have adopted it.
 */
export async function synchronizeServiceRendererPolicies(input: {
  readonly scope: ManagerRendererPeerScope
  readonly peers: readonly {
    readonly peer: ManagerRendererCommandPeer
    readonly origin: boolean
    readonly project: (records: readonly CordisXPersistedPermissionPolicyRecord[]) => PolicyProjection
  }[]
  readonly requestId: string
  readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly updates: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly candidate: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly isCurrent: () => boolean
  /** Fence the entire owner reservation, including consumers outside this list. */
  readonly fence: () => void
}): Promise<boolean> {
  const fail = () => {
    try {
      input.fence()
    } catch { /* an uncertain reservation is never reported as confirmed */ }
    return false
  }
  const current = () => {
    try {
      return input.isCurrent() === true
    } catch {
      return false
    }
  }
  try {
    if (
      !current() || new Set(input.peers.map(item => item.peer)).size !== input.peers.length
      || new Set(input.peers.map(item => item.peer.identity.rendererId)).size !== input.peers.length
      || input.peers.filter(item => item.origin).length > 1
    ) return fail()
    const handoffId = randomBytes(32).toString('hex')
    const targets = input.peers.map(({ peer, origin, project }) => {
      if (peer.closed || !attachmentEqual(peer.scope, input.scope)) {
        throw new Error('renderer-permission-fleet-unavailable')
      }
      const before = project(input.expected)
      const update = project(input.updates)
      const after = project(input.candidate)
      if (
        !attachmentEqual(before.identity, update.identity) || !attachmentEqual(before.identity, after.identity)
        || before.moduleGeneration !== update.moduleGeneration || before.moduleGeneration !== after.moduleGeneration
      ) throw new Error('renderer-permission-fleet-unavailable')
      const changed = update.policies[0]
      if (!changed) throw new Error('renderer-permission-fleet-unavailable')
      const relevant = isPermissionPolicyRecordV2(changed)
        ? (records: readonly CordisXPersistedPermissionPolicyRecord[]) =>
          records.filter(record =>
            isPermissionPolicyRecordV2(record)
            && persistedPermissionRecordKey(record) === persistedPermissionRecordKey(changed)
          )
        : (records: readonly CordisXPersistedPermissionPolicyRecord[]) => records.filter(isPermissionPolicyRecordV3)
      const payload = parseStandalonePolicyHandoff({
        rendererId: peer.identity.rendererId,
        ownerGeneration: input.scope.generation,
        handoffId,
        requestId: input.requestId,
        origin,
        identity: before.identity,
        moduleGeneration: before.moduleGeneration,
        expected: relevant(before.policies),
        updates: relevant(update.policies),
        candidate: relevant(after.policies),
      }, { profileId: input.scope.profileId, generation: input.scope.generation, rendererId: peer.identity.rendererId })
      return { peer, payload }
    })
    if (!current()) return fail()
    await Promise.all(targets.map(async ({ peer, payload }) => {
      const receipt = await peer.request('permission-policy', payload)
      if (
        !current() || !attachmentEqual(receipt, {
          rendererId: peer.identity.rendererId,
          ownerGeneration: input.scope.generation,
          handoffId,
          requestId: input.requestId,
          moduleGeneration: payload.moduleGeneration,
          adopted: true,
        })
      ) throw new Error('renderer-permission-fleet-unavailable')
    }))
    return current() || fail()
  } catch {
    return fail()
  }
}
