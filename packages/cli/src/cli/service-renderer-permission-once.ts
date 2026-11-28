import { parsePermissionBindingRequest } from '../launcher/permission-rpc.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../standalone-permission-contract.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'

/** Confirm a renderer-local one-time decision in the owner before it can create a lease. */
export function createServiceRendererPermissionOnce(input: {
  readonly profileId: string
  readonly bootstrap: ServiceRendererBootstrap
  readonly proof: ManagerPermissionProofAuthority
  readonly journal: PermissionDecisionJournal
}): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      if (
        typeof payload !== 'string' || Buffer.byteLength(payload) > 32 * 1024 || context.admitted !== true
        || context.signal.aborted || context.profileId !== input.profileId
      ) throw new Error('permission-once-unavailable')
      const raw: unknown = JSON.parse(payload)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('permission-once-unavailable')
      const item = raw as Record<string, unknown>
      if (
        Object.keys(item).length !== 5 || item.decision !== 'allow-once' && item.decision !== 'deny-once'
        || !Object.hasOwn(item, 'proof')
      ) throw new Error('permission-once-unavailable')
      const request = parsePermissionBindingRequest({
        token: item.token,
        requestId: item.requestId,
        records: [item.record],
      }, {
        token: STANDALONE_PERMISSION_BINDING_MARKER,
        profileId: input.profileId,
        identities: [],
        identityAllowed: identity => {
          const evidence = input.bootstrap.permissionAccess.evidence(context, identity.id)
          return evidence.identity.id === identity.id && evidence.identity.source === identity.source
        },
      })
      const rendererRecord = request.records[0]!
      const pluginId = rendererRecord.key.identity.pluginId
      const ownerRecords = input.bootstrap.permissionAccess.resolve(request.records, context)
      if (rendererRecord.policy !== 'ask' || ownerRecords.length !== 1) throw new Error('permission-once-unavailable')
      const choice = item.decision
      return {
        mode: 'write',
        dispatch: async () => {
          const evidence = input.bootstrap.permissionAccess.evidence(context, pluginId)
          const snapshot = input.bootstrap.permissionAccess.snapshot(context)
          const expected = input.bootstrap.permissionAccess.project(snapshot, context, pluginId)
          if (
            context.signal.aborted || !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
            || !input.proof.authorizeOnce({
              context,
              requestId: request.requestId,
              record: rendererRecord,
              decision: choice,
              expected,
              moduleGeneration: evidence.moduleGeneration,
              artifact: evidence.artifact,
              proof: item.proof,
            })
          ) throw new Error('permission-once-unavailable')
          const current = () =>
            !context.signal.aborted && input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
            && attachmentEqual(snapshot, input.bootstrap.permissionAccess.snapshot(context))
          const trace = await input.journal.begin({
            client: 'web',
            requestId: request.requestId,
            records: ownerRecords,
            onceDecision: choice,
          })
          if (!current()) throw new Error('permission-once-unavailable')
          await trace.commit()
          if (!current()) throw new Error('permission-once-unavailable')
          return { requestId: request.requestId, ok: true, value: true }
        },
      }
    },
  }
}
