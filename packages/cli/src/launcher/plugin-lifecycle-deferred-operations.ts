import type {
  CordisXPluginActivationRecordV1,
  CordisXPluginLifecycleRequestV1,
  CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type {
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from '../permission-contracts.js'
import {
  type DeferredPermissionDecision,
  type DeferredPermissionPlan,
  deferValidatedPermissionPlan,
  deferValidatedV2PermissionPlan,
  withBundlePolicyIntent,
} from '../permission-deferral.js'
import { lifecycleDeferredPermissionPlan } from './plugin-lifecycle-deferred.js'
import { loadStagedPluginPackage } from './plugin-package.js'
import {
  authorizationPlanV4,
  changedTarget,
  classify,
  type HostPermissionLifecycleReviewV2Request,
  type HostPermissionLifecycleReviewV4Request,
  LifecycleFailure,
  resultBase,
  safeError,
  validateDecisionV4,
  validateDecisionV7,
} from './plugin-lifecycle-model.js'
import { PluginLifecycleCoordinatorTransaction } from './plugin-lifecycle-transaction.js'
import { PermissionReviewGate } from './permission-review-gate.js'

export abstract class PluginLifecycleCoordinatorDeferred extends PluginLifecycleCoordinatorTransaction {
  protected readonly permissionReviewGate = new PermissionReviewGate()
  abstract permissionReviewPlanV2(
    input: HostPermissionLifecycleReviewV2Request,
  ): Promise<CordisXPermissionAuthorizationPlanV2 | undefined>
  abstract permissionReviewPlanV4(
    input: HostPermissionLifecycleReviewV4Request,
  ): Promise<CordisXPermissionAuthorizationPlanV4 | undefined>

  async permissionReviewPlanV7(
    input: HostPermissionLifecycleReviewV4Request,
  ): Promise<DeferredPermissionPlan | undefined> {
    const current = await this.permissionReviewPlanV4(input)
    if (current !== undefined) return deferValidatedPermissionPlan(current)
    const v2 = await this.permissionReviewPlanV2(input)
    if (v2 !== undefined) return deferValidatedV2PermissionPlan(v2)
    const active = await this.store.loadActive()
    if (input.expectedRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const target = input.target
    const candidate = target.kind === 'candidate'
      ? await this.store.loadCandidate(target.candidateId)
      : this.mutationCandidate(active, 'enable', target.pluginId).candidate
    const pluginId = target.kind === 'candidate' ? changedTarget(active, candidate) : target.pluginId
    if (candidate.lastGoodRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const item = candidate.plugins.find(plugin => plugin.id === pluginId)
    if (item === undefined) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    const staged = await loadStagedPluginPackage(this.options.homeDir, item.digest).catch(error => {
      throw classify(error)
    })
    if (staged.manifest.runtimeManifest.schemaVersion !== 1) return undefined
    if (target.kind === 'enable') await this.store.writeCandidate(candidate)
    const operation = target.kind === 'enable'
      ? 'enable'
      : active.plugins.some(plugin => plugin.id === pluginId)
      ? 'update'
      : 'install'
    return lifecycleDeferredPermissionPlan(
      staged,
      operation,
      this.options.profileId,
      this.options.runtimeGeneration,
      item.moduleGeneration,
      candidate.transactionId!,
      await this.permissionPoliciesV2(),
      await this.permissionPoliciesV4(),
      undefined,
      await this.permissionPoliciesV1(),
    )
  }

  /** Applies a v7 review only after reloading and revalidating the bound candidate. */
  async applyPermissionReviewV7(input: {
    readonly requestId: string
    readonly profileId: string
    readonly runtimeGeneration: string
    readonly expectedRevision: number
    readonly decision: DeferredPermissionDecision
  }): Promise<CordisXPluginLifecycleResultV1> {
    return await this.permissionReviewGate.run(async () => await this.applyPermissionReviewV7Internal(input))
  }

  /** Bundle-coordinator-only: choices are derived from the reviewed exact member policy. */
  async applyBundlePermissionReviewV7(input: {
    readonly requestId: string
    readonly profileId: string
    readonly runtimeGeneration: string
    readonly expectedRevision: number
    readonly decision: DeferredPermissionDecision
  }, selections: Readonly<Record<string, 'allow' | 'deny'>>): Promise<CordisXPluginLifecycleResultV1> {
    return await this.permissionReviewGate.run(async () =>
      await this.applyPermissionReviewV7Internal(input, selections)
    )
  }

  private async applyPermissionReviewV7Internal(input: {
    readonly requestId: string
    readonly profileId: string
    readonly runtimeGeneration: string
    readonly expectedRevision: number
    readonly decision: DeferredPermissionDecision
  }, selections?: Readonly<Record<string, 'allow' | 'deny'>>): Promise<CordisXPluginLifecycleResultV1> {
    if (input.profileId !== this.options.profileId || input.runtimeGeneration !== this.options.runtimeGeneration) {
      throw new LifecycleFailure('stale-generation', safeError('stale-generation'), 'conflict')
    }
    const active = await this.store.loadActive()
    if (input.expectedRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const candidateId = input.decision.binding.requestId
    if (candidateId === undefined) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
    const operation = input.decision.operation
    if (operation === 'runtime') throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    const request = {
      requestId: input.requestId,
      profileId: input.profileId,
      runtimeGeneration: input.runtimeGeneration,
      operation: { kind: operation },
    }
    if (operation === 'install' || operation === 'update') {
      return await this.applyPackage(request, active, candidateId, input.decision, operation, selections)
    }
    return await this.applyStateMutationV4(request, active, candidateId, input.decision, selections)
  }

  protected async applyStateMutationV4(
    request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
      readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
    },
    active: CordisXPluginActivationRecordV1,
    candidateId: string,
    decision: CordisXPermissionAuthorizationDecisionV4 | DeferredPermissionDecision,
    bundlePolicySelections?: Readonly<Record<string, 'allow' | 'deny'>>,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const pluginId = decision.identity.pluginId
    const candidate = await this.store.loadCandidate(candidateId).catch(() => {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    })
    const before = active.plugins.find(plugin => plugin.id === pluginId)
    const after = candidate.plugins.find(plugin => plugin.id === pluginId)
    if (
      candidate.lastGoodRevision !== active.revision || before === undefined || before.enabled
      || after?.enabled !== true
      || before.digest !== after.digest || before.version !== after.version
      || before.moduleGeneration === after.moduleGeneration
      || candidate.plugins.length !== active.plugins.length
      || active.plugins.some(item =>
        item.id !== pluginId
        && JSON.stringify(item) !== JSON.stringify(candidate.plugins.find(next => next.id === item.id))
      )
    ) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const staged = await loadStagedPluginPackage(this.options.homeDir, after.digest).catch(error => {
      throw classify(error)
    })
    const plan = decision.schemaVersion === 7
      ? lifecycleDeferredPermissionPlan(
        staged,
        'enable',
        this.options.profileId,
        this.options.runtimeGeneration,
        after.moduleGeneration,
        candidateId,
        await this.permissionPoliciesV2(),
        await this.permissionPoliciesV4(),
        await this.certifiedPermission(staged),
        await this.permissionPoliciesV1(),
      )
      : authorizationPlanV4(
        staged,
        'enable',
        this.options.profileId,
        this.options.runtimeGeneration,
        after.moduleGeneration,
        candidateId,
        await this.permissionPoliciesV2(),
        await this.permissionPoliciesV4(),
        await this.certifiedPermission(staged),
      )
    const reviewedPlan = decision.schemaVersion === 7 && bundlePolicySelections !== undefined
      ? withBundlePolicyIntent(plan as DeferredPermissionPlan, new Set(Object.keys(bundlePolicySelections)))
      : plan
    if (decision.schemaVersion === 7) {
      if (plan.schemaVersion !== 7) throw new Error('permission plan version mismatch')
      validateDecisionV7(reviewedPlan as DeferredPermissionPlan, decision, bundlePolicySelections)
    } else {
      if (plan.schemaVersion !== 4) throw new Error('permission plan version mismatch')
      validateDecisionV4(plan, decision)
    }
    const affected = [pluginId]
    const formalCommitted = await this.activateWithAuthority({
      operation: 'enable',
      active,
      candidate,
      targetId: pluginId,
      staged,
      authorizationPlan: reviewedPlan,
      authorizationDecision: decision,
      ...(bundlePolicySelections === undefined ? {} : { bundlePolicySelections }),
    })
    if (formalCommitted !== undefined) {
      return {
        ...resultBase(request, formalCommitted, 'enable'),
        outcome: 'applied',
        scope: 'plugin-generation',
        affectedPluginIds: affected,
        transactionId: candidateId,
      }
    }
    try {
      await this.options.runtime.stage({
        transactionId: candidateId,
        operation: 'enable',
        previous: active,
        candidate,
        targetId: pluginId,
        affectedPluginIds: affected,
        package: staged,
        authorizationDecision: decision,
        ...(bundlePolicySelections === undefined ? {} : { bundlePolicySelections }),
      })
    } catch {
      await this.store.abortCandidate(candidateId)
      throw new LifecycleFailure('readiness-failed', safeError('readiness-failed'), 'rolled-back')
    }
    let committed: CordisXPluginActivationRecordV1
    try {
      committed = await this.store.commitCandidate(candidateId)
    } catch {
      await this.options.runtime.abort(candidateId).catch(() => undefined)
      await this.store.abortCandidate(candidateId)
      throw new LifecycleFailure('activation-failed', safeError('activation-failed'), 'rolled-back')
    }
    await this.options.runtime.commit(candidateId).catch(() => undefined)
    return {
      ...resultBase(request, committed, 'enable'),
      outcome: 'applied',
      scope: 'plugin-generation',
      affectedPluginIds: affected,
      transactionId: candidateId,
    }
  }
}
