import type { PermissionDecisionHistoryItem, PluginAuthorizationHistoryItem } from '../permission-decision-history.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import { type PermissionDecisionJournal, permissionDecisionKey } from './permission-decision-journal.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2, CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../permission-contracts.js'
import { domPermissionAuthorizationKeyV3, normalizePermissionPolicyRecordV3 } from '../permission-model-v3.js'
import { normalizePermissionPolicyRecordV2, permissionSecurityFingerprint } from '../permission-model-v2.js'
import { manifestDeclarationsV2 } from '../renderer/platform/platform-permission-types.js'
import { normalizePluginManifest } from '../renderer/platform/platform-manifest.js'

/** Reconstruct ask keys from the owner-verified package without storing private scopes in the journal. */
export function withDeclaredRuntimeAskPolicies(
  records: readonly CordisXPersistedPermissionPolicyRecord[],
  profileId: string,
  identity: { readonly id: string; readonly source: string },
  manifest: unknown,
): readonly CordisXPersistedPermissionPolicyRecord[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return records
  const normalized = normalizePluginManifest(manifest, identity.id)
  if (normalized.schemaVersion === 1) return records
  const selected = new Map(records.map(record => [permissionDecisionKey(record), record]))
  for (const declaration of manifestDeclarationsV2(normalized)) {
    const candidate = normalizePermissionPolicyRecordV2({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2,
      key: {
        profileId,
        identity: { pluginId: identity.id, source: identity.source },
        capability: declaration.name,
        scope: declaration.scope,
        securityFingerprint: permissionSecurityFingerprint(CORDISX_CAPABILITY_CATALOG_VERSION, declaration),
      },
      policy: 'ask',
    })
    const key = permissionDecisionKey(candidate)
    if (!selected.has(key)) selected.set(key, candidate)
  }
  return [...selected.values()]
}

/** Show runtime origins without sending source paths or permission scopes to another client. */
export async function projectRuntimeDecisionHistory(
  journal: PermissionDecisionJournal,
  records: readonly CordisXPersistedPermissionPolicyRecord[],
): Promise<readonly PluginAuthorizationHistoryItem[]> {
  const selected = new Map(records.map(record => [permissionDecisionKey(record), record]))
  const events = await journal.recent(records)
  return events.filter(event => event.entry.lifecycle === undefined).flatMap(event => {
    const decisions = event.entry.changes.flatMap(change => {
      const record = selected.get(change.key)
      if (!record || change.pluginId !== record.key.identity.pluginId || change.capability !== record.key.capability) {
        return []
      }
      return [{ capability: change.capability, decision: change.policy }]
    })
    if (decisions.length === 0) return []
    return [{
      operation: 'runtime' as const,
      client: event.entry.client,
      requestedAt: event.entry.requestedAt,
      ...(event.committedAt === undefined ? {} : { committedAt: event.committedAt }),
      decisions,
    }]
  })
}

/** Include unsaved ask policies so one-time decisions can be found before any persistent write. */
export function withManagerDomAskPolicies(
  records: readonly CordisXPersistedPermissionPolicyRecord[],
  profileId: string,
  identity: { readonly id: string; readonly source: string },
): readonly CordisXPersistedPermissionPolicyRecord[] {
  const selected = new Map(records.map(record => [permissionDecisionKey(record), record]))
  for (const pointId of ['manager.settings.navigation-items', 'manager.content']) {
    const candidate = normalizePermissionPolicyRecordV3({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
      schemaVersion: 3,
      key: domPermissionAuthorizationKeyV3({
        profileId,
        identity: { pluginId: identity.id, source: identity.source },
        pointId,
        catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
      }),
      policy: 'ask',
    })
    const key = permissionDecisionKey(candidate)
    if (!selected.has(key)) selected.set(key, candidate)
  }
  return [...selected.values()]
}

/** Project only owner-selected identities; never return an owner's private source to a Web renderer. */
export async function projectPermissionDecisionHistory(input: {
  readonly journal: PermissionDecisionJournal
  readonly records: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly project: (
    record: CordisXPersistedPermissionPolicyRecord,
  ) => CordisXPersistedPermissionPolicyRecord | undefined
}): Promise<readonly PermissionDecisionHistoryItem[]> {
  const selected = new Map<string, {
    readonly owner: CordisXPersistedPermissionPolicyRecord
    readonly projected: CordisXPersistedPermissionPolicyRecord
  }>()
  for (const owner of input.records) {
    const projected = input.project(owner)
    if (!projected) continue
    const key = permissionDecisionKey(owner)
    if (selected.has(key)) throw new Error('permission-history-unavailable')
    selected.set(key, { owner, projected })
  }
  const events = await input.journal.recent([...selected.values()].map(item => item.owner))
  const result: PermissionDecisionHistoryItem[] = []
  for (const event of events) {
    for (const change of event.entry.changes) {
      const value = selected.get(change.key)
      if (
        !value || change.pluginId !== value.owner.key.identity.pluginId
        || change.capability !== value.owner.key.capability
      ) throw new Error('permission-history-unavailable')
      result.push({
        record: value.projected,
        decision: change.policy,
        client: event.entry.client,
        requestedAt: event.entry.requestedAt,
        ...(event.committedAt === undefined ? {} : { committedAt: event.committedAt }),
      })
    }
  }
  return result
}
