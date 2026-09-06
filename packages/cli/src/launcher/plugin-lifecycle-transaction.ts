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

import { PluginLifecycleCoordinatorCore } from './plugin-lifecycle-core.js'
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

export class PluginLifecycleCoordinatorTransaction extends PluginLifecycleCoordinatorCore {
  protected async applyPackage(
    request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
      readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
    },
    active: CordisXPluginActivationRecordV1,
    candidateId: string,
    decision:
      | CordisXPermissionAuthorizationDecisionV1
      | CordisXPermissionAuthorizationDecisionV2
      | CordisXPermissionAuthorizationDecisionV4,
    operation: 'install' | 'update',
  ): Promise<CordisXPluginLifecycleResultV1> {
    const candidate = await this.store.loadCandidate(candidateId).catch(() => {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    })
    if (candidate.lastGoodRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const targetId = changedTarget(active, candidate)
    const existing = active.plugins.some(plugin => plugin.id === targetId)
    if ((operation === 'install') === existing) {
      throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    }
    const target = candidate.plugins.find(plugin => plugin.id === targetId)!
    const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => {
      throw classify(error)
    })
    const plan = decision.schemaVersion === 4
      ? authorizationPlanV4(
        staged,
        operation,
        this.options.profileId,
        this.options.runtimeGeneration,
        target.moduleGeneration,
        candidateId,
        await this.permissionPoliciesV2(),
        await this.permissionPoliciesV4(),
        await this.certifiedPermission(staged),
      )
      : decision.schemaVersion === 2
      ? authorizationPlanV2(
        staged,
        operation,
        this.options.profileId,
        this.options.runtimeGeneration,
        target.moduleGeneration,
        candidateId,
        await this.permissionPoliciesV2(),
      )
      : authorizationPlan(
        staged,
        operation,
        this.options.profileId,
        this.options.runtimeGeneration,
        await this.permissionPoliciesV1(),
      )
    if (decision.schemaVersion === 4) validateDecisionV4(plan as CordisXPermissionAuthorizationPlanV4, decision)
    else if (decision.schemaVersion === 2) validateDecisionV2(plan as CordisXPermissionAuthorizationPlanV2, decision)
    else validateDecision(plan as CordisXPermissionAuthorizationPlanV1, decision)
    const affected = topologicalPluginOrder(candidate.plugins).filter(id => {
      const next = candidate.plugins.find(plugin => plugin.id === id)
      const old = active.plugins.find(plugin => plugin.id === id)
      return old === undefined || next?.moduleGeneration !== old.moduleGeneration
    })
    const mutation: PluginRuntimeMutation = {
      transactionId: candidateId,
      operation,
      previous: active,
      candidate,
      targetId,
      affectedPluginIds: affected,
      package: staged,
      authorizationDecision: decision,
    }
    const formalCommitted = await this.activateWithAuthority({
      operation,
      active,
      candidate,
      targetId,
      staged,
      authorizationPlan: plan,
      authorizationDecision: decision,
    })
    if (formalCommitted !== undefined) {
      return {
        ...resultBase(request, formalCommitted, operation),
        outcome: 'applied',
        scope: 'plugin-generation',
        affectedPluginIds: affected,
        transactionId: candidateId,
        package: packageSummary(staged),
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
      try {
        await this.options.runtime.abort(candidateId)
      } catch {
        throw new LifecycleFailure('rollback-failed', safeError('rollback-failed'), 'rollback-failed')
      }
      await this.store.abortCandidate(candidateId)
      throw new LifecycleFailure('activation-failed', safeError('activation-failed'), 'rolled-back')
    }
    // Renderer staging is already live and the durable active record is authoritative. Commit only
    // releases rollback state; it must not turn a completed activation into a false rollback.
    await this.options.runtime.commit(candidateId).catch(() => undefined)
    return {
      ...resultBase(request, committed, operation),
      outcome: 'applied',
      scope: 'plugin-generation',
      affectedPluginIds: affected,
      transactionId: candidateId,
      package: packageSummary(staged),
    }
  }

  protected formalRuntime():
    | (
      & PluginLifecycleRuntime
      & Required<Pick<PluginLifecycleRuntime, 'prepare' | 'publish' | 'complete' | 'finalize' | 'rollback'>>
    )
    | undefined
  {
    const runtime = this.options.runtime
    return runtime.prepare === undefined || runtime.publish === undefined
        || runtime.complete === undefined || runtime.finalize === undefined || runtime.rollback === undefined
      ? undefined
      : runtime as
        & PluginLifecycleRuntime
        & Required<Pick<PluginLifecycleRuntime, 'prepare' | 'publish' | 'complete' | 'finalize' | 'rollback'>>
  }

  protected async activateWithAuthority(input: {
    readonly operation: 'install' | 'update' | 'enable' | 'disable' | 'uninstall'
    readonly active: CordisXPluginActivationRecordV1
    readonly candidate: CordisXPluginActivationRecordV1
    readonly targetId: string
    readonly staged?: StagedPluginPackage
    readonly authorizationPlan:
      | CordisXPermissionAuthorizationPlanV1
      | CordisXPermissionAuthorizationPlanV2
      | CordisXPermissionAuthorizationPlanV4
    readonly authorizationDecision:
      | CordisXPermissionAuthorizationDecisionV1
      | CordisXPermissionAuthorizationDecisionV2
      | CordisXPermissionAuthorizationDecisionV4
  }): Promise<CordisXPluginActivationRecordV1 | undefined> {
    const runtime = this.formalRuntime()
    if (runtime === undefined) return undefined
    const transactionId = input.candidate.transactionId!
    const runtimeManifest = input.staged?.manifest.runtimeManifest
    const targetUsesIsolatedWorker = usesIsolatedWorker(runtimeManifest)
    let fence: RuntimeGenerationFence
    try {
      fence = input.staged?.browserArtifact !== undefined
          && !targetUsesIsolatedWorker
          && runtime.prepareBrowserGraph !== undefined
        ? await runtime.prepareBrowserGraph(transactionId, input.active)
        : runtime.prepare(transactionId)
    } catch {
      await this.store.abortCandidate(transactionId).catch(() => undefined)
      throw new LifecycleFailure('readiness-failed', safeError('readiness-failed'))
    }
    this.pendingPermissionReviews.set(transactionId, {
      candidateId: transactionId,
      plan: input.authorizationPlan,
      decision: input.authorizationDecision,
    })
    let prepared: PreparedCandidate | undefined
    let access: CandidateAccess | undefined
    let activationRequested = false
    let published = false
    let commitCompleted = false
    try {
      const authority = await this.authority
      prepared = await authority.prepare({
        ownerId: 'cordisx-launcher',
        operation: input.operation,
        candidateId: transactionId,
        transactionEpoch: fence.transactionEpoch,
        expectedRegistryEpoch: fence.expectedRegistryEpoch,
        permissionPlanRevision: input.candidate.revision,
        permissionPlanFingerprint: createHash('sha256').update(JSON.stringify(input.authorizationPlan)).digest('hex'),
      })
      access = {
        ownerId: 'cordisx-launcher',
        profileId: this.options.profileId,
        candidateToken: prepared.candidateToken,
        permissionReviewToken: prepared.permissionReviewToken,
      }
      await authority.resolveCandidate(access, 'plan')
      await authority.resolveImpact({
        ownerId: access.ownerId,
        profileId: access.profileId,
        impactToken: prepared.impactToken,
      }, 'plan')
      const stagePlan = await authority.requestActivation(access)
      activationRequested = true
      const resolvedStage = await authority.resolveCandidate(access, 'stage')
      if (
        resolvedStage.candidateFingerprint !== prepared.candidateFingerprint
        || JSON.stringify(resolvedStage.affectedPluginIds) !== JSON.stringify(stagePlan.affectedPluginIds)
      ) {
        throw new Error('Host candidate plan changed across plan and stage boundaries')
      }
      await authority.resolveImpact({
        ownerId: access.ownerId,
        profileId: access.profileId,
        impactToken: prepared.impactToken,
      }, 'stage')
      let runtimeArtifactSource: string | undefined
      let runtimeArtifactLease: PluginGenerationGraphLease | undefined
      const runtimeArtifactLeases: PluginGenerationGraphLease[] = []
      let stageResolutionFailure: unknown
      for (const pluginId of resolvedStage.activationOrder) {
        const candidatePlugin = resolvedStage.after.plugins.find(plugin => plugin.id === pluginId)
        if (candidatePlugin?.enabled === true && resolvedStage.affectedPluginIds.includes(pluginId)) {
          try {
            const runtimeModule = await authority.resolveRuntimeModule(access, 'stage', pluginId)
            const stagedPackage = pluginId === input.targetId && input.staged !== undefined
              ? input.staged
              : await loadStagedPluginPackage(this.options.homeDir, candidatePlugin.digest)
            const isolatedWorker = usesIsolatedWorker(stagedPackage.manifest.runtimeManifest)
            if (pluginId === input.targetId && !isolatedWorker) {
              if (this.options.pluginGenerationArtifactServer === undefined) {
                runtimeArtifactSource = await loadPluginGenerationArtifact(runtimeModule)
              } else {
                const loaded = await loadPluginGenerationArtifactForRuntime(
                  runtimeModule,
                  candidatePlugin.moduleGeneration,
                  this.options.pluginGenerationArtifactServer,
                )
                runtimeArtifactSource = loaded.runtimeArtifactSource
                if (loaded.kind === 'browser-esm-graph') {
                  runtimeArtifactLease = loaded.lease
                  runtimeArtifactLeases.push(loaded.lease)
                }
              }
            } else if (
              !isolatedWorker && stagedPackage.browserArtifact !== undefined
              && this.options.pluginGenerationArtifactServer !== undefined
            ) {
              const loaded = await loadPluginGenerationArtifactForRuntime(
                runtimeModule,
                candidatePlugin.moduleGeneration,
                this.options.pluginGenerationArtifactServer,
              )
              if (loaded.kind === 'browser-esm-graph') runtimeArtifactLeases.push(loaded.lease)
            }
          } catch (error) {
            stageResolutionFailure = error
            break
          }
        }
      }
      if (stageResolutionFailure !== undefined && input.staged !== undefined) {
        runtimeArtifactSource = 'throw new Error("Host runtime module resolution failed")'
      }
      const readiness = await runtime.stage({
        transactionId,
        transactionEpoch: resolvedStage.transactionEpoch,
        expectedRegistryEpoch: resolvedStage.expectedRegistryEpoch,
        afterRegistryEpoch: resolvedStage.afterRegistryEpoch,
        operation: input.operation,
        previous: input.active,
        candidate: input.candidate,
        targetId: input.targetId,
        affectedPluginIds: resolvedStage.affectedPluginIds,
        ...(input.staged === undefined ? {} : { package: input.staged }),
        ...(runtimeArtifactSource === undefined ? {} : { runtimeArtifactSource }),
        ...(runtimeArtifactLease === undefined ? {} : { runtimeArtifactLease }),
        ...(runtimeArtifactLeases.length === 0 ? {} : { runtimeArtifactLeases }),
        authorizationDecision: input.authorizationDecision,
      })
      if (readiness === undefined) throw new Error('shared registry readiness observation is unavailable')
      if (
        readiness.transactionId !== transactionId
        || readiness.transactionEpoch !== resolvedStage.transactionEpoch
        || readiness.expectedRegistryEpoch !== resolvedStage.expectedRegistryEpoch
        || readiness.afterRegistryEpoch !== resolvedStage.afterRegistryEpoch
        || JSON.stringify(runtimeObservation(readiness.observation, readiness.afterRegistryEpoch))
          !== JSON.stringify(runtimeObservation(input.candidate, resolvedStage.afterRegistryEpoch))
      ) {
        throw new Error('shared registry readiness observation is stale')
      }
      if (stageResolutionFailure !== undefined) throw stageResolutionFailure
      const readinessReceipt = this.receiptAuthority.issueReadiness({
        transactionId,
        transactionEpoch: resolvedStage.transactionEpoch,
        candidateFingerprint: resolvedStage.candidateFingerprint,
        expectedRegistryEpoch: resolvedStage.expectedRegistryEpoch,
        afterRegistryEpoch: resolvedStage.afterRegistryEpoch,
        observation: runtimeObservation(readiness.observation, readiness.afterRegistryEpoch),
      })
      await authority.confirmReadiness(access, readinessReceipt)
      const publishPlan = await authority.resolveCandidate(access, 'publish')
      await authority.resolveImpact({
        ownerId: access.ownerId,
        profileId: access.profileId,
        impactToken: prepared.impactToken,
      }, 'publish')
      const publication = await runtime.publish(transactionId)
      published = true
      if (
        publication.transactionEpoch !== publishPlan.transactionEpoch
        || publication.registryEpoch !== publishPlan.afterRegistryEpoch
        || JSON.stringify(publication.active.plugins) !== JSON.stringify(input.candidate.plugins)
      ) {
        throw new Error('shared registry publication observation is stale')
      }
      const committed = await authority.commit(access)
      const cleanup = await runtime.complete(transactionId)
      if (
        cleanup.registryEpoch !== publishPlan.afterRegistryEpoch
        || JSON.stringify(cleanup.active.plugins) !== JSON.stringify(input.candidate.plugins)
        || JSON.stringify(cleanup.disposedAfter.plugins) !== JSON.stringify(input.active.plugins)
      ) {
        throw new Error('retiring generation cleanup observation is stale')
      }
      const commitReceipt = this.receiptAuthority.issueCommit({
        transactionId,
        transactionEpoch: publishPlan.transactionEpoch,
        candidateFingerprint: publishPlan.candidateFingerprint,
        registryEpoch: cleanup.registryEpoch,
        active: runtimeObservation(cleanup.active, cleanup.registryEpoch),
        disposedAfter: runtimeObservation(cleanup.disposedAfter, publishPlan.expectedRegistryEpoch),
      })
      await authority.completeCommit(access, commitReceipt)
      commitCompleted = true
      let finalized = false
      let finalizeFailure: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await runtime.finalize(transactionId)
          finalized = true
          break
        } catch (error) {
          finalizeFailure = error
        }
      }
      if (!finalized) {
        runtime.terminal?.(finalizeFailure)
        throw finalizeFailure
      }
      return committed
    } catch (error) {
      if (commitCompleted) {
        throw new LifecycleFailure(
          'rollback-failed',
          `The plugin activation was committed, but retiring generation cleanup did not complete (${
            error instanceof Error ? error.message : String(error)
          }). Restart CordisX before another plugin lifecycle operation.`,
          'rollback-failed',
        )
      }
      if (prepared === undefined || access === undefined) {
        await runtime.abort(transactionId).catch(() => undefined)
        await this.store.abortCandidate(transactionId).catch(() => undefined)
      } else {
        const authority = await this.authority
        if (!activationRequested) {
          await authority.abort(access, 'activation-before-stage-failed').catch(() => undefined)
          await runtime.abort(transactionId).catch(() => undefined)
        } else {
          try {
            const rollback = await authority.beginRollback(access, 'activation-or-readiness-failed')
            const rollbackPlan = await authority.resolveCandidate(access, 'rollback')
            await authority.resolveImpact({
              ownerId: access.ownerId,
              profileId: access.profileId,
              impactToken: prepared.impactToken,
            }, 'rollback')
            const restored = await runtime.rollback(transactionId)
            const rollbackReceipt = this.receiptAuthority.issueRollback({
              transactionId,
              transactionEpoch: rollback.transactionEpoch,
              candidateFingerprint: rollbackPlan.candidateFingerprint,
              registryEpoch: restored.registryEpoch,
              active: runtimeObservation(restored.active, restored.registryEpoch),
              disposedAfter: runtimeObservation(restored.disposedAfter, rollback.expectedRegistryEpoch),
            })
            const active = await authority.completeRollback({
              ownerId: access.ownerId,
              profileId: access.profileId,
              rollbackToken: rollback.rollbackToken,
            }, rollbackReceipt)
            await runtime.adoptRecoveredActivation?.(active, restored.registryEpoch)
          } catch (rollbackError) {
            throw new LifecycleFailure(
              'rollback-failed',
              `${safeError('rollback-failed')} (${error instanceof Error ? error.message : String(error)}; ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              })`,
              'rollback-failed',
            )
          }
          throw new LifecycleFailure(
            published ? 'activation-failed' : 'readiness-failed',
            safeError(published ? 'activation-failed' : 'readiness-failed'),
            'rolled-back',
          )
        }
      }
      throw error
    } finally {
      this.pendingPermissionReviews.delete(transactionId)
    }
  }

  protected mutationCandidate(
    active: CordisXPluginActivationRecordV1,
    operation: 'enable' | 'disable' | 'uninstall',
    pluginId: string,
  ): { readonly candidate: CordisXPluginActivationRecordV1; readonly affected: readonly string[] } {
    const target = active.plugins.find(plugin => plugin.id === pluginId)
    if (target === undefined) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    let affected = operation === 'enable' ? [pluginId] : pluginDependentClosure(active.plugins, pluginId)
    affected = topologicalPluginOrder(active.plugins).filter(id => affected.includes(id))
    let plugins: readonly CordisXPluginActivationItemV1[]
    if (operation === 'uninstall') {
      const removed = new Set(affected)
      plugins = active.plugins.filter(plugin => !removed.has(plugin.id))
    } else {
      const changed = new Set(affected)
      plugins = withGenerations(
        active.plugins.map(plugin =>
          changed.has(plugin.id)
            ? { ...plugin, enabled: operation === 'enable' ? true : false }
            : plugin
        ),
        changed,
      )
    }
    validatePluginActivationGraph(plugins)
    const transactionId = `plugin-${randomUUID()}`
    return {
      candidate: {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'candidate',
        transactionId,
        profileId: active.profileId,
        revision: active.revision + 1,
        lastGoodRevision: active.revision,
        runtimeGeneration: active.runtimeGeneration,
        plugins,
      },
      affected,
    }
  }

  protected async applyStateMutation(
    request: CordisXPluginLifecycleRequestV1,
    active: CordisXPluginActivationRecordV1,
    operation: 'enable' | 'disable' | 'uninstall',
    pluginId: string,
    authorizationDecision?: CordisXPermissionAuthorizationDecisionV1,
    confirmedImpactToken?: string,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const { candidate, affected } = this.mutationCandidate(active, operation, pluginId)
    const expectedImpact = impactToken(active.profileId, active.revision, operation, pluginId, affected)
    if (operation !== 'enable' && confirmedImpactToken !== expectedImpact) {
      const target = active.plugins.find(plugin => plugin.id === pluginId)!
      const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => {
        throw classify(error)
      })
      const plan = staged.manifest.runtimeManifest.schemaVersion === 1
        ? authorizationPlan(
          staged,
          'install',
          this.options.profileId,
          this.options.runtimeGeneration,
          await this.permissionPoliciesV1(),
        )
        : undefined
      return {
        ...resultBase(request, active, operation),
        outcome: 'planned',
        scope: 'plugin-generation',
        affectedPluginIds: affected,
        candidateId: candidate.transactionId!,
        impactToken: expectedImpact,
        package: packageSummary(staged),
        ...(plan === undefined ? {} : { authorizationPlan: plan }),
      }
    }
    let staged: StagedPluginPackage | undefined
    let reviewPlan:
      | CordisXPermissionAuthorizationPlanV1
      | CordisXPermissionAuthorizationPlanV2
      | CordisXPermissionAuthorizationPlanV4
    let reviewDecision:
      | CordisXPermissionAuthorizationDecisionV1
      | CordisXPermissionAuthorizationDecisionV2
      | CordisXPermissionAuthorizationDecisionV4
    if (operation === 'enable') {
      const target = active.plugins.find(plugin => plugin.id === pluginId)!
      staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => {
        throw classify(error)
      })
      if (staged.manifest.runtimeManifest.schemaVersion !== 1) {
        return {
          ...resultBase(request, active, operation),
          outcome: 'planned',
          scope: 'plugin-generation',
          affectedPluginIds: affected,
          candidateId: candidate.transactionId!,
          impactToken: expectedImpact,
          package: packageSummary(staged),
        }
      }
      const plan = authorizationPlan(
        staged,
        'enable',
        this.options.profileId,
        this.options.runtimeGeneration,
        await this.permissionPoliciesV1(),
      )
      if (authorizationDecision === undefined) {
        return {
          ...resultBase(request, active, operation),
          outcome: 'planned',
          scope: 'plugin-generation',
          affectedPluginIds: affected,
          candidateId: candidate.transactionId!,
          impactToken: expectedImpact,
          package: packageSummary(staged),
          authorizationPlan: plan,
        }
      }
      validateDecision(plan, authorizationDecision)
      reviewPlan = plan
      reviewDecision = authorizationDecision
    } else {
      const target = active.plugins.find(plugin => plugin.id === pluginId)!
      const reviewStaged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => {
        throw classify(error)
      })
      if (reviewStaged.manifest.runtimeManifest.schemaVersion === 1) {
        reviewPlan = authorizationPlan(
          reviewStaged,
          'install',
          this.options.profileId,
          this.options.runtimeGeneration,
          await this.permissionPoliciesV1(),
        )
        reviewDecision = allowedDecision(reviewPlan)
      } else if (reviewStaged.manifest.runtimeManifest.schemaVersion === 4) {
        reviewPlan = authorizationPlanV2(
          reviewStaged,
          'enable',
          this.options.profileId,
          this.options.runtimeGeneration,
          target.moduleGeneration,
          candidate.transactionId!,
          await this.permissionPoliciesV2(),
        )
        reviewDecision = allowedDecisionV2(reviewPlan)
      } else {
        reviewPlan = authorizationPlanV4(
          reviewStaged,
          'enable',
          this.options.profileId,
          this.options.runtimeGeneration,
          target.moduleGeneration,
          candidate.transactionId!,
          await this.permissionPoliciesV2(),
          await this.permissionPoliciesV4(),
          await this.certifiedPermission(reviewStaged),
        )
        reviewDecision = allowedDecisionV4(reviewPlan)
      }
    }
    await this.store.writeCandidate(candidate)
    const mutation: PluginRuntimeMutation = {
      transactionId: candidate.transactionId!,
      operation,
      previous: active,
      candidate,
      targetId: pluginId,
      affectedPluginIds: affected,
      ...(staged === undefined ? {} : { package: staged }),
      ...(authorizationDecision === undefined ? {} : { authorizationDecision }),
    }
    const formalCommitted = await this.activateWithAuthority({
      operation,
      active,
      candidate,
      targetId: pluginId,
      ...(staged === undefined ? {} : { staged }),
      authorizationPlan: reviewPlan,
      authorizationDecision: reviewDecision,
    })
    if (formalCommitted !== undefined) {
      return {
        ...resultBase(request, formalCommitted, operation),
        outcome: 'applied',
        scope: 'plugin-generation',
        affectedPluginIds: affected,
        transactionId: candidate.transactionId!,
      }
    }
    try {
      await this.options.runtime.stage(mutation)
    } catch {
      await this.store.abortCandidate(candidate.transactionId!)
      throw new LifecycleFailure('readiness-failed', safeError('readiness-failed'), 'rolled-back')
    }
    let committed: CordisXPluginActivationRecordV1
    try {
      committed = await this.store.commitCandidate(candidate.transactionId!)
    } catch {
      try {
        await this.options.runtime.abort(candidate.transactionId!)
      } catch {
        throw new LifecycleFailure('rollback-failed', safeError('rollback-failed'), 'rollback-failed')
      }
      await this.store.abortCandidate(candidate.transactionId!)
      throw new LifecycleFailure('activation-failed', safeError('activation-failed'), 'rolled-back')
    }
    await this.options.runtime.commit(candidate.transactionId!).catch(() => undefined)
    return {
      ...resultBase(request, committed, operation),
      outcome: 'applied',
      scope: 'plugin-generation',
      affectedPluginIds: affected,
      transactionId: candidate.transactionId!,
    }
  }
}
