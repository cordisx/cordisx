import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  normalizePersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import { verifyOwnerPolicyPacket } from './owner-policy-verification.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import type { PermissionPolicyStore } from './platform.js'

/** Every native document adopts the owner packet; only its actual writer acknowledges origin. */
export async function adoptOwnerPolicy(
  runtime: RuntimeClosureScope,
  packet: unknown,
): Promise<boolean | 'origin'> {
  const metadata = runtime.metadata()
  const authority = metadata?.ownerPolicyVerification
  if (runtime.disposed || metadata?.ownerPermissionSnapshot !== true || !authority) return false
  const transition = await verifyOwnerPolicyPacket(packet, {
    profileId: metadata.profileId,
    generation: runtime.generation()!,
    rendererId: authority.rendererId,
    key: authority.publicKey,
  })
  if (!transition || runtime.disposed) return false
  const updates = transition.updates.map(record => normalizePersistedPermissionPolicyRecord(record))
  const store: PermissionPolicyStore = runtime.permissionStore()!
  const onUnknown = () => {
    void runtime.dispose()!().catch(() => undefined)
  }
  const broker = runtime.broker()!
  let origin = false
  let adopted = false
  if (updates.every(isPermissionPolicyRecordV3)) {
    origin = transition.origin && store.canAdoptStandaloneV3?.(transition.requestId, updates) === true
    adopted = await broker.adoptOwnerManagerPolicies({ ...transition, origin, onUnknown })
  } else if (updates.every(isPermissionPolicyRecordV2)) {
    origin = transition.origin && store.canAdoptStandaloneV2?.(transition.requestId, updates) === true
    adopted = await broker.adoptOwnerRuntimePolicies({ ...transition, origin, onUnknown })
  }
  return adopted && !runtime.disposed ? origin ? 'origin' : true : false
}
