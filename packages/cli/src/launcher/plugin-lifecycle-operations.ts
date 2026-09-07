import { createHash, randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
  type CordisXPermissionPolicyRecordV1,
  type CordisXPluginIdentity,
} from '../platform-contracts.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
  type CordisXPluginActivationItemV1,
  type CordisXPluginActivationRecordV1,
  type CordisXPluginLifecycleErrorCode,
  type CordisXPluginLifecyclePackageSummaryV1,
  type CordisXPluginLifecycleRequestV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import {
  createPermissionPolicyRecord,
  normalizePermissionScope,
  permissionRecordKey,
  permissionScopeFingerprint,
} from '../permissions.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
  type CordisXCapabilityDeclarationV4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV4,
  type CordisXPermissionDecisionV2,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyRecordV4,
  type CordisXPluginManifestV7,
  type CordisXPluginManifestV8,
} from '../permission-contracts.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV4,
} from '../permission-persistence.js'
import {
  buildPermissionAuthorizationPlanV2,
  buildPermissionAuthorizationPlanV4,
  CapabilityRiskCatalog,
} from '../capability-risk-catalog.js'
import { assertPermissionAuthorizationDecisionV2, normalizePluginManifestV4 } from '../permission-model-v2.js'
import {
  assertPermissionAuthorizationDecisionV4,
  normalizeCertifiedPermissionProjectionV1,
  normalizePluginManifestV5,
  normalizePluginManifestV6,
  normalizePluginManifestV7,
  normalizePluginManifestV8,
} from '../permission-model-v4.js'
import {
  PluginActivationStore,
  pluginDependentClosure,
  topologicalPluginOrder,
  validatePluginActivationGraph,
} from './plugin-activation.js'
import {
  loadStagedPluginPackage,
  runtimeManifestV1,
  type StagedPluginPackage,
  stageLocalPluginPackage,
} from './plugin-package.js'
import { stagePluginPackageSourceV1 } from './packages/delivery.js'
import type { PluginPackageSourceV1 } from './packages/source.js'
import {
  type CandidateAccess,
  createHostPermissionReviewAuthority,
  createHostRegistryReceiptAuthority,
  PackageLifecycleAuthority,
  type PreparedCandidate,
  type RollbackAccess,
} from './packages/authority.js'
import type { PackageCandidatePlan, PackageRuntimeObservation } from './packages/types.js'
import type { RollbackPlan } from './packages/authority.js'
import {
  loadPluginGenerationArtifact,
  loadPluginGenerationArtifactForRuntime,
  type PluginGenerationArtifactServer,
  type PluginGenerationGraphLease,
} from './plugin-generation-loader.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'

import { PluginLifecycleCoordinatorTransaction } from './plugin-lifecycle-transaction.js'
import {
  allowedDecision,
  allowedDecisionV2,
  allowedDecisionV4,
  authorizationPlan,
  authorizationPlanV2,
  authorizationPlanV4,
  changedTarget,
  classify,
  type CoordinatorOptions,
  equalScope,
  type HostPermissionLifecycleApplyV2Request,
  type HostPermissionLifecycleApplyV4Request,
  type HostPermissionLifecycleReviewV2Request,
  type HostPermissionLifecycleReviewV4Request,
  identity,
  impactToken,
  isLegacyPermissionDeclarationV4,
  LifecycleFailure,
  packageSummary,
  type PendingPermissionReview,
  type PluginLifecycleRuntime,
  type PluginRuntimeMutation,
  resultBase,
  type RuntimeCleanupObservation,
  type RuntimeGenerationFence,
  runtimeObservation,
  type RuntimePublicationObservation,
  type RuntimeReadinessObservation,
  safeError,
  usesIsolatedWorker,
  validateDecision,
  validateDecisionV2,
  validateDecisionV4,
  withGenerations,
} from './plugin-lifecycle-model.js'

export class PluginLifecycleCoordinator extends PluginLifecycleCoordinatorTransaction {
  /** Bundle coordinator-only path; claim enforcement remains active for ordinary Manager operations. */
  async handleBundleOperation(request: CordisXPluginLifecycleRequestV1): Promise<CordisXPluginLifecycleResultV1> {
    return await this.handleRequest(request, true)
  }

  protected async summaryFor(item: CordisXPluginActivationItemV1): Promise<CordisXPluginLifecyclePackageSummaryV1> {
    return packageSummary(await loadStagedPluginPackage(this.options.homeDir, item.digest))
  }

