import { isPermissionPolicyRecordV3, normalizePersistedPermissionPolicyRecord } from '../permission-persistence.js'
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
  if (!updates.every(isPermissionPolicyRecordV3)) return false
  const store: PermissionPolicyStore = runtime.permissionStore()!
  const origin = transition.origin && store.canAdoptStandaloneV3?.(transition.requestId, updates) === true
  const adopted = await runtime.broker()!.adoptOwnerManagerPolicies({
    ...transition,
    origin,
    onUnknown: () => {
      void runtime.dispose()!().catch(() => undefined)
    },
  })
  return adopted && !runtime.disposed ? origin ? 'origin' : true : false
}
