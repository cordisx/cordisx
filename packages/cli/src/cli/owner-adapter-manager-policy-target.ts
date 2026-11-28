import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { domPermissionAuthorizationKeyV3 } from '../permission-model-v3.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV3,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import type { ManagerPolicyTarget } from './service-renderer-installed-permission.js'

/** Map only the owner's exact Manager UI points to a native policy target. */
export function ownerAdapterManagerPolicyTarget(input: {
  readonly kind: ManagerPolicyTarget['kind']
  readonly profileId: string
  readonly identity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly digest: `sha256:${string}`
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
  readonly isCurrent: () => boolean
  readonly verifyCurrent?: () => Promise<boolean>
}): ManagerPolicyTarget {
  const invalid = (): never => {
    throw new Error('adapter-permission-target-unavailable')
  }
  const identity = Object.freeze({ ...input.identity })
  const artifact = Object.freeze({ ...input.artifact })
  const selected = (record: CordisXPersistedPermissionPolicyRecord) =>
    isPermissionPolicyRecordV3(record) && record.key.profileId === input.profileId
    && record.key.identity.pluginId === identity.id && record.key.identity.source === identity.source
    && record.key.capability === 'ui.extension-points.render' && record.key.scope.extensionPoints?.length === 1
    && ['manager.settings.navigation-items', 'manager.content'].includes(record.key.scope.extensionPoints[0]!)
  const project = (records: readonly CordisXPersistedPermissionPolicyRecord[]) => {
    if (!input.isCurrent() || records.length > 4096) return invalid()
    const policies = records.map(record => normalizePersistedPermissionPolicyRecord(record)).filter(selected)
    if (new Set(policies.map(persistedPermissionRecordKey)).size !== policies.length || !input.isCurrent()) {
      return invalid()
    }
    return { identity, moduleGeneration: input.moduleGeneration, policies }
  }
  return Object.freeze({
    kind: input.kind,
    identity,
    ownerIdentity: identity,
    moduleGeneration: input.moduleGeneration,
    digest: input.digest,
    artifact,
    isCurrent: input.isCurrent,
    ...(input.verifyCurrent === undefined ? {} : { verifyCurrent: input.verifyCurrent }),
    project,
    resolve(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
      if (!input.isCurrent() || records.length < 1 || records.length > 2) return invalid()
      const values = records.map(record => normalizePersistedPermissionPolicyRecord(record))
      for (const record of values) {
        if (!selected(record) || !isPermissionPolicyRecordV3(record)) return invalid()
        const pointId = record.key.scope.extensionPoints![0]!
        const expected = domPermissionAuthorizationKeyV3({
          profileId: input.profileId,
          identity: record.key.identity,
          pointId,
          catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
        })
        if (record.key.securityFingerprint !== expected.securityFingerprint) return invalid()
      }
      if (new Set(values.map(persistedPermissionRecordKey)).size !== values.length || !input.isCurrent()) {
        return invalid()
      }
      return values
    },
  })
}
