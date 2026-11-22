import type { CordisXPluginIdentity } from '../contracts.js'
import type { CordisXPermissionPolicyRecordV3 } from '../permission-contracts.js'
import {
  domPermissionAuthorizationKeyV3,
  normalizePermissionPolicyRecordV3,
  permissionRecordKeyV3,
} from '../permission-model-v3.js'
import { type CordisXPersistedPermissionPolicyRecord, isPermissionPolicyRecordV3 } from '../permission-persistence.js'
import { isStandaloneDomReviewTarget } from '../standalone-permission-contract.js'
import type { StandaloneDomPolicyAdoption } from '../standalone-permission-contract.js'

type Policy = { readonly key: string; readonly pointId: string; readonly record: CordisXPermissionPolicyRecordV3 }

/** Validate an owner-projected Channel Manager policy transition without changing runtime state. */
export function prepareStandaloneDomPolicyAdoption(input: {
  readonly profileId: string
  readonly identity: CordisXPluginIdentity
  readonly catalogVersion: string
  readonly current: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly expected: readonly unknown[]
  readonly updates: readonly unknown[]
  readonly candidate: readonly unknown[]
}): readonly Policy[] | undefined {
  const invalid = () => {
    throw new Error('standalone-policy-adoption-unavailable')
  }
  try {
    if (!isStandaloneDomReviewTarget(input.identity, 'manager.content')) invalid()
    const normalize = (records: readonly unknown[]): Map<string, Policy> => {
      if (!Array.isArray(records) || records.length > 64) invalid()
      const values = new Map<string, Policy>()
      for (const raw of records) {
        const record = normalizePermissionPolicyRecordV3(raw)
        const pointId = record.key.scope.extensionPoints?.[0]
        if (
          record.key.profileId !== input.profileId || record.key.identity.pluginId !== input.identity.id
          || record.key.identity.source !== input.identity.source || record.key.scope.extensionPoints?.length !== 1
          || pointId === undefined || !isStandaloneDomReviewTarget(input.identity, pointId)
        ) invalid()
        const key = permissionRecordKeyV3(record)
        if (values.has(key)) invalid()
        values.set(key, { key, pointId: pointId!, record })
      }
      return values
    }
    const expected = normalize(input.expected)
    const updates = normalize(input.updates)
    const candidate = normalize(input.candidate)
    const current = normalize(input.current.filter(record => {
      if (!isPermissionPolicyRecordV3(record)) return false
      const point = record.key.scope.extensionPoints?.[0]
      return record.key.profileId === input.profileId && record.key.identity.pluginId === input.identity.id
        && record.key.identity.source === input.identity.source && record.key.scope.extensionPoints?.length === 1
        && point !== undefined && isStandaloneDomReviewTarget(input.identity, point)
    }))
    const sorted = (records: Map<string, Policy>) =>
      [...records.values()].sort((a, b) => a.key.localeCompare(b.key)).map(value => value.record)
    if (JSON.stringify(sorted(current)) !== JSON.stringify(sorted(expected))) invalid()
    const merged = new Map(expected)
    for (const [key, value] of updates) merged.set(key, value)
    if (
      updates.size === 0 || updates.size > 2 || JSON.stringify(sorted(merged)) !== JSON.stringify(sorted(candidate))
    ) invalid()
    for (const value of updates.values()) {
      const canonical = domPermissionAuthorizationKeyV3({
        profileId: input.profileId,
        identity: { source: input.identity.source, pluginId: input.identity.id },
        pointId: value.pointId,
        catalogVersion: input.catalogVersion,
      })
      if (value.record.key.securityFingerprint !== canonical.securityFingerprint) invalid()
    }
    const changed: Policy[] = []
    for (const [key, value] of candidate) {
      if (JSON.stringify(expected.get(key)?.record) === JSON.stringify(value.record)) continue
      changed.push(value)
    }
    return changed
  } catch {
    return undefined
  }
}

/** Capture the session-bound handoff before touching the broker's live policies. */
export async function prepareStandaloneDomPolicyHandoff<
  Registration extends { readonly token: object; readonly generation: { readonly moduleGeneration?: string } },
>(
  input: StandaloneDomPolicyAdoption & { readonly signal?: AbortSignal },
  host: {
    readonly profileId: string
    readonly catalogVersion: string
    readonly registration: (identity: CordisXPluginIdentity) => Registration | undefined
    readonly isRegistered: (registration: Registration) => boolean
    readonly waitForWrite: () => Promise<void>
    readonly policies: () => readonly CordisXPersistedPermissionPolicyRecord[]
  },
): Promise<
  {
    readonly captured: StandaloneDomPolicyAdoption
    readonly registration: Registration
    readonly changes: readonly Policy[]
    readonly updates: readonly CordisXPermissionPolicyRecordV3[]
  } | undefined
> {
  try {
    if (
      input.signal?.aborted || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.requestId)
      || typeof input.origin !== 'boolean' || !Array.isArray(input.expected) || input.expected.length > 64
      || !Array.isArray(input.updates) || input.updates.length === 0 || input.updates.length > 2
      || !Array.isArray(input.candidate) || input.candidate.length > 64
    ) return undefined
    const captured: StandaloneDomPolicyAdoption = structuredClone({
      requestId: input.requestId,
      origin: input.origin,
      identity: input.identity,
      moduleGeneration: input.moduleGeneration,
      expected: input.expected,
      updates: input.updates,
      candidate: input.candidate,
    })
    const registration = host.registration(captured.identity)
    if (!registration || registration.generation.moduleGeneration !== captured.moduleGeneration) return undefined
    if (!captured.origin) await host.waitForWrite()
    if (
      input.signal?.aborted || host.registration(captured.identity)?.token !== registration.token
      || !host.isRegistered(registration)
    ) return undefined
    const changes = prepareStandaloneDomPolicyAdoption({
      profileId: host.profileId,
      identity: captured.identity,
      catalogVersion: host.catalogVersion,
      current: host.policies(),
      expected: captured.expected,
      updates: captured.updates,
      candidate: captured.candidate,
    })
    if (!changes) return undefined
    return {
      captured,
      registration,
      changes,
      updates: captured.updates.map(value => normalizePermissionPolicyRecordV3(value)),
    }
  } catch {
    return undefined
  }
}
