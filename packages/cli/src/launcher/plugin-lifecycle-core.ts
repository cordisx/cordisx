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

export class PluginLifecycleCoordinatorCore {
  readonly store: PluginActivationStore
  protected readonly reservedPluginIds: ReadonlySet<string>
  protected readonly pendingPermissionReviews = new Map<string, PendingPermissionReview>()
  protected readonly receiptAuthority = createHostRegistryReceiptAuthority()
  protected readonly authority: Promise<PackageLifecycleAuthority>
  protected preparedRecovery: {
    readonly completed: readonly string[]
    readonly rollbacks: readonly { access: RollbackAccess; plan: RollbackPlan }[]
  } | undefined
  protected bundleClaimGuard: ((pluginId: string) => Promise<readonly string[]>) | undefined

  constructor(protected readonly options: CoordinatorOptions) {
    if (!path.isAbsolute(options.homeDir)) throw new Error('CordisX home directory must be absolute')
    this.store = new PluginActivationStore(options.homeDir, options.profileId, options.runtimeGeneration)
    this.reservedPluginIds = new Set(options.reservedPluginIds ?? [])
    const permissionAuthority = createHostPermissionReviewAuthority(async input => {
      const pending = this.pendingPermissionReviews.get(input.transactionId)
      if (pending === undefined || pending.candidateId !== input.transactionId) {
        throw new Error('permission review is not bound to this candidate')
      }
      const oneShotGrantIds = pending.decision.decisions
        .filter(item => item.decision === 'allow-once')
        .map(item => `one-shot:${input.transactionEpoch}:${item.capability}`)
      return {
        planId: pending.plan.planId,
        planRevision: input.permissionPlanRevision,
        decisionId: `${input.transactionId}:${
          createHash('sha256').update(JSON.stringify(pending.decision)).digest('hex')
        }`,
        decisionFingerprint: createHash('sha256').update(JSON.stringify(pending.decision)).digest('hex'),
        requiredSatisfied: true,
        unresolvedRequired: [],
        deniedRequired: [],
        oneShotGrantIds,
      }
    })
    this.authority = PackageLifecycleAuthority.open({
      homeDir: options.homeDir,
      profileId: options.profileId,
      runtimeGeneration: options.runtimeGeneration,
      permissionAuthority,
    })
  }

  setBundleClaimGuard(guard: (pluginId: string) => Promise<readonly string[]>): void {
    this.bundleClaimGuard = guard
  }

  protected async permissionPolicies(): Promise<readonly CordisXPersistedPermissionPolicyRecord[]> {
    return this.options.loadPermissionPolicies === undefined
      ? this.options.permissionPolicies
      : await this.options.loadPermissionPolicies()
  }

  protected async permissionPoliciesV1(): Promise<readonly CordisXPermissionPolicyRecordV1[]> {
    return (await this.permissionPolicies()).filter(
      (record): record is CordisXPermissionPolicyRecordV1 => record.schemaVersion === 1,
    )
  }

  protected async permissionPoliciesV2(): Promise<readonly CordisXPermissionPolicyRecordV2[]> {
    return (await this.permissionPolicies()).filter(isPermissionPolicyRecordV2)
  }

  protected async permissionPoliciesV4(): Promise<readonly CordisXPermissionPolicyRecordV4[]> {
    return (await this.permissionPolicies()).filter(isPermissionPolicyRecordV4)
  }

