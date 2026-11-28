import { attachmentEqual, attachmentRecord } from '../launcher/renderer-lifecycle-peer.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { OwnerAdapterDocumentContext } from './owner-adapter-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import { projectPermissionDecisionHistory, withManagerDomAskPolicies } from './permission-decision-history.js'

/** The native adapter can read only the current service profile while its session remains admitted. */
export function createOwnerAdapterPermissionHistory(input: {
  readonly profileId: string
  readonly journal: PermissionDecisionJournal
  readonly loadPolicies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
  readonly reviewIdentity?: (
    pluginId: string,
    context: OwnerAdapterDocumentContext,
  ) => Promise<
    { readonly identity: { readonly id: string; readonly source: string }; isCurrent(): boolean } | undefined
  >
}) {
  return async (value: unknown, context: OwnerAdapterDocumentContext) => {
    const operation = attachmentRecord(value)
    if (
      Object.keys(operation).length !== 2 || operation.kind !== 'permission-history'
      || typeof operation.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(operation.pluginId)
      || !context.current(false)
    ) throw new Error('permission-history-unavailable')
    const before = await input.loadPolicies()
    if (before.some(record => record.key.profileId !== input.profileId)) {
      throw new Error('permission-history-unavailable')
    }
    let records = before.filter(record => record.key.identity.pluginId === operation.pluginId)
    const target = await input.reviewIdentity?.(operation.pluginId, context)
    if (target) records = [...withManagerDomAskPolicies(records, input.profileId, target.identity)]
    const result = await projectPermissionDecisionHistory({
      journal: input.journal,
      records,
      project: record => record,
    })
    if (
      !context.current(false) || target && !target.isCurrent() || !attachmentEqual(before, await input.loadPolicies())
    ) {
      throw new Error('permission-history-unavailable')
    }
    return result
  }
}