  /** Host-private review lookup; no new public lifecycle protocol surface. */
  async permissionReviewPlanV2(
    input: HostPermissionLifecycleReviewV2Request,
  ): Promise<CordisXPermissionAuthorizationPlanV2 | undefined> {
    if (input.profileId !== this.options.profileId || input.runtimeGeneration !== this.options.runtimeGeneration) {
      throw new LifecycleFailure('stale-generation', safeError('stale-generation'), 'conflict')
    }
    const active = await this.store.loadActive()
    if (input.expectedRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const reviewTarget = input.target
    if (reviewTarget.kind === 'candidate') {
      const candidate = await this.store.loadCandidate(reviewTarget.candidateId)
      if (candidate.lastGoodRevision !== active.revision) {
        throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
      }
      const pluginId = changedTarget(active, candidate)
      const existing = active.plugins.some(plugin => plugin.id === pluginId)
      const operation = existing ? 'update' : 'install'
      const target = candidate.plugins.find(plugin => plugin.id === pluginId)!
      const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => {
        throw classify(error)
      })
      if (staged.manifest.runtimeManifest.schemaVersion !== 4) return undefined
      return authorizationPlanV2(
        staged,
        operation,
        this.options.profileId,
        this.options.runtimeGeneration,
        target.moduleGeneration,
        reviewTarget.candidateId,
        await this.permissionPoliciesV2(),
      )
    }
    const pluginId = reviewTarget.pluginId
    const activeTarget = active.plugins.find(plugin => plugin.id === pluginId)
    if (activeTarget === undefined || activeTarget.enabled) {
      throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    }
    const staged = await loadStagedPluginPackage(this.options.homeDir, activeTarget.digest).catch(error => {
      throw classify(error)
    })
    if (staged.manifest.runtimeManifest.schemaVersion !== 4) return undefined
    const { candidate } = this.mutationCandidate(active, 'enable', pluginId)
    await this.store.writeCandidate(candidate)
    const target = candidate.plugins.find(plugin => plugin.id === pluginId)!
    return authorizationPlanV2(
      staged,
      'enable',
      this.options.profileId,
      this.options.runtimeGeneration,
      target.moduleGeneration,
      candidate.transactionId!,
      await this.permissionPoliciesV2(),
    )
  }

  /** Host-private manifest-v5/v6/v7 review; uses the same PackageLifecycleAuthority transaction. */
  async permissionReviewPlanV4(
    input: HostPermissionLifecycleReviewV4Request,
  ): Promise<CordisXPermissionAuthorizationPlanV4 | undefined> {
    if (input.profileId !== this.options.profileId || input.runtimeGeneration !== this.options.runtimeGeneration) {
      throw new LifecycleFailure('stale-generation', safeError('stale-generation'), 'conflict')
    }
    const active = await this.store.loadActive()
    if (input.expectedRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const reviewTarget = input.target
    if (reviewTarget.kind === 'candidate') {
      const candidate = await this.store.loadCandidate(reviewTarget.candidateId)
      if (candidate.lastGoodRevision !== active.revision) {
        throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
      }
      const pluginId = changedTarget(active, candidate)
      const operation = active.plugins.some(plugin => plugin.id === pluginId) ? 'update' : 'install'
      const target = candidate.plugins.find(plugin => plugin.id === pluginId)!
      const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => {
        throw classify(error)
      })
      if (
        staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6
        && staged.manifest.runtimeManifest.schemaVersion !== 7 && staged.manifest.runtimeManifest.schemaVersion !== 8
        && staged.manifest.runtimeManifest.schemaVersion !== 9 && staged.manifest.runtimeManifest.schemaVersion !== 11
        && staged.manifest.runtimeManifest.schemaVersion !== 12 && staged.manifest.runtimeManifest.schemaVersion !== 10
      ) return undefined
      return authorizationPlanV4(
        staged,
        operation,
        this.options.profileId,
        this.options.runtimeGeneration,
        target.moduleGeneration,
        reviewTarget.candidateId,
        await this.permissionPoliciesV2(),
        await this.permissionPoliciesV4(),
        await this.certifiedPermission(staged),
      )
    }
    const pluginId = reviewTarget.pluginId
    const activeTarget = active.plugins.find(plugin => plugin.id === pluginId)
    if (activeTarget === undefined || activeTarget.enabled) {
      throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    }
    const staged = await loadStagedPluginPackage(this.options.homeDir, activeTarget.digest).catch(error => {
      throw classify(error)
    })
    if (
      staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6
      && staged.manifest.runtimeManifest.schemaVersion !== 7 && staged.manifest.runtimeManifest.schemaVersion !== 8
      && staged.manifest.runtimeManifest.schemaVersion !== 9 && staged.manifest.runtimeManifest.schemaVersion !== 11
      && staged.manifest.runtimeManifest.schemaVersion !== 12 && staged.manifest.runtimeManifest.schemaVersion !== 10
    ) return undefined
    const { candidate } = this.mutationCandidate(active, 'enable', pluginId)
    await this.store.writeCandidate(candidate)
    const target = candidate.plugins.find(plugin => plugin.id === pluginId)!
    return authorizationPlanV4(
      staged,
      'enable',
      this.options.profileId,
      this.options.runtimeGeneration,
      target.moduleGeneration,
      candidate.transactionId!,
      await this.permissionPoliciesV2(),
      await this.permissionPoliciesV4(),
      await this.certifiedPermission(staged),
    )
  }

