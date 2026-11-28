import type { CordisXPersistedPermissionPolicyRecord } from '../../permission-persistence.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
} from '../../permission-persistence.js'
import { MemoryPermissionPolicyStore, type PermissionPolicyStore } from './platform-permission-store.js'

/**
 * A standalone renderer may read the current owner's projected policies, but
 * cannot grant or persist permissions without the owner-backed bridge.
 */
export function ownerSnapshotPermissionStore(
  policies: readonly CordisXPersistedPermissionPolicyRecord[],
): PermissionPolicyStore {
  const memory = new MemoryPermissionPolicyStore(
    policies.filter(record =>
      !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record) && !isPermissionPolicyRecordV4(record)
    ),
    policies.filter(isPermissionPolicyRecordV2),
    policies.filter(isPermissionPolicyRecordV3),
    policies.filter(isPermissionPolicyRecordV4),
  )
  const unavailable = () => {
    throw new Error('Owner permission writes are unavailable')
  }
  return {
    read: () => memory.read(),
    readV2: () => memory.readV2(),
    readV3: () => memory.readV3(),
    readV4: () => memory.readV4(),
    write: unavailable,
    writeV2: unavailable,
    writeV3: unavailable,
    writeV4: unavailable,
    writeAll: unavailable,
  }
}
