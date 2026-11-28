import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import { projectPermissionDecisionHistory, withManagerDomAskPolicies } from './permission-decision-history.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'

/** Read the service ledger through the current Manager's owner-issued alias. */
export function createServiceRendererPermissionHistory(input: {
  readonly profileId: string
  readonly generation: string
  readonly bootstrap: ServiceRendererBootstrap
  readonly journal: PermissionDecisionJournal
}): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      if (
        typeof payload !== 'string' || Buffer.byteLength(payload) > 4096 || context.signal.aborted
        || context.profileId !== input.profileId || context.ownerGeneration !== input.generation
        || context.admitted !== true
      ) throw new Error('permission-history-unavailable')
      const value: unknown = JSON.parse(payload)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('permission-history-unavailable')
      const request = value as Record<string, unknown>
      if (
        Object.keys(request).some(key => !['requestId', 'pluginId', 'kind'].includes(key))
        || request.kind !== undefined && request.kind !== 'lifecycle' || typeof request.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId)
        || typeof request.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(request.pluginId)
      ) throw new Error('permission-history-unavailable')
      const requestId = request.requestId
      const pluginId = request.pluginId
      const evidence = input.bootstrap.permissionAccess.evidence(context, pluginId)
      return {
        mode: 'read',
        dispatch: async () => {
          if (context.signal.aborted || !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)) {
            throw new Error('permission-history-unavailable')
          }
          const snapshot = input.bootstrap.permissionAccess.snapshot(context)
          if (request.kind === 'lifecycle') {
            const result = await input.journal.recentLifecycle(evidence.ownerIdentity)
            if (
              context.signal.aborted || !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
              || !attachmentEqual(snapshot, input.bootstrap.permissionAccess.snapshot(context))
            ) throw new Error('permission-history-unavailable')
            return { requestId, ok: true, value: result }
          }
          const records = snapshot.filter(record =>
            record.key.identity.pluginId === evidence.ownerIdentity.id
            && record.key.identity.source === evidence.ownerIdentity.source
          )
          const result = await projectPermissionDecisionHistory({
            journal: input.journal,
            records: withManagerDomAskPolicies(records, input.profileId, evidence.ownerIdentity),
            project: record => input.bootstrap.permissionAccess.project([record], context, pluginId)[0],
          })
          if (
            context.signal.aborted || !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
            || !attachmentEqual(snapshot, input.bootstrap.permissionAccess.snapshot(context))
          ) throw new Error('permission-history-unavailable')
          return { requestId, ok: true, value: result }
        },
      }
    },
  }
}