  /** Apply a reviewed V2 decision through the same PackageLifecycleAuthority transaction. */
  async applyPermissionReviewV2(
    input: HostPermissionLifecycleApplyV2Request,
  ): Promise<CordisXPluginLifecycleResultV1> {
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
      return await this.applyPackage(request, active, candidateId, input.decision, operation)
    }
    return await this.applyStateMutationV2(request, active, candidateId, input.decision)
  }

  /** Applies one manifest-v5/v6/v7 review through the existing lifecycle authority. */
  async applyPermissionReviewV4(
    input: HostPermissionLifecycleApplyV4Request,
  ): Promise<CordisXPluginLifecycleResultV1> {
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
      return await this.applyPackage(request, active, candidateId, input.decision, operation)
    }
    return await this.applyStateMutationV4(request, active, candidateId, input.decision)
  }

  protected async applyStateMutationV2(
    request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
      readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
    },
    active: CordisXPluginActivationRecordV1,
    candidateId: string,
    decision: CordisXPermissionAuthorizationDecisionV2,
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
    const plan = authorizationPlanV2(
      staged,
      'enable',
      this.options.profileId,
      this.options.runtimeGeneration,
      after.moduleGeneration,
      candidateId,
      await this.permissionPoliciesV2(),
    )
    validateDecisionV2(plan, decision)
    const affected = [pluginId]
    const mutation: PluginRuntimeMutation = {
      transactionId: candidateId,
      operation: 'enable',
      previous: active,
      candidate,
      targetId: pluginId,
      affectedPluginIds: affected,
      package: staged,
      authorizationDecision: decision,
    }
    const formalCommitted = await this.activateWithAuthority({
      operation: 'enable',
      active,
      candidate,
      targetId: pluginId,
      staged,
      authorizationPlan: plan,
      authorizationDecision: decision,
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
      await this.options.runtime.stage(mutation)
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

  protected async applyStateMutationV4(
    request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
      readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
    },
    active: CordisXPluginActivationRecordV1,
    candidateId: string,
    decision: CordisXPermissionAuthorizationDecisionV4,
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
    const plan = authorizationPlanV4(
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
    validateDecisionV4(plan, decision)
    const affected = [pluginId]
    const formalCommitted = await this.activateWithAuthority({
      operation: 'enable',
      active,
      candidate,
      targetId: pluginId,
      staged,
      authorizationPlan: plan,
      authorizationDecision: decision,
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

  protected async planFor(
    item: CordisXPluginActivationItemV1,
    operation: 'install' | 'update' | 'enable',
  ): Promise<CordisXPermissionAuthorizationPlanV1> {
    return authorizationPlan(
      await loadStagedPluginPackage(this.options.homeDir, item.digest),
      operation,
      this.options.profileId,
      this.options.runtimeGeneration,
      await this.permissionPoliciesV1(),
    )
  }

  async handle(request: CordisXPluginLifecycleRequestV1): Promise<CordisXPluginLifecycleResultV1> {
    return await this.handleRequest(request, false)
  }

  protected async handleRequest(
    request: CordisXPluginLifecycleRequestV1,
    bundleMutation: boolean,
  ): Promise<CordisXPluginLifecycleResultV1> {
    let active: CordisXPluginActivationRecordV1
    try {
      active = await this.active(request)
    } catch (error) {
      const fallback = await this.store.loadActive()
      return this.failed(request, fallback, classify(error))
    }
    try {
      const operation = request.operation
      if (operation.kind === 'inspect-local') return await this.inspect(request, active, operation.sourceDirectory)
      if (operation.kind === 'install' || operation.kind === 'update') {
        return await this.applyPackage(
          request,
          active,
          operation.candidateId,
          operation.authorizationDecision,
          operation.kind,
        )
      }
      if (operation.kind === 'enable') {
        return await this.applyStateMutation(
          request,
          active,
          'enable',
          operation.pluginId,
          operation.authorizationDecision,
        )
      }
      if (operation.kind === 'disable' || operation.kind === 'uninstall') {
        if (!bundleMutation && this.bundleClaimGuard !== undefined) {
          const owners = await this.bundleClaimGuard(operation.pluginId)
          if (owners.length > 0) {
            throw new LifecycleFailure(
              'operation-unavailable',
              `This plugin is managed by bundle${owners.length === 1 ? '' : 's'}: ${owners.join(', ')}.`,
            )
          }
        }
        return await this.applyStateMutation(
          request,
          active,
          operation.kind,
          operation.pluginId,
          undefined,
          operation.impactToken,
        )
      }
      if (operation.kind !== 'reload') {
        throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
      }
      const item = active.plugins.find(plugin => plugin.id === operation.pluginId)
      if (item === undefined || !item.enabled) {
        throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
      }
      await this.options.runtime.reload({
        pluginId: item.id,
        moduleGeneration: item.moduleGeneration,
        runtimeGeneration: active.runtimeGeneration,
      })
      return {
        ...resultBase(request, active, 'reload'),
        outcome: 'applied',
        scope: 'plugin-restart',
        affectedPluginIds: [item.id],
      }
    } catch (error) {
      const current = await this.store.loadActive().catch(() => active)
      return this.failed(request, current, classify(error))
    }
  }
}
