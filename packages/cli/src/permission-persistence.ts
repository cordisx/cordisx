import type { CordisXPermissionPolicyRecordV1 } from './platform-contracts.js'
import type { CordisXPermissionPolicyRecordV2 } from './permission-contracts.js'
import { normalizePermissionPolicyRecord, permissionRecordKey } from './permissions.js'
import { normalizePermissionPolicyRecordV2, permissionRecordKeyV2 } from './permission-model-v2.js'

export type CordisXPersistedPermissionPolicyRecord = CordisXPermissionPolicyRecordV1 | CordisXPermissionPolicyRecordV2

export function isPermissionPolicyRecordV2(value: unknown): value is CordisXPermissionPolicyRecordV2 {
  return value !== null && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 2
}

export function normalizePersistedPermissionPolicyRecord(
  value: unknown,
  label = 'permission policy',
): CordisXPersistedPermissionPolicyRecord {
  return isPermissionPolicyRecordV2(value)
    ? normalizePermissionPolicyRecordV2(value, label)
    : normalizePermissionPolicyRecord(value, label)
}

export function persistedPermissionRecordKey(record: CordisXPersistedPermissionPolicyRecord): string {
  return isPermissionPolicyRecordV2(record) ? permissionRecordKeyV2(record) : permissionRecordKey(record)
}

/** Key shared only for retiring an exact v1 record after its v2 migration is durable. */
export function persistedPermissionMigrationKey(record: CordisXPersistedPermissionPolicyRecord): string {
  const normalized = normalizePersistedPermissionPolicyRecord(record)
  return JSON.stringify([
    normalized.key.profileId,
    normalized.key.identity.source,
    normalized.key.identity.pluginId,
    normalized.key.capability,
    normalized.key.scope,
  ])
}
