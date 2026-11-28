import { CORDISX_PERMISSION_POLICY_SCHEMA_V2, CORDISX_PERMISSION_POLICY_SCHEMA_V4 } from '../permission-contracts.js'
import type { CordisXCapabilityScope, CordisXPlatformCapability } from '../platform-contracts.js'
import { assertDeferredPermissionDecision, type DeferredPermissionPlan } from '../permission-deferral.js'
import { assertPermissionAuthorizationDecisionV2, normalizePermissionPolicyRecordV2 } from '../permission-model-v2.js'
import {
  assertPermissionAuthorizationDecisionV4,
  isHostDomPermissionCapability,
  normalizePermissionPolicyRecordV4,
} from '../permission-model-v4.js'
import { createPermissionPolicyRecord } from '../permissions.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { PluginLifecycleBindingRequest } from '../launcher/plugin-lifecycle-rpc.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import type { OwnerAdapterManagementContext } from './owner-adapter-sessions.js'
import type { PermissionDecisionChoice, PermissionDecisionJournal } from './permission-decision-journal.js'
import type {
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from '../permission-contracts.js'

type Plan = CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4 | DeferredPermissionPlan
type Review = { readonly plan: Plan; readonly revision: number; readonly expires: number }
type Apply = Extract<PluginLifecycleBindingRequest, { readonly kind: `permission-review-apply-v${number}` }>

/** Retain the exact service-issued review only for the authenticated originating adapter. */
export function createOwnerAdapterLifecycleReview(input: {
  readonly homeDir: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly journal: PermissionDecisionJournal
  readonly dispatch: (request: PluginLifecycleBindingRequest) => Promise<unknown>
  readonly now?: () => number
}) {
  const reviews = new Map<string, { readonly signal: AbortSignal; readonly entries: Map<string, Review> }>()
  const now = input.now ?? Date.now
  const key = (plan: Pick<Plan, 'planId' | 'schemaVersion' | 'binding'>) =>
    JSON.stringify([plan.schemaVersion, plan.planId, plan.binding.requestId, plan.binding.moduleGeneration])
  const session = (context: OwnerAdapterManagementContext) => {
    let entry = reviews.get(context.rendererId)
    if (entry && entry.signal !== context.signal) throw new Error('adapter-review-unavailable')
    if (!entry) {
      entry = { signal: context.signal, entries: new Map() }
      reviews.set(context.rendererId, entry)
      const captured = entry
      context.signal.addEventListener('abort', () => {
        if (reviews.get(context.rendererId) === captured) reviews.delete(context.rendererId)
      }, { once: true })
    }
    return entry.entries
  }
  return async (request: PluginLifecycleBindingRequest, context: OwnerAdapterManagementContext): Promise<unknown> => {
    if (!context.live()) throw new Error('adapter-review-unavailable')
    if (request.kind.startsWith('permission-review-plan-')) {
      const result = await input.dispatch(request) as Plan | undefined
      if (!context.live()) throw new Error('adapter-review-unavailable')
      if (result) {
        const entries = session(context)
        const issuedAt = now()
        for (const [id, item] of entries) if (item.expires < issuedAt) entries.delete(id)
        if (entries.size >= 16) entries.delete(entries.keys().next().value!)
        const revision = (request as Extract<PluginLifecycleBindingRequest, {
          readonly kind: `permission-review-plan-v${number}`
        }>).request.expectedRevision
        entries.set(key(result), { plan: structuredClone(result), revision, expires: issuedAt + 15 * 60_000 })
      }
      return result
    }
    if (!request.kind.startsWith('permission-review-apply-')) return await input.dispatch(request)
    const apply = request as Apply
    const decision = apply.request.decision
    const entries = session(context)
    const review = entries.get(key(decision))
    if (!review || review.revision !== apply.request.expectedRevision || review.expires < now()) {
      throw new Error('adapter-review-unavailable')
    }
    entries.delete(key(review.plan))
    if (review.plan.schemaVersion === 7 && decision.schemaVersion === 7) {
      assertDeferredPermissionDecision(review.plan, decision)
    } else if (review.plan.schemaVersion === 4 && decision.schemaVersion === 4) {
      assertPermissionAuthorizationDecisionV4(review.plan, decision)
    } else if (review.plan.schemaVersion === 2 && decision.schemaVersion === 2) {
      assertPermissionAuthorizationDecisionV2(review.plan, decision)
    } else {
      throw new Error('adapter-review-unavailable')
    }
    // Host-derived no-decision activations are not attributed to a user action.
    if (decision.schemaVersion === 7 && decision.origin !== 'explicit-user') return await input.dispatch(request)
    const selected = decision.decisions.filter(choice =>
      review.plan.declarations.some(item => item.capability === choice.capability && item.decisionRequired)
    )
    if (selected.length === 0) return await input.dispatch(request)
    const candidateId = decision.binding.requestId
    if (!candidateId || !['install', 'update', 'enable'].includes(decision.operation)) {
      throw new Error('adapter-review-unavailable')
    }
    const candidate = await input.coordinator.store.loadCandidate(candidateId)
    const item = candidate.plugins.find(plugin => plugin.id === decision.identity.pluginId)
    if (!item || item.moduleGeneration !== decision.binding.moduleGeneration) {
      throw new Error('adapter-review-unavailable')
    }
    const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
    if (staged.identitySource !== decision.identity.source || !context.live()) {
      throw new Error('adapter-review-unavailable')
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
        ? normalizePermissionPolicyRecordV4({
          ...record,
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
          schemaVersion: 4,
        })
        : normalizePermissionPolicyRecordV2({
          ...record,
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
          schemaVersion: 2,
        })
    }) satisfies CordisXPersistedPermissionPolicyRecord[]
    const receipts: Array<{ commit(): Promise<void> }> = []
    for (let index = 0; index < records.length; index += 23) {
      receipts.push(
        await input.journal.begin({
          client: 'codex',
          requestId: apply.requestId,
          records: records.slice(index, index + 23),
          lifecycle: {
            operation: decision.operation as 'install' | 'update' | 'enable',
            decisions: selected.slice(index, index + 23).map(choice => choice.decision as PermissionDecisionChoice),
          },
        }),
      )
    }
    if (!context.live()) throw new Error('adapter-review-unavailable')
    const result = await input.dispatch(request)
    if (result && typeof result === 'object' && 'outcome' in result && result.outcome === 'applied') {
      for (const receipt of receipts) await receipt.commit()
    }
    return result
  }
}
