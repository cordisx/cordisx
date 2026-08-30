import type { CordisXPermissionPolicyRecordV1 } from './platform-contracts.js'
import type { CordisXPermissionPolicyRecordV2, CordisXPermissionPolicyRecordV3, CordisXPermissionPolicyRecordV4 } from './permission-contracts.js'
import { normalizePermissionPolicyRecord, permissionRecordKey } from './permissions.js'
import { normalizePermissionPolicyRecordV2, permissionRecordKeyV2 } from './permission-model-v2.js'
import { normalizePermissionPolicyRecordV3, permissionRecordKeyV3 } from './permission-model-v3.js'
import { normalizePermissionPolicyRecordV4, permissionRecordKeyV4 } from './permission-model-v4.js'

export type CordisXPersistedPermissionPolicyRecord = CordisXPermissionPolicyRecordV1 | CordisXPermissionPolicyRecordV2 | CordisXPermissionPolicyRecordV3 | CordisXPermissionPolicyRecordV4

export function isPermissionPolicyRecordV2(value: unknown): value is CordisXPermissionPolicyRecordV2 {
  return value !== null && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 2
}

export function isPermissionPolicyRecordV3(value: unknown): value is CordisXPermissionPolicyRecordV3 {
  return value !== null && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 3
}

export function isPermissionPolicyRecordV4(value: unknown): value is CordisXPermissionPolicyRecordV4 {
  return value !== null && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 4
}

export function normalizePersistedPermissionPolicyRecord(
  value: unknown,
  label = 'permission policy',
): CordisXPersistedPermissionPolicyRecord {
  return isPermissionPolicyRecordV4(value)
    ? normalizePermissionPolicyRecordV4(value, label)
    : isPermissionPolicyRecordV3(value)
      ? normalizePermissionPolicyRecordV3(value, label)
      : isPermissionPolicyRecordV2(value)
        ? normalizePermissionPolicyRecordV2(value, label)
        : normalizePermissionPolicyRecord(value, label)
}

export function persistedPermissionRecordKey(record: CordisXPersistedPermissionPolicyRecord): string {
  return isPermissionPolicyRecordV4(record)
    ? permissionRecordKeyV4(record)
    : isPermissionPolicyRecordV3(record)
      ? permissionRecordKeyV3(record)
      : isPermissionPolicyRecordV2(record) ? permissionRecordKeyV2(record) : permissionRecordKey(record)
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
