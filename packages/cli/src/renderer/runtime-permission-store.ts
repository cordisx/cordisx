import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
} from '../permission-persistence.js'
import { BindingPermissionPolicyStore } from './permission-binding.js'
import { ownerSnapshotPermissionStore } from './platform/owner-snapshot-permission-store.js'
import { BrowserPermissionPolicyStore, MemoryPermissionPolicyStore } from './platform.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

/** Select policy persistence according to the actual Host, not page origin. */
export function createRuntimePermissionStore(
  metadata: CordisXRuntimeMetadata,
  sign?: import('../independent-manager/standalone-permission-signer.js').StandalonePermissionSigner['sign'],
) {
  if (metadata.permissionBridgeToken !== undefined) {
    return BindingPermissionPolicyStore.connect(
      metadata.permissionBridgeToken,
      metadata.permissionPolicies ?? [],
      metadata.hostKind !== 'standalone'
        ? undefined
        : {
          ...(metadata.standaloneWriteUncertain === undefined
            ? {}
            : { onUnknown: () => metadata.standaloneWriteUncertain?.('permission-policy') }),
          ...(sign === undefined ? {} : { sign }),
        },
    )
  }
  if (metadata.hostKind === 'standalone') return ownerSnapshotPermissionStore(metadata.permissionPolicies ?? [])
  if (metadata.hostKind === 'playground' && metadata.permissionPolicies !== undefined) {
    return new MemoryPermissionPolicyStore(
      metadata.permissionPolicies.filter(record =>
        !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record)
        && !isPermissionPolicyRecordV4(record)
      ),
      metadata.permissionPolicies.filter(isPermissionPolicyRecordV2),
      metadata.permissionPolicies.filter(isPermissionPolicyRecordV3),
      metadata.permissionPolicies.filter(isPermissionPolicyRecordV4),
    )
  }
  return new BrowserPermissionPolicyStore(metadata.profileId)
}
