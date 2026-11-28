import type { CordisXPermissionPolicyRecordV2, CordisXPermissionPolicyRecordV3 } from '../permission-contracts.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  mergePersistedPermissionPolicies,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import { isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'

type Policy = CordisXPermissionPolicyRecordV2 | CordisXPermissionPolicyRecordV3

export interface StandalonePolicyHandoff {
  readonly rendererId: string
  readonly ownerGeneration: string
  readonly handoffId: string
  readonly requestId: string
  readonly origin: boolean
  readonly identity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly expected: readonly Policy[]
  readonly updates: readonly Policy[]
  readonly candidate: readonly Policy[]
}

/** Validate a redacted, exact policy handoff for one renderer. */
export function parseStandalonePolicyHandoff(
  value: unknown,
  scope: { readonly profileId: string; readonly generation: string; readonly rendererId: string },
): StandalonePolicyHandoff {
  const invalid = (): never => {
    throw new Error('standalone-policy-handoff-invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  const keys = [
    'rendererId',
    'ownerGeneration',
    'handoffId',
    'requestId',
    'origin',
    'identity',
    'moduleGeneration',
    'expected',
    'updates',
    'candidate',
  ]
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.rendererId !== scope.rendererId || item.ownerGeneration !== scope.generation
    || typeof item.handoffId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.handoffId)
    || typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(item.requestId)
    || typeof item.origin !== 'boolean'
    || typeof item.moduleGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.moduleGeneration)
    || !item.identity || typeof item.identity !== 'object' || Array.isArray(item.identity)
  ) return invalid()
  const rawIdentity = item.identity as Record<string, unknown>
  if (
    Object.keys(rawIdentity).length !== 2 || typeof rawIdentity.id !== 'string'
    || typeof rawIdentity.source !== 'string'
    || !isStandaloneManagerDomTarget({ id: rawIdentity.id, source: rawIdentity.source }, 'manager.content')
  ) return invalid()
  const identity = { id: rawIdentity.id, source: rawIdentity.source }
  const policies = (input: unknown): readonly Policy[] => {
    if (!Array.isArray(input) || input.length > 64) return invalid()
    const seen = new Set<string>()
    return input.map(raw => {
      const record = normalizePersistedPermissionPolicyRecord(raw)
      if (
        !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record)
        || record.key.profileId !== scope.profileId || record.key.identity.pluginId !== identity.id
        || record.key.identity.source !== identity.source
      ) return invalid()
      if (isPermissionPolicyRecordV3(record)) {
        const point = record.key.scope.extensionPoints?.[0]
        if (
          record.key.scope.extensionPoints?.length !== 1 || point === undefined
          || !isStandaloneManagerDomTarget(identity, point)
        ) return invalid()
      }
      const key = persistedPermissionRecordKey(record)
      if (seen.has(key)) return invalid()
      seen.add(key)
      return record
    })
  }
  const expected = policies(item.expected)
  const updates = policies(item.updates)
  const candidate = policies(item.candidate)
  const sorted = (records: readonly Policy[]) =>
    [...records].sort((left, right) =>
      persistedPermissionRecordKey(left).localeCompare(persistedPermissionRecordKey(right))
    )
  if (
    updates.length === 0 || updates.length > 2
    || isPermissionPolicyRecordV2(updates[0]) && updates.length !== 1
    || [...expected, ...updates, ...candidate].some(record => record.schemaVersion !== updates[0]!.schemaVersion)
    || JSON.stringify(sorted(mergePersistedPermissionPolicies(expected, updates) as Policy[]))
      !== JSON.stringify(sorted(candidate))
  ) return invalid()
  return {
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    handoffId: item.handoffId,
    requestId: item.requestId,
    origin: item.origin,
    identity,
    moduleGeneration: item.moduleGeneration,
    expected,
    updates,
    candidate,
  }
}
