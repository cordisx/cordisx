import { CORDISX_PERMISSION_POLICY_SCHEMA_V2, CORDISX_PERMISSION_POLICY_SCHEMA_V4 } from '../permission-contracts.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from '../permission-contracts.js'
import type { CordisXCapabilityScope, CordisXPlatformCapability } from '../platform-contracts.js'
import type { DeferredPermissionDecision, DeferredPermissionPlan } from '../permission-deferral.js'
import { normalizePermissionPolicyRecordV2 } from '../permission-model-v2.js'
import { isHostDomPermissionCapability, normalizePermissionPolicyRecordV4 } from '../permission-model-v4.js'
import { createPermissionPolicyRecord } from '../permissions.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import type {
  PermissionDecisionChoice,
  PermissionDecisionClient,
  PermissionDecisionJournal,
} from './permission-decision-journal.js'

type Plan = CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4 | DeferredPermissionPlan
type Decision =
  | CordisXPermissionAuthorizationDecisionV2
  | CordisXPermissionAuthorizationDecisionV4
  | DeferredPermissionDecision

/** Record only decisions already checked against an exact owner-issued lifecycle plan. */
export async function beginLifecycleDecisionJournal(input: {
  readonly homeDir: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly journal: PermissionDecisionJournal
  readonly plan: Plan
  readonly decision: Decision
  readonly client: PermissionDecisionClient
  readonly requestId: string
  readonly current: () => boolean
}): Promise<readonly { commit(): Promise<void> }[]> {
  const { plan, decision } = input
  if (decision.schemaVersion === 7 && decision.origin !== 'explicit-user') return []
  const selected = decision.decisions.filter(choice =>
    plan.declarations.some(item => item.capability === choice.capability && item.decisionRequired)
  )
  if (selected.length === 0) return []
  const candidateId = decision.binding.requestId
  if (!candidateId || !['install', 'update', 'enable'].includes(decision.operation)) {
    throw new Error('lifecycle-review-journal-unavailable')
  }
  const candidate = await input.coordinator.store.loadCandidate(candidateId)
  const item = candidate.plugins.find(plugin => plugin.id === decision.identity.pluginId)
  if (!item || item.moduleGeneration !== decision.binding.moduleGeneration) {
    throw new Error('lifecycle-review-journal-unavailable')
  }
  const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
  if (staged.identitySource !== decision.identity.source || !input.current()) {
    throw new Error('lifecycle-review-journal-unavailable')
  }
  const records = selected.map(choice => {
    const policy = choice.decision === 'allow-once' || choice.decision === 'deny-once' ? 'ask' : choice.decision
    if (staged.manifest.runtimeManifest.schemaVersion === 1) {
      return createPermissionPolicyRecord({
        profileId: decision.profileId,
        identity: { id: decision.identity.pluginId, source: decision.identity.source },
        capability: choice.capability as CordisXPlatformCapability,
        scope: choice.scope as CordisXCapabilityScope,
        policy: policy === 'allow-persistent' ? 'allow' : policy === 'deny-persistent' ? 'deny' : 'ask',
      })
    }
    const record = {
      key: {
        profileId: decision.profileId,
        identity: decision.identity,
        capability: choice.capability,
        scope: choice.scope,
        securityFingerprint: choice.securityFingerprint,
      },
      policy,
    }
    return isHostDomPermissionCapability(choice.capability)
      ? normalizePermissionPolicyRecordV4({ ...record, $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4, schemaVersion: 4 })
      : normalizePermissionPolicyRecordV2({ ...record, $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2, schemaVersion: 2 })
  }) satisfies CordisXPersistedPermissionPolicyRecord[]
  const receipts: Array<{ commit(): Promise<void> }> = []
  for (let index = 0; index < records.length; index += 23) {
    receipts.push(
      await input.journal.begin({
        client: input.client,
        requestId: input.requestId,
        records: records.slice(index, index + 23),
        lifecycle: {
          operation: decision.operation as 'install' | 'update' | 'enable',
          decisions: selected.slice(index, index + 23).map(choice => choice.decision as PermissionDecisionChoice),
        },
      }),
    )
  }
  if (!input.current()) throw new Error('lifecycle-review-journal-unavailable')
  return receipts
}
