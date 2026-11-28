import { CORDISX_PERMISSION_POLICY_SCHEMA_V2 } from '../permission-contracts.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
} from '../permission-contracts.js'
import type { DeferredPermissionDecision } from '../permission-deferral.js'
import { normalizePermissionPolicyRecordV2 } from '../permission-model-v2.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { ownerDeclaredRuntimePolicy } from './owner-adapter-runtime-declaration.js'
import { isServiceRendererModelManifest } from './service-renderer-model-manifest.js'
import type { ServiceRendererRuntimeGrants } from './service-renderer-runtime-grants.js'

/** Bind an already-validated lifecycle review to its exact candidate and owner artifact. */
export async function issueReviewedModelGrant(input: {
  readonly homeDir: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly grants?: ServiceRendererRuntimeGrants
  readonly decision:
    | CordisXPermissionAuthorizationDecisionV2
    | CordisXPermissionAuthorizationDecisionV4
    | DeferredPermissionDecision
  readonly current: () => boolean
}) {
  const { decision } = input
  if (!input.grants || decision.schemaVersion === 7 && decision.origin !== 'explicit-user') return undefined
  const model = decision.decisions.find(item => item.capability === 'models.read' && item.decision === 'allow-once')
  if (!model) return undefined
  const candidateId = decision.binding.requestId
  if (!candidateId) throw new Error('renderer-runtime-grant-unavailable')
  const candidate = await input.coordinator.store.loadCandidate(candidateId)
  const item = candidate.plugins.find(plugin => plugin.id === decision.identity.pluginId)
  if (!item?.enabled || item.moduleGeneration !== decision.binding.moduleGeneration || !input.current()) {
    throw new Error('renderer-runtime-grant-unavailable')
  }
  const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
  if (staged.identitySource !== decision.identity.source || !input.current()) {
    throw new Error('renderer-runtime-grant-unavailable')
  }
  if (!isServiceRendererModelManifest(staged.manifest.runtimeManifest, item.id)) return undefined
  const record = normalizePermissionPolicyRecordV2({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: {
      profileId: decision.profileId,
      identity: decision.identity,
      capability: model.capability,
      scope: model.scope,
      securityFingerprint: model.securityFingerprint,
    },
    policy: 'ask',
  })
  if (!ownerDeclaredRuntimePolicy({ manifest: staged.manifest.runtimeManifest, pluginId: item.id, record })) {
    throw new Error('renderer-runtime-grant-unavailable')
  }
  return input.grants.issueActivation({
    transactionId: candidateId,
    digest: item.digest,
    moduleGeneration: item.moduleGeneration,
    record,
  })
}
