import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { isPermissionPolicyRecordV2, normalizePersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'
import { type PermissionDecisionJournal, permissionDecisionKey } from './permission-decision-journal.js'
import {
  projectPermissionDecisionHistory,
  projectRuntimeDecisionHistory,
  withDeclaredRuntimeAskPolicies,
  withManagerDomAskPolicies,
} from './permission-decision-history.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'

/** Read the service ledger through the current Manager's owner-issued alias. */
export function createServiceRendererPermissionHistory(input: {
  readonly homeDir: string
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
      if (request.kind === 'lifecycle') {
        const identity = input.bootstrap.permissionAccess.historyIdentity(context, pluginId)
        return {
          mode: 'read',
          dispatch: async () => {
            if (context.signal.aborted || !identity.isCurrent()) throw new Error('permission-history-unavailable')
            const snapshot = input.bootstrap.permissionAccess.snapshot(context)
            const lifecycle = await input.journal.recentLifecycle(identity.ownerIdentity)
            const exactRuntime = await input.journal.recentRuntime(identity.ownerIdentity)
            let evidence: ReturnType<typeof input.bootstrap.permissionAccess.evidence> | undefined
            try {
              evidence = input.bootstrap.permissionAccess.evidence(context, pluginId)
            } catch { /* Disabled or unavailable packages still expose their lifecycle history. */ }
            let runtime: Awaited<ReturnType<typeof projectRuntimeDecisionHistory>> = []
            if (evidence) {
              const staged = await loadStagedPluginPackage(input.homeDir, evidence.digest)
              if (
                !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
                || !attachmentEqual(evidence.ownerIdentity, identity.ownerIdentity)
                || staged.digest !== evidence.digest || staged.manifest.id !== evidence.ownerIdentity.id
                || staged.identitySource !== evidence.ownerIdentity.source
                || staged.manifest.version !== evidence.artifact.version
                || (staged.artifactIntegrity ?? staged.digest) !== evidence.artifact.integrity
              ) throw new Error('permission-history-unavailable')
              runtime = await projectRuntimeDecisionHistory(
                input.journal,
                withDeclaredRuntimeAskPolicies(
                  [],
                  input.profileId,
                  evidence.ownerIdentity,
                  staged.manifest.runtimeManifest,
                ),
              )
            }
            if (
              context.signal.aborted || !identity.isCurrent()
              || evidence && !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
              || !attachmentEqual(snapshot, input.bootstrap.permissionAccess.snapshot(context))
            ) throw new Error('permission-history-unavailable')
            const result = [...lifecycle, ...runtime, ...exactRuntime].sort((a, b) =>
              b.requestedAt.localeCompare(a.requestedAt)
            ).slice(
              0,
              100,
            )
            return { requestId, ok: true, value: result }
          },
        }
      }
      const evidence = input.bootstrap.permissionAccess.evidence(context, pluginId)
      return {
        mode: 'read',
        dispatch: async () => {
          if (context.signal.aborted || !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)) {
            throw new Error('permission-history-unavailable')
          }
          const snapshot = input.bootstrap.permissionAccess.snapshot(context)
          const records = snapshot.filter(record =>
            record.key.identity.pluginId === evidence.ownerIdentity.id
            && record.key.identity.source === evidence.ownerIdentity.source
          )
          const staged = await loadStagedPluginPackage(input.homeDir, evidence.digest)
          if (
            !input.bootstrap.permissionAccess.isCurrentEvidence(evidence)
            || staged.digest !== evidence.digest || staged.manifest.id !== evidence.ownerIdentity.id
            || staged.identitySource !== evidence.ownerIdentity.source
            || staged.manifest.version !== evidence.artifact.version
            || (staged.artifactIntegrity ?? staged.digest) !== evidence.artifact.integrity
          ) throw new Error('permission-history-unavailable')
          // This is a read-only history projection, not a policy grant. Only
          // exact declarations in the owner-verified manifest may be shown;
          // request-specific paths, sessions and accounts stay in the owner.
          const declared = withDeclaredRuntimeAskPolicies(
            [],
            input.profileId,
            evidence.ownerIdentity,
            staged.manifest.runtimeManifest,
          )
          const declaredKeys = new Set(declared.map(permissionDecisionKey))
          const result = await projectPermissionDecisionHistory({
            journal: input.journal,
            records: withDeclaredRuntimeAskPolicies(
              withManagerDomAskPolicies(records, input.profileId, evidence.ownerIdentity),
              input.profileId,
              evidence.ownerIdentity,
              staged.manifest.runtimeManifest,
            ),
            project: record => {
              if (!isPermissionPolicyRecordV2(record)) {
                return input.bootstrap.permissionAccess.project([record], context, pluginId)[0]
              }
              if (!declaredKeys.has(permissionDecisionKey(record))) return undefined
              return normalizePersistedPermissionPolicyRecord({
                ...record,
                key: { ...record.key, identity: { ...record.key.identity, source: evidence.identity.source } },
              })
            },
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
