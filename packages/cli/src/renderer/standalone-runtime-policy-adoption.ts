import { CapabilityRiskCatalog } from '../capability-risk-catalog.js'
import type { CordisXPluginIdentity } from '../contracts.js'
import type { CordisXCapabilityDeclarationV2, CordisXPermissionPolicyRecordV2 } from '../permission-contracts.js'
import {
  normalizePermissionPolicyRecordV2,
  normalizePermissionScopeV2,
  permissionRecordKeyV2,
  permissionSecurityFingerprint,
} from '../permission-model-v2.js'
import { type CordisXPersistedPermissionPolicyRecord, isPermissionPolicyRecordV2 } from '../permission-persistence.js'

/** Verify a generic policy handoff against the current plugin's declared capabilities. */
export function prepareStandaloneRuntimePolicyAdoption(input: {
  readonly profileId: string
  readonly identity: CordisXPluginIdentity
  readonly declarations: ReadonlyMap<string, CordisXCapabilityDeclarationV2>
  readonly catalog: CapabilityRiskCatalog
  readonly current: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly expected: readonly unknown[]
  readonly updates: readonly unknown[]
  readonly candidate: readonly unknown[]
}): readonly CordisXPermissionPolicyRecordV2[] | undefined {
  const invalid = (): never => {
    throw new Error('runtime-policy-adoption-unavailable')
  }
  try {
    const valid = (record: CordisXPermissionPolicyRecordV2): boolean => {
      const declaration = input.declarations.get(record.key.capability)
      if (
        !declaration || record.key.profileId !== input.profileId
        || record.key.identity.pluginId !== input.identity.id || record.key.identity.source !== input.identity.source
        || JSON.stringify(normalizePermissionScopeV2(declaration.scope)) !== JSON.stringify(record.key.scope)
        || permissionSecurityFingerprint(input.catalog.version, declaration) !== record.key.securityFingerprint
      ) return false
      const risk = input.catalog.get(declaration.name)
      return (record.policy !== 'allow-persistent' || risk.persistentAllow)
        && (record.policy !== 'deny-persistent' || risk.persistentDeny)
    }
    const normalize = (records: readonly unknown[]) => {
      if (!Array.isArray(records) || records.length > 64) return invalid()
      const values = new Map<string, CordisXPermissionPolicyRecordV2>()
      for (const raw of records) {
        const record = normalizePermissionPolicyRecordV2(raw)
        const key = permissionRecordKeyV2(record)
        if (!valid(record) || values.has(key)) return invalid()
        values.set(key, record)
      }
      return values
    }
    const expected = normalize(input.expected)
    const updates = normalize(input.updates)
    const candidate = normalize(input.candidate)
    const current = normalize(
      input.current.filter(record =>
        isPermissionPolicyRecordV2(record) && updates.has(permissionRecordKeyV2(record)) && valid(record)
      ),
    )
    const sorted = (items: Map<string, CordisXPermissionPolicyRecordV2>) =>
      [...items.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, record]) => record)
    if (
      updates.size !== 1 || [...expected.keys()].some(key => !updates.has(key))
      || JSON.stringify(sorted(current)) !== JSON.stringify(sorted(expected))
    ) return invalid()
    const merged = new Map(expected)
    for (const [key, value] of updates) merged.set(key, value)
    if (JSON.stringify(sorted(merged)) !== JSON.stringify(sorted(candidate))) return invalid()
    return [...updates.values()]
  } catch {
    return undefined
  }
}
