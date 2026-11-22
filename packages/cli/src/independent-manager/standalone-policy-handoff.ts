import type { CordisXPermissionPolicyRecordV3 } from '../permission-contracts.js'
import { normalizePermissionPolicyRecordV3, permissionRecordKeyV3 } from '../permission-model-v3.js'
import { mergePersistedPermissionPolicies } from '../permission-persistence.js'
import { isStandaloneDomReviewTarget } from '../standalone-permission-contract.js'

export interface StandalonePolicyHandoff {
  readonly rendererId: string
  readonly ownerGeneration: string
  readonly handoffId: string
  readonly requestId: string
  readonly origin: boolean
  readonly identity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly expected: readonly CordisXPermissionPolicyRecordV3[]
  readonly updates: readonly CordisXPermissionPolicyRecordV3[]
  readonly candidate: readonly CordisXPermissionPolicyRecordV3[]
}

/** Validate only a redacted, exact Channel Manager policy handoff for one renderer. */
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
    || !isStandaloneDomReviewTarget({ id: rawIdentity.id, source: rawIdentity.source }, 'manager.content')
  ) return invalid()
  const identity = { id: rawIdentity.id, source: rawIdentity.source }
  const policies = (input: unknown): readonly CordisXPermissionPolicyRecordV3[] => {
    if (!Array.isArray(input) || input.length > 64) return invalid()
    const seen = new Set<string>()
    return input.map(raw => {
      const record = normalizePermissionPolicyRecordV3(raw)
      const point = record.key.scope.extensionPoints?.[0]
      if (
        record.key.profileId !== scope.profileId || record.key.identity.pluginId !== identity.id
        || record.key.identity.source !== identity.source || record.key.scope.extensionPoints?.length !== 1
        || point === undefined || !isStandaloneDomReviewTarget(identity, point)
      ) return invalid()
      const key = permissionRecordKeyV3(record)
      if (seen.has(key)) return invalid()
      seen.add(key)
      return record
    })
  }
  const expected = policies(item.expected)
  const updates = policies(item.updates)
  const candidate = policies(item.candidate)
  const sorted = (records: readonly CordisXPermissionPolicyRecordV3[]) =>
    [...records].sort((left, right) => permissionRecordKeyV3(left).localeCompare(permissionRecordKeyV3(right)))
  if (
    updates.length === 0 || updates.length > 2
    || JSON.stringify(sorted(mergePersistedPermissionPolicies(expected, updates) as CordisXPermissionPolicyRecordV3[]))
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
