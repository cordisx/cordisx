import { assertDeferredPermissionDecision, type DeferredPermissionPlan } from '../permission-deferral.js'
import { assertPermissionAuthorizationDecisionV2 } from '../permission-model-v2.js'
import { assertPermissionAuthorizationDecisionV4 } from '../permission-model-v4.js'
import type { PluginLifecycleBindingRequest } from '../launcher/plugin-lifecycle-rpc.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { OwnerAdapterManagementContext } from './owner-adapter-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import { beginLifecycleDecisionJournal } from './lifecycle-decision-journal.js'
import { issueReviewedModelGrant } from './service-renderer-reviewed-model-grant.js'
import type { ServiceRendererRuntimeGrants } from './service-renderer-runtime-grants.js'
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
  readonly runtimeGrants?: () => ServiceRendererRuntimeGrants | undefined
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
    const receipts = await beginLifecycleDecisionJournal({
      ...input,
      plan: review.plan,
      decision,
      client: 'codex',
      requestId: apply.requestId,
      current: context.live,
    })
    if (!context.live()) throw new Error('adapter-review-unavailable')
    const grants = input.runtimeGrants?.()
    const activationGrant = await issueReviewedModelGrant({
      homeDir: input.homeDir,
      coordinator: input.coordinator,
      ...(grants === undefined ? {} : { grants }),
      decision,
      current: context.live,
    })
    try {
      const result = await input.dispatch(request)
      const applied = !!result && typeof result === 'object' && 'outcome' in result && result.outcome === 'applied'
      activationGrant?.finish(applied)
      if (applied) { for (const receipt of receipts) await receipt.commit() }
      return result
    } catch (error) {
      activationGrant?.finish(false)
      throw error
    }
  }
}
