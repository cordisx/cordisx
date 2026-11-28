import type { PluginManagementRpcOperation } from '../launcher/management-rpc.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { LifecycleFailure } from '../launcher/plugin-lifecycle-model.js'
import { assertDeferredPermissionDecision, type DeferredPermissionDecision } from '../permission-deferral.js'
import type { PluginManagementService } from '../management/service.js'
import type { PluginManagementSnapshot } from '../management/contracts.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import { type ManagerRendererChannelContext, rejectedUndispatchedRendererWrite } from './manager-renderer-sessions.js'
import type { PermissionDecisionJournal } from './permission-decision-journal.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { beginLifecycleDecisionJournal } from './lifecycle-decision-journal.js'
import type { ServiceRendererRuntimeGrants } from './service-renderer-runtime-grants.js'
import { issueReviewedModelGrant } from './service-renderer-reviewed-model-grant.js'

/** Apply a trusted, session-bound Web review on the service lifecycle owner. */
export function createServiceRendererLifecycleReview(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly journal: PermissionDecisionJournal
  readonly proof: ManagerPermissionProofAuthority
  readonly bootstrap: ServiceRendererBootstrap
  readonly service: PluginManagementService
}) {
  return async (
    operation: Extract<PluginManagementRpcOperation, { readonly kind: 'plugin-review-apply' }>,
    requestId: string,
    context: ManagerRendererChannelContext,
  ): Promise<unknown> => {
    const reject = () => rejectedUndispatchedRendererWrite(requestId, 'unavailable')
    const entry = input.bootstrap.managementEntry(context)
    const plans = entry?.restricted?.plans
    const review = plans?.peekReview(operation.reviewToken)
    if (!entry?.confirmed || !entry.snapshot || !plans || !review || !entry.current()) return reject()
    const snapshot = entry.snapshot
    const current = () => {
      const next = input.bootstrap.managementEntry(context)
      return !context.signal.aborted && !!next?.confirmed && next.current() && next.restricted?.plans === plans
        && attachmentEqual(next.snapshot, snapshot) && snapshot.active.revision === review.activationRevision
    }
    let decision: DeferredPermissionDecision
    let receipts: readonly { commit(): Promise<void> }[]
    let activationGrant: ReturnType<ServiceRendererRuntimeGrants['issueActivation']> | undefined
    try {
      decision = operation.decision as DeferredPermissionDecision
      assertDeferredPermissionDecision(review.rendererPlan, decision)
      const management = await input.service.query()
      if (
        decision.origin !== 'explicit-user'
        || decision.decisions.some(item => item.decision !== 'allow-once' && item.decision !== 'deny-once')
        || management.revision !== review.managementRevision
        || management.activationRevision !== review.activationRevision
        || !await entry.unchanged() || !current()
        || !input.proof.authorizeLifecycle({
          context,
          requestId,
          reviewToken: operation.reviewToken,
          decision,
          proof: operation.proof,
        })
        || plans.takeReview(operation.reviewToken) !== review
      ) return reject()
      const ownerDecision: DeferredPermissionDecision = {
        ...decision,
        identity: review.ownerPlan.identity,
        binding: review.ownerPlan.binding,
      }
      assertDeferredPermissionDecision(review.ownerPlan, ownerDecision)
      decision = ownerDecision
      receipts = await beginLifecycleDecisionJournal({
        homeDir: input.homeDir,
        coordinator: input.coordinator,
        journal: input.journal,
        plan: review.ownerPlan,
        decision,
        client: 'web',
        requestId,
        current,
      })
      if (!current() || !await entry.unchanged()) return reject()
      activationGrant = await issueReviewedModelGrant({
        homeDir: input.homeDir,
        coordinator: input.coordinator,
        grants: input.bootstrap.permissionAccess.runtimeOnceGrants,
        decision,
        current,
      })
    } catch {
      activationGrant?.finish(false)
      return reject()
    }
    try {
      const result = await input.coordinator.applyPermissionReviewV7({
        requestId,
        profileId: input.profileId,
        runtimeGeneration: input.generation,
        expectedRevision: review.activationRevision,
        decision,
      })
      activationGrant?.finish(result.outcome === 'applied')
      if (result.outcome === 'applied') { for (const receipt of receipts) await receipt.commit() }
      const projection = await input.bootstrap.managementRequest(
        context,
        { kind: 'query' },
        async () => await input.service.query(),
      ) as PluginManagementSnapshot
      if (result.outcome === 'applied') {
        return {
          requestId,
          ok: true,
          value: { status: 'applied', request: review.intent, snapshot: projection, pendingActivation: false },
        }
      }
      return {
        requestId,
        ok: true,
        value: {
          status: 'rejected',
          request: review.intent,
          snapshot: projection,
          error: result.error ?? { code: 'operation-unavailable', message: 'The plugin operation was not applied.' },
        },
      }
    } catch (error) {
      activationGrant?.finish(false)
      if (error instanceof LifecycleFailure && (error.outcome === 'rejected' || error.outcome === 'conflict')) {
        return { requestId, ok: false, error: error.message }
      }
      // The owner fences an uncertain lifecycle result instead of retrying it.
      throw error
    }
  }
}
