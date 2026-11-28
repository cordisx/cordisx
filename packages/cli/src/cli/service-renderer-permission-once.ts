import { parsePermissionBindingRequest } from '../launcher/permission-rpc.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../standalone-permission-contract.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import {
  isPermissionPolicyRecordV2,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { ownerRuntimeDeclaration } from './owner-adapter-runtime-declaration.js'

/** Confirm a renderer-local one-time decision in the owner before it can create a lease. */
export function createServiceRendererPermissionOnce(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly bootstrap: ServiceRendererBootstrap
  readonly proof: ManagerPermissionProofAuthority
  readonly journal: PermissionDecisionJournal
  readonly loadPackage?: typeof loadStagedPluginPackage
}): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      if (
        typeof payload !== 'string' || Buffer.byteLength(payload) > 32 * 1024
        || context.signal.aborted || context.profileId !== input.profileId
      ) throw new Error('permission-once-unavailable')
      const initial = context.admitted !== true
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
          const evidence = initial
            ? input.bootstrap.permissionAccess.initialModel(context, identity.id).evidence
            : input.bootstrap.permissionAccess.evidence(context, identity.id)
          return evidence.identity.id === identity.id && evidence.identity.source === identity.source
        },
      })
      const rendererRecord = request.records[0]!
      const pluginId = rendererRecord.key.identity.pluginId
      if (
        rendererRecord.policy !== 'ask'
        || initial && (!isPermissionPolicyRecordV2(rendererRecord) || rendererRecord.key.capability !== 'models.read')
      ) throw new Error('permission-once-unavailable')
      const choice = item.decision as 'allow-once' | 'deny-once'
      return {
        mode: 'write',
        dispatch: async () => {
          const initialModel = initial ? input.bootstrap.permissionAccess.initialModel(context, pluginId) : undefined
          const evidence = initialModel?.evidence ?? input.bootstrap.permissionAccess.evidence(context, pluginId)
          const snapshot = initialModel?.snapshot ?? input.bootstrap.permissionAccess.snapshot(context)
          const current = () =>
            !context.signal.aborted && (initialModel
              ? initialModel.isCurrent()
              : input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
                && attachmentEqual(snapshot, input.bootstrap.permissionAccess.snapshot(context)))
          const verifyCurrent = async () => current() && (!initialModel || await initialModel.verifyCurrent())
          if (!await verifyCurrent()) throw new Error('permission-once-unavailable')
          let exactRuntime = false
          let ownerRecords: ReturnType<typeof input.bootstrap.permissionAccess.resolve>
          if (isPermissionPolicyRecordV2(rendererRecord)) {
            const staged = await (input.loadPackage ?? loadStagedPluginPackage)(input.homeDir, evidence.digest)
            if (
              !current()
              || staged.digest !== evidence.digest || staged.identitySource !== evidence.ownerIdentity.source
              || staged.manifest.id !== pluginId || staged.manifest.version !== evidence.artifact.version
              || (staged.artifactIntegrity ?? staged.digest) !== evidence.artifact.integrity
            ) throw new Error('permission-once-unavailable')
            exactRuntime = ownerRuntimeDeclaration({
              manifest: staged.manifest.runtimeManifest,
              pluginId,
              record: rendererRecord,
            }).exact
            if (initial && exactRuntime) throw new Error('permission-once-unavailable')
            ownerRecords = exactRuntime || initial
              ? [normalizePersistedPermissionPolicyRecord({
                ...rendererRecord,
                key: { ...rendererRecord.key, identity: { pluginId, source: evidence.ownerIdentity.source } },
              })]
              : input.bootstrap.permissionAccess.resolve(request.records, context)
          } else {
            ownerRecords = input.bootstrap.permissionAccess.resolve(request.records, context)
          }
          if (ownerRecords.length !== 1) throw new Error('permission-once-unavailable')
          const expected = exactRuntime || initial
            ? snapshot.filter(record =>
              persistedPermissionRecordKey(record) === persistedPermissionRecordKey(ownerRecords[0]!)
            )
              .map(record =>
                normalizePersistedPermissionPolicyRecord({
                  ...record,
                  key: { ...record.key, identity: { pluginId, source: evidence.identity.source } },
                })
              )
            : input.bootstrap.permissionAccess.project(snapshot, context, pluginId)
          const proofInput = {
            context,
            requestId: request.requestId,
            record: rendererRecord,
            decision: choice,
            expected,
            moduleGeneration: evidence.moduleGeneration,
            artifact: evidence.artifact,
            proof: item.proof,
          }
          if (
            !await verifyCurrent() || !(isPermissionPolicyRecordV2(rendererRecord)
              ? input.proof.authorizeWebRuntimeOnce({ ...proofInput, ...(initial ? { initial: true as const } : {}) })
              : !initial && input.proof.authorizeOnce(proofInput))
          ) throw new Error('permission-once-unavailable')
          const trace = await input.journal.begin({
            client: 'web',
            requestId: request.requestId,
            records: ownerRecords,
            onceDecision: choice,
            ...(exactRuntime ? { runtimeIndex: true as const } : {}),
          })
          if (!await verifyCurrent()) throw new Error('permission-once-unavailable')
          await trace.commit()
          if (!await verifyCurrent()) throw new Error('permission-once-unavailable')
          if (
            choice === 'allow-once' && isPermissionPolicyRecordV2(ownerRecords[0]!)
            && ownerRecords[0]!.key.capability === 'models.read'
          ) {
            input.bootstrap.permissionAccess.runtimeOnceGrants.issue(context, {
              requestId: request.requestId,
              record: ownerRecords[0]!,
              moduleGeneration: evidence.moduleGeneration,
              current,
              ...(initial ? { initial: true as const } : {}),
            })
          }
          return { requestId: request.requestId, ok: true, value: true }
        },
      }
    },
  }
}
