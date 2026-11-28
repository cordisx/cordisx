import { attachmentEqual, attachmentRecord } from '../launcher/renderer-lifecycle-peer.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { OwnerAdapterDocumentContext } from './owner-adapter-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import {
  projectPermissionDecisionHistory,
  projectRuntimeDecisionHistory,
  withDeclaredRuntimeAskPolicies,
  withManagerDomAskPolicies,
} from './permission-decision-history.js'

/** The native adapter can read only the current service profile while its session remains admitted. */
export function createOwnerAdapterPermissionHistory(input: {
  readonly profileId: string
  readonly journal: PermissionDecisionJournal
  readonly loadPolicies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
  readonly reviewIdentity?: (
    pluginId: string,
    context: OwnerAdapterDocumentContext,
  ) => Promise<
    {
      readonly identity: { readonly id: string; readonly source: string }
      readonly manifest?: unknown
      isCurrent(): boolean
      verifyCurrent?(): Promise<boolean>
    } | undefined
  >
}) {
  return async (value: unknown, context: OwnerAdapterDocumentContext) => {
    const operation = attachmentRecord(value)
    if (
      Object.keys(operation).length !== 2
      || operation.kind !== 'permission-history' && operation.kind !== 'plugin-authorization-history'
      || typeof operation.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(operation.pluginId)
      || !context.current(false)
    ) throw new Error('permission-history-unavailable')
    const before = await input.loadPolicies()
    if (before.some(record => record.key.profileId !== input.profileId)) {
      throw new Error('permission-history-unavailable')
    }
    let records = before.filter(record => record.key.identity.pluginId === operation.pluginId)
    const target = await input.reviewIdentity?.(operation.pluginId, context)
    if (input.reviewIdentity && !target) throw new Error('permission-history-unavailable')
    const targetCurrent = async () =>
      !target || target.isCurrent() && (target.verifyCurrent === undefined || await target.verifyCurrent())
    if (operation.kind === 'plugin-authorization-history') {
      if (!target || !await targetCurrent()) throw new Error('permission-history-unavailable')
      const lifecycle = await input.journal.recentLifecycle(target.identity)
      const exactRuntime = await input.journal.recentRuntime(target.identity)
      const runtime = await projectRuntimeDecisionHistory(
        input.journal,
        withDeclaredRuntimeAskPolicies([], input.profileId, target.identity, target.manifest),
      )
      const result = [...lifecycle, ...runtime, ...exactRuntime].sort((a, b) =>
        b.requestedAt.localeCompare(a.requestedAt)
      ).slice(0, 100)
      if (
        !context.current(false) || !attachmentEqual(before, await input.loadPolicies()) || !await targetCurrent()
      ) throw new Error('permission-history-unavailable')
      return result
    }
    if (target) {
      records = records.filter(record => record.key.identity.source === target.identity.source)
      records = [...withManagerDomAskPolicies(records, input.profileId, target.identity)]
      records = [...withDeclaredRuntimeAskPolicies(records, input.profileId, target.identity, target.manifest)]
    }
    const result = await projectPermissionDecisionHistory({
      journal: input.journal,
      records,
      project: record => record,
    })
    if (
      !context.current(false) || !attachmentEqual(before, await input.loadPolicies()) || !await targetCurrent()
    ) {
      throw new Error('permission-history-unavailable')
    }
    return result
  }
}