  protected async certifiedPermission(
    staged: StagedPluginPackage,
  ): Promise<CordisXCertifiedPermissionProjectionV1 | undefined> {
    const lookup = this.options.certifiedPermissionForArtifact
    if (
      lookup === undefined || !staged.manifest.runtimeManifest.capabilities.some(declaration => {
        if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) return false
        const name = (declaration as { readonly name?: unknown }).name
        return name === 'ui.extension-points.render' || name === 'ui.host-dom.read' || name === 'ui.host-dom.modify'
      })
    ) return undefined
    const projection = await lookup({
      source: staged.identitySource,
      pluginId: staged.manifest.id,
      version: staged.manifest.version,
      integrity: staged.digest,
    }).catch(() => undefined)
    return normalizeCertifiedPermissionProjectionV1(
      projection,
      { source: staged.identitySource, pluginId: staged.manifest.id },
      { version: staged.manifest.version, integrity: staged.digest },
      new Date(),
    )
  }

  protected async stageLocalSource(sourceDirectory: string): Promise<StagedPluginPackage> {
    const formalManifest = path.join(sourceDirectory, 'cordisx-package.json')
    try {
      await access(formalManifest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return await stageLocalPluginPackage(this.options.homeDir, sourceDirectory)
    }
    return await this.stagePackageSource({
      kind: 'local-directory',
      location: pathToFileURL(sourceDirectory).href,
    })
  }

  /** Host-internal bundle orchestration entry; it preserves the same formal package validators. */
  async stagePackageSource(source: PluginPackageSourceV1): Promise<StagedPluginPackage> {
    return await stagePluginPackageSourceV1(source, {
      homeDir: this.options.homeDir,
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1]: value => {
          const id = (value as { readonly id?: unknown })?.id
          if (typeof id !== 'string') throw new Error('runtime manifest id is invalid')
          return runtimeManifestV1(value, id)
        },
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4]: value => {
          const id = (value as { readonly id?: unknown })?.id
          if (typeof id !== 'string') throw new Error('runtime manifest id is invalid')
          return normalizePluginManifestV4(value, id, new CapabilityRiskCatalog())
        },
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V5]: value => {
          const id = (value as { readonly id?: unknown })?.id
          if (typeof id !== 'string') throw new Error('runtime manifest id is invalid')
          return normalizePluginManifestV5(value, id, new CapabilityRiskCatalog())
        },
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V6]: value => {
          const id = (value as { readonly id?: unknown })?.id
          if (typeof id !== 'string') throw new Error('runtime manifest id is invalid')
          return normalizePluginManifestV6(value, id, new CapabilityRiskCatalog())
        },
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V7]: value => {
          const id = (value as { readonly id?: unknown })?.id
          if (typeof id !== 'string') throw new Error('runtime manifest id is invalid')
          return normalizePluginManifestV7(value, id, new CapabilityRiskCatalog())
        },
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V8]: value => {
          const id = (value as { readonly id?: unknown })?.id
          if (typeof id !== 'string') throw new Error('runtime manifest id is invalid')
          return normalizePluginManifestV8(value, id, new CapabilityRiskCatalog())
        },
      },
    })
  }

  async prepareRecovery(): Promise<readonly RollbackPlan[]> {
    if (this.preparedRecovery !== undefined) return this.preparedRecovery.rollbacks.map(item => item.plan)
    const authority = await this.authority
    const recovered = await authority.recover()
    const completed: string[] = []
    const rollbacks: { access: RollbackAccess; plan: RollbackPlan }[] = []
    for (const directive of recovered.directives) {
      if (directive.action === 'discard-staged') {
        completed.push(directive.transactionId)
        continue
      }
      if (directive.rollbackToken === undefined) {
        throw new Error('shared registry rollback recovery is unavailable')
      }
      const rollbackAccess: RollbackAccess = {
        ownerId: 'cordisx-launcher',
        profileId: this.options.profileId,
        rollbackToken: directive.rollbackToken,
      }
      const plan = await authority.resolveRollback(rollbackAccess)
      rollbacks.push({ access: rollbackAccess, plan })
    }
    this.preparedRecovery = { completed, rollbacks }
    return rollbacks.map(item => item.plan)
  }

  async recover(): Promise<readonly string[]> {
    await this.prepareRecovery()
    const prepared = this.preparedRecovery!
    const authority = await this.authority
    const completed = [...prepared.completed]
    for (const { access: rollbackAccess, plan } of prepared.rollbacks) {
      if (this.options.runtime.recoverRollback === undefined) {
        throw new Error('shared registry rollback recovery is unavailable')
      }
      const restored = await this.options.runtime.recoverRollback(plan)
      if (
        restored.transactionId !== plan.transactionId
        || restored.transactionEpoch !== plan.transactionEpoch
        || restored.registryEpoch !== plan.rollbackRegistryEpoch
        || JSON.stringify(restored.active.plugins) !== JSON.stringify(plan.rollbackTarget.plugins)
        || JSON.stringify(restored.disposedAfter.plugins) !== JSON.stringify(plan.expectedPublished.plugins)
      ) {
        throw new Error('shared registry recovery observation is stale')
      }
      const receipt = this.receiptAuthority.issueRollback({
        transactionId: plan.transactionId,
        transactionEpoch: plan.transactionEpoch,
        candidateFingerprint: plan.candidateFingerprint,
        registryEpoch: restored.registryEpoch,
        active: runtimeObservation(restored.active, restored.registryEpoch),
        disposedAfter: runtimeObservation(restored.disposedAfter, plan.expectedRegistryEpoch),
      })
      const active = await authority.completeRollback(rollbackAccess, receipt)
      await this.options.runtime.adoptRecoveredActivation?.(active, restored.registryEpoch)
      completed.push(plan.transactionId)
    }
    this.preparedRecovery = undefined
    return completed
  }

  protected async active(request: CordisXPluginLifecycleRequestV1): Promise<CordisXPluginActivationRecordV1> {
    if (request.profileId !== this.options.profileId) {
      throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    }
    if (request.runtimeGeneration !== this.options.runtimeGeneration) {
      throw new LifecycleFailure('stale-generation', safeError('stale-generation'), 'conflict')
    }
    const active = await this.store.loadActive()
    if (request.expectedRevision !== active.revision) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    return active
  }

  protected failed(
    request: CordisXPluginLifecycleRequestV1,
    active: CordisXPluginActivationRecordV1,
    failure: LifecycleFailure,
  ): CordisXPluginLifecycleResultV1 {
    return {
      ...resultBase(request, active),
      outcome: failure.outcome,
      scope: request.operation.kind === 'reload' ? 'plugin-restart' : 'plugin-generation',
      affectedPluginIds: [],
      error: { code: failure.code, message: failure.message },
    }
  }

  protected async inspect(
    request: CordisXPluginLifecycleRequestV1,
    active: CordisXPluginActivationRecordV1,
    sourceDirectory: string,
  ): Promise<CordisXPluginLifecycleResultV1> {
    let staged: StagedPluginPackage
    try {
      staged = await this.stageLocalSource(sourceDirectory)
    } catch (error) {
      throw classify(error)
    }
    return await this.planStagedPackage(request, active, staged)
  }

  /** Plan one already immutable package. Bundle install uses this dependency-first. */
  async inspectStagedPackage(
    staged: StagedPluginPackage,
    requestId = `bundle-plugin-${randomUUID()}`,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const active = await this.store.loadActive()
    const request: CordisXPluginLifecycleRequestV1 = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
      schemaVersion: 1,
      requestId,
      profileId: this.options.profileId,
      expectedRevision: active.revision,
      runtimeGeneration: this.options.runtimeGeneration,
      operation: { kind: 'inspect-local', sourceDirectory: '/host-internal/staged-package' },
    }
    try {
      return await this.planStagedPackage(request, active, staged)
    } catch (error) {
      return this.failed(request, active, classify(error))
    }
  }

  protected async planStagedPackage(
    request: CordisXPluginLifecycleRequestV1,
    active: CordisXPluginActivationRecordV1,
    staged: StagedPluginPackage,
  ): Promise<CordisXPluginLifecycleResultV1> {
    if (this.reservedPluginIds.has(staged.manifest.id)) {
      throw new LifecycleFailure('operation-unavailable', 'A launcher-configured plugin already owns this id.')
    }
    const existing = active.plugins.find(plugin => plugin.id === staged.manifest.id)
    if (existing?.digest === staged.digest) {
      throw new LifecycleFailure('operation-unavailable', 'This exact package is already active.')
    }
    const operation = existing === undefined ? 'install' : 'update'
    const nextItem: CordisXPluginActivationItemV1 = {
      id: staged.manifest.id,
      version: staged.manifest.version,
      digest: staged.digest,
      moduleGeneration: `${staged.manifest.id}-${randomUUID()}`,
      enabled: true,
      dependencies: staged.manifest.dependencies,
      ...(staged.manifest.canonicalSource === undefined ? {} : { canonicalSource: staged.manifest.canonicalSource }),
    }
    const provisional = existing === undefined
      ? [...active.plugins, nextItem]
      : active.plugins.map(plugin => plugin.id === nextItem.id ? nextItem : plugin)
    let affected = existing === undefined
      ? [nextItem.id]
      : [
        ...new Set([
          ...pluginDependentClosure(active.plugins, nextItem.id),
          ...pluginDependentClosure(provisional, nextItem.id),
        ]),
      ]
    const order = topologicalPluginOrder(provisional)
    affected = order.filter(id => affected.includes(id))
    const plugins = withGenerations(provisional, new Set(affected)).map(plugin => (
      plugin.id === nextItem.id ? { ...nextItem, moduleGeneration: plugin.moduleGeneration } : plugin
    ))
    try {
      validatePluginActivationGraph(plugins)
    } catch (error) {
      throw classify(error)
    }
    const transactionId = `plugin-${randomUUID()}`
    const candidate: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'candidate',
      transactionId,
      profileId: active.profileId,
      revision: active.revision + 1,
      lastGoodRevision: active.revision,
      runtimeGeneration: active.runtimeGeneration,
      plugins,
    }
    await this.store.writeCandidate(candidate)
    const plan = staged.manifest.runtimeManifest.schemaVersion === 1
      ? authorizationPlan(
        staged,
        operation,
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
      candidateId: transactionId,
      impactToken: impactToken(active.profileId, active.revision, operation, staged.manifest.id, affected),
      package: packageSummary(staged),
      ...(plan === undefined ? {} : { authorizationPlan: plan }),
    }
  }
}
