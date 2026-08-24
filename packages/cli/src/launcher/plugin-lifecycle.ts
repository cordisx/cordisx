import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
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
import { createPermissionPolicyRecord, normalizePermissionScope, permissionRecordKey, permissionScopeFingerprint } from '../permissions.js'
import {
  PluginActivationStore,
  pluginDependentClosure,
  topologicalPluginOrder,
  validatePluginActivationGraph,
} from './plugin-activation.js'
import {
  loadStagedPluginPackage,
  stageLocalPluginPackage,
  type StagedPluginPackage,
} from './plugin-package.js'
import {
  PackageLifecycleAuthority,
  createHostPermissionReviewAuthority,
  createHostRegistryReceiptAuthority,
  type CandidateAccess,
  type PreparedCandidate,
  type RollbackAccess,
} from './packages/authority.js'
import type { PackageCandidatePlan, PackageRuntimeObservation } from './packages/types.js'
import type { RollbackPlan } from './packages/authority.js'
import { loadPluginGenerationArtifact } from './plugin-generation-loader.js'

export interface PluginRuntimeMutation {
  readonly transactionId: string
  readonly transactionEpoch?: string
  readonly expectedRegistryEpoch?: number
  readonly afterRegistryEpoch?: number
  readonly operation: 'install' | 'update' | 'enable' | 'disable' | 'uninstall'
  readonly previous: CordisXPluginActivationRecordV1
  readonly candidate: CordisXPluginActivationRecordV1
  readonly targetId: string
  readonly affectedPluginIds: readonly string[]
  readonly package?: StagedPluginPackage
  /** Host-only renderer artifact compiled from the authority-resolved immutable runtime module. */
  readonly runtimeArtifactSource?: string
  readonly authorizationDecision?: CordisXPermissionAuthorizationDecisionV1
}

/** Stable renderer adapter. `stage` is reversible until `commit` acknowledges durable publication. */
export interface PluginLifecycleRuntime {
  prepare?(transactionId: string): RuntimeGenerationFence
  stage(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation>
  publish?(transactionId: string): Promise<RuntimePublicationObservation>
  complete?(transactionId: string): Promise<RuntimeCleanupObservation>
  finalize?(transactionId: string): Promise<void>
  rollback?(transactionId: string): Promise<RuntimeCleanupObservation>
  /** Reattach to a renderer transaction that survived a Launcher restart. */
  recoverRollback?(plan: RollbackPlan): Promise<RuntimeCleanupObservation>
  adoptRecoveredActivation?(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void>
  commit(transactionId: string): Promise<void>
  abort(transactionId: string): Promise<void>
  reload(input: {
    readonly pluginId: string
    readonly moduleGeneration: string
    readonly runtimeGeneration: string
  }): Promise<void>
}

export interface RuntimeGenerationFence {
  readonly transactionEpoch: string
  readonly expectedRegistryEpoch: number
}

export interface RuntimeReadinessObservation extends RuntimeGenerationFence {
  readonly transactionId: string
  readonly afterRegistryEpoch: number
  readonly observation: CordisXPluginActivationRecordV1
}

export interface RuntimePublicationObservation {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly registryEpoch: number
  readonly active: CordisXPluginActivationRecordV1
}

export interface RuntimeCleanupObservation extends RuntimePublicationObservation {
  readonly disposedAfter: CordisXPluginActivationRecordV1
}

interface CoordinatorOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly permissionPolicies: readonly CordisXPermissionPolicyRecordV1[]
  readonly runtime: PluginLifecycleRuntime
  readonly reservedPluginIds?: readonly string[]
}

interface PendingPermissionReview {
  readonly candidateId: string
  readonly plan: CordisXPermissionAuthorizationPlanV1
  readonly decision: CordisXPermissionAuthorizationDecisionV1
}

class LifecycleFailure extends Error {
  constructor(
    readonly code: CordisXPluginLifecycleErrorCode,
    message: string,
    readonly outcome: CordisXPluginLifecycleResultV1['outcome'] = 'rejected',
  ) {
    super(message)
  }
}

function safeError(code: CordisXPluginLifecycleErrorCode): string {
  const messages: Record<CordisXPluginLifecycleErrorCode, string> = {
    'invalid-source': 'The selected local package source is unavailable or outside the supported boundary.',
    'invalid-manifest': 'The local package manifest is invalid.',
    'incompatible-runtime': 'The package requires an incompatible CordisX runtime ABI or protocol.',
    'integrity-failed': 'The staged package failed integrity readback.',
    'dependency-missing': 'A required plugin dependency is not installed.',
    'dependency-version': 'An installed plugin dependency has an incompatible version.',
    'dependency-cycle': 'The candidate plugin dependency graph contains a cycle.',
    'permission-denied': 'A required plugin capability was not granted.',
    'build-failed': 'The plugin browser artifact could not be built.',
    'readiness-failed': 'The candidate plugin generation failed readiness; last-good was restored.',
    'stale-revision': 'The plugin activation revision changed; refresh and retry.',
    'stale-generation': 'The CordisX runtime generation changed; refresh and retry.',
    'activation-failed': 'The plugin activation record could not be published; last-good was restored.',
    'rollback-failed': 'The candidate failed and the last-good runtime could not be restored.',
    'operation-unavailable': 'This plugin lifecycle operation is unavailable.',
  }
  return messages[code]
}

function classify(error: unknown): LifecycleFailure {
  if (error instanceof LifecycleFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('runtime ABI') || message.includes('protocol')) return new LifecycleFailure('incompatible-runtime', safeError('incompatible-runtime'))
  if (message.includes('integrity')) return new LifecycleFailure('integrity-failed', safeError('integrity-failed'))
  if (message.includes('missing dependency')) return new LifecycleFailure('dependency-missing', safeError('dependency-missing'))
  if (message.includes('requires') && message.includes('found')) return new LifecycleFailure('dependency-version', safeError('dependency-version'))
  if (message.includes('cycle')) return new LifecycleFailure('dependency-cycle', safeError('dependency-cycle'))
  if (message.includes('build') || message.includes('bundle a second')) return new LifecycleFailure('build-failed', safeError('build-failed'))
  if (message.includes('manifest') || message.includes('package.')) return new LifecycleFailure('invalid-manifest', safeError('invalid-manifest'))
  return new LifecycleFailure('invalid-source', safeError('invalid-source'))
}

function resultBase(
  request: CordisXPluginLifecycleRequestV1,
  active: CordisXPluginActivationRecordV1,
  operation = request.operation.kind,
): Pick<CordisXPluginLifecycleResultV1, '$schema' | 'schemaVersion' | 'requestId' | 'profileId' | 'operation' | 'revision' | 'runtimeGeneration'> {
  return {
    $schema: CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
    schemaVersion: 1,
    requestId: request.requestId,
    profileId: request.profileId,
    operation,
    revision: active.revision,
    runtimeGeneration: active.runtimeGeneration,
  }
}

function packageSummary(staged: StagedPluginPackage): CordisXPluginLifecyclePackageSummaryV1 {
  return {
    id: staged.manifest.id,
    ...(staged.manifest.runtimeManifest.name === undefined ? {} : { name: staged.manifest.runtimeManifest.name }),
    version: staged.manifest.version,
    digest: staged.digest,
    dependencies: staged.manifest.dependencies,
    ...(staged.manifest.canonicalSource === undefined ? {} : { canonicalSource: staged.manifest.canonicalSource }),
  }
}

function identity(staged: StagedPluginPackage): CordisXPluginIdentity {
  return { source: staged.identitySource, id: staged.manifest.id }
}

function equalScope(left: unknown, right: unknown, capability: Parameters<typeof permissionScopeFingerprint>[0]): boolean {
  return permissionScopeFingerprint(capability, normalizePermissionScope(left))
    === permissionScopeFingerprint(capability, normalizePermissionScope(right))
}

function authorizationPlan(
  staged: StagedPluginPackage,
  operation: 'install' | 'update' | 'enable',
  profileId: string,
  generation: string,
  policies: readonly CordisXPermissionPolicyRecordV1[],
): CordisXPermissionAuthorizationPlanV1 {
  const pluginIdentity = identity(staged)
  const policyByKey = new Map(policies.map(policy => [permissionRecordKey(policy), policy]))
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
    schemaVersion: 1,
    planId: `${generation}:${staged.manifest.id}`,
    operation,
    profileId,
    identity: { source: pluginIdentity.source, pluginId: pluginIdentity.id },
    defaultDecision: 'allow',
    declarations: staged.manifest.runtimeManifest.capabilities.map(declaration => {
      const key = permissionRecordKey(createPermissionPolicyRecord({
        profileId,
        identity: pluginIdentity,
        capability: declaration.name,
        scope: declaration.scope,
        policy: 'ask',
      }))
      const policy = policyByKey.get(key)?.policy ?? 'ask'
      return {
        capability: declaration.name,
        required: declaration.required,
        reason: declaration.reason,
        scope: declaration.scope,
        policy,
        decisionRequired: !policyByKey.has(key),
      }
    }),
  }
}

function validateDecision(
  plan: CordisXPermissionAuthorizationPlanV1,
  decision: CordisXPermissionAuthorizationDecisionV1,
): void {
  if (decision.$schema === undefined
    || decision.schemaVersion !== 1
    || decision.planId !== plan.planId
    || decision.operation !== plan.operation
    || decision.profileId !== plan.profileId
    || decision.identity.source !== plan.identity.source
    || decision.identity.pluginId !== plan.identity.pluginId
    || !Array.isArray(decision.decisions)) {
    throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
  }
  const declarations = new Map(plan.declarations.map(item => [item.capability, item]))
  const seen = new Set<string>()
  for (const item of decision.decisions) {
    const declaration = declarations.get(item.capability)
    if (declaration === undefined || seen.has(item.capability)
      || !equalScope(item.scope, declaration.scope, item.capability)) {
      throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
    }
    seen.add(item.capability)
    if (declaration.required && (item.decision === 'deny' || item.decision === 'ask')) {
      throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
    }
  }
  if (seen.size !== declarations.size) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
}

function allowedDecision(plan: CordisXPermissionAuthorizationPlanV1): CordisXPermissionAuthorizationDecisionV1 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
    schemaVersion: 1,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      decision: 'allow',
    })),
  }
}

function impactToken(profileId: string, revision: number, operation: string, pluginId: string, affected: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([profileId, revision, operation, pluginId, affected]))
    .digest('hex')
}

function withGenerations(
  plugins: readonly CordisXPluginActivationItemV1[],
  affected: ReadonlySet<string>,
): readonly CordisXPluginActivationItemV1[] {
  return plugins.map(plugin => affected.has(plugin.id)
    ? { ...plugin, moduleGeneration: `${plugin.id}-${randomUUID()}` }
    : plugin)
}

function runtimeObservation(record: CordisXPluginActivationRecordV1, registryEpoch: number): PackageRuntimeObservation {
  return {
    profileActivationRevision: record.revision,
    registryEpoch,
    runtimeGeneration: record.runtimeGeneration,
    plugins: Object.fromEntries(record.plugins.map(plugin => [plugin.id, {
      version: plugin.version,
      digest: plugin.digest,
      moduleGeneration: plugin.moduleGeneration,
      dependencies: plugin.dependencies,
    }])),
  }
}

function changedTarget(
  previous: CordisXPluginActivationRecordV1,
  candidate: CordisXPluginActivationRecordV1,
): string {
  const prior = new Map(previous.plugins.map(plugin => [plugin.id, plugin]))
  const changed = candidate.plugins.filter(plugin => {
    const old = prior.get(plugin.id)
    return old === undefined
      || old.digest !== plugin.digest
      || old.version !== plugin.version
      || JSON.stringify(old.dependencies) !== JSON.stringify(plugin.dependencies)
  })
  if (changed.length !== 1) throw new LifecycleFailure('activation-failed', safeError('activation-failed'))
  return changed[0]!.id
}

export class PluginLifecycleCoordinator {
  readonly store: PluginActivationStore
  private readonly reservedPluginIds: ReadonlySet<string>
  private readonly pendingPermissionReviews = new Map<string, PendingPermissionReview>()
  private readonly receiptAuthority = createHostRegistryReceiptAuthority()
  private readonly authority: Promise<PackageLifecycleAuthority>
  private preparedRecovery: {
    readonly completed: readonly string[]
    readonly rollbacks: readonly { access: RollbackAccess; plan: RollbackPlan }[]
  } | undefined

  constructor(private readonly options: CoordinatorOptions) {
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
        decisionId: `${input.transactionId}:${createHash('sha256').update(JSON.stringify(pending.decision)).digest('hex')}`,
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
      if (this.options.runtime.recoverRollback === undefined) throw new Error('shared registry rollback recovery is unavailable')
      const restored = await this.options.runtime.recoverRollback(plan)
      if (restored.transactionId !== plan.transactionId
        || restored.transactionEpoch !== plan.transactionEpoch
        || restored.registryEpoch !== plan.rollbackRegistryEpoch
        || JSON.stringify(restored.active.plugins) !== JSON.stringify(plan.rollbackTarget.plugins)
        || JSON.stringify(restored.disposedAfter.plugins) !== JSON.stringify(plan.expectedPublished.plugins)) {
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

  private async active(request: CordisXPluginLifecycleRequestV1): Promise<CordisXPluginActivationRecordV1> {
    if (request.profileId !== this.options.profileId) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    if (request.runtimeGeneration !== this.options.runtimeGeneration) throw new LifecycleFailure('stale-generation', safeError('stale-generation'), 'conflict')
    const active = await this.store.loadActive()
    if (request.expectedRevision !== active.revision) throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    return active
  }

  private failed(
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

  private async inspect(
    request: CordisXPluginLifecycleRequestV1,
    active: CordisXPluginActivationRecordV1,
    sourceDirectory: string,
  ): Promise<CordisXPluginLifecycleResultV1> {
    let staged: StagedPluginPackage
    try {
      staged = await stageLocalPluginPackage(this.options.homeDir, sourceDirectory)
    } catch (error) {
      throw classify(error)
    }
    if (this.reservedPluginIds.has(staged.manifest.id)) {
      throw new LifecycleFailure('operation-unavailable', 'A launcher-configured plugin already owns this id.')
    }
    const existing = active.plugins.find(plugin => plugin.id === staged.manifest.id)
    if (existing?.digest === staged.digest) throw new LifecycleFailure('operation-unavailable', 'This exact package is already active.')
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
      : [...new Set([
          ...pluginDependentClosure(active.plugins, nextItem.id),
          ...pluginDependentClosure(provisional, nextItem.id),
        ])]
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
    const plan = authorizationPlan(staged, operation, this.options.profileId, this.options.runtimeGeneration, this.options.permissionPolicies)
    return {
      ...resultBase(request, active, operation),
      outcome: 'planned',
      scope: 'plugin-generation',
      affectedPluginIds: affected,
      candidateId: transactionId,
      impactToken: impactToken(active.profileId, active.revision, operation, staged.manifest.id, affected),
      package: packageSummary(staged),
      authorizationPlan: plan,
    }
  }

  private async applyPackage(
    request: CordisXPluginLifecycleRequestV1,
    active: CordisXPluginActivationRecordV1,
    candidateId: string,
    decision: CordisXPermissionAuthorizationDecisionV1,
    operation: 'install' | 'update',
  ): Promise<CordisXPluginLifecycleResultV1> {
    const candidate = await this.store.loadCandidate(candidateId).catch(() => {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    })
    if (candidate.lastGoodRevision !== active.revision) throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    const targetId = changedTarget(active, candidate)
    const existing = active.plugins.some(plugin => plugin.id === targetId)
    if ((operation === 'install') === existing) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    const target = candidate.plugins.find(plugin => plugin.id === targetId)!
    const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
    const plan = authorizationPlan(staged, operation, this.options.profileId, this.options.runtimeGeneration, this.options.permissionPolicies)
    validateDecision(plan, decision)
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

  private formalRuntime(): (PluginLifecycleRuntime & Required<Pick<PluginLifecycleRuntime,
  'prepare' | 'publish' | 'complete' | 'finalize' | 'rollback'>>) | undefined {
    const runtime = this.options.runtime
    return runtime.prepare === undefined || runtime.publish === undefined
      || runtime.complete === undefined || runtime.finalize === undefined || runtime.rollback === undefined
      ? undefined
      : runtime as PluginLifecycleRuntime & Required<Pick<PluginLifecycleRuntime,
        'prepare' | 'publish' | 'complete' | 'finalize' | 'rollback'>>
  }

  private async activateWithAuthority(input: {
    readonly operation: 'install' | 'update' | 'enable' | 'disable' | 'uninstall'
    readonly active: CordisXPluginActivationRecordV1
    readonly candidate: CordisXPluginActivationRecordV1
    readonly targetId: string
    readonly staged?: StagedPluginPackage
    readonly authorizationPlan: CordisXPermissionAuthorizationPlanV1
    readonly authorizationDecision: CordisXPermissionAuthorizationDecisionV1
  }): Promise<CordisXPluginActivationRecordV1 | undefined> {
    const runtime = this.formalRuntime()
    if (runtime === undefined) return undefined
    const transactionId = input.candidate.transactionId!
    const fence = runtime.prepare(transactionId)
    this.pendingPermissionReviews.set(transactionId, {
      candidateId: transactionId,
      plan: input.authorizationPlan,
      decision: input.authorizationDecision,
    })
    let prepared: PreparedCandidate | undefined
    let access: CandidateAccess | undefined
    let activationRequested = false
    let published = false
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
      if (resolvedStage.candidateFingerprint !== prepared.candidateFingerprint
        || JSON.stringify(resolvedStage.affectedPluginIds) !== JSON.stringify(stagePlan.affectedPluginIds)) {
        throw new Error('Host candidate plan changed across plan and stage boundaries')
      }
      await authority.resolveImpact({
        ownerId: access.ownerId,
        profileId: access.profileId,
        impactToken: prepared.impactToken,
      }, 'stage')
      let runtimeArtifactSource: string | undefined
      let stageResolutionFailure: unknown
      for (const pluginId of resolvedStage.activationOrder) {
        if (resolvedStage.after.plugins.some(plugin => plugin.id === pluginId)) {
          try {
            const runtimeModule = await authority.resolveRuntimeModule(access, 'stage', pluginId)
            if (pluginId === input.targetId && input.staged !== undefined) {
              runtimeArtifactSource = await loadPluginGenerationArtifact(runtimeModule)
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
        authorizationDecision: input.authorizationDecision,
      })
      if (readiness === undefined) throw new Error('shared registry readiness observation is unavailable')
      if (readiness.transactionId !== transactionId
        || readiness.transactionEpoch !== resolvedStage.transactionEpoch
        || readiness.expectedRegistryEpoch !== resolvedStage.expectedRegistryEpoch
        || readiness.afterRegistryEpoch !== resolvedStage.afterRegistryEpoch
        || JSON.stringify(runtimeObservation(readiness.observation, readiness.afterRegistryEpoch))
          !== JSON.stringify(runtimeObservation(input.candidate, resolvedStage.afterRegistryEpoch))) {
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
      if (publication.transactionEpoch !== publishPlan.transactionEpoch
        || publication.registryEpoch !== publishPlan.afterRegistryEpoch
        || JSON.stringify(publication.active.plugins) !== JSON.stringify(input.candidate.plugins)) {
        throw new Error('shared registry publication observation is stale')
      }
      const committed = await authority.commit(access)
      const cleanup = await runtime.complete(transactionId)
      if (cleanup.registryEpoch !== publishPlan.afterRegistryEpoch
        || JSON.stringify(cleanup.active.plugins) !== JSON.stringify(input.candidate.plugins)
        || JSON.stringify(cleanup.disposedAfter.plugins) !== JSON.stringify(input.active.plugins)) {
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
      await runtime.finalize(transactionId)
      return committed
    } catch (error) {
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
            await authority.completeRollback({
              ownerId: access.ownerId,
              profileId: access.profileId,
              rollbackToken: rollback.rollbackToken,
            }, rollbackReceipt)
          } catch (rollbackError) {
            throw new LifecycleFailure(
              'rollback-failed',
              `${safeError('rollback-failed')} (${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
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

  private mutationCandidate(
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
      plugins = withGenerations(active.plugins.map(plugin => changed.has(plugin.id)
        ? { ...plugin, enabled: operation === 'enable' ? true : false }
        : plugin), changed)
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

  private async applyStateMutation(
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
      return {
        ...resultBase(request, active, operation),
        outcome: 'planned',
        scope: 'plugin-generation',
        affectedPluginIds: affected,
        candidateId: candidate.transactionId!,
        impactToken: expectedImpact,
        package: await this.summaryFor(active.plugins.find(plugin => plugin.id === pluginId)!),
        authorizationPlan: await this.planFor(active.plugins.find(plugin => plugin.id === pluginId)!, 'install'),
      }
    }
    let staged: StagedPluginPackage | undefined
    let reviewPlan: CordisXPermissionAuthorizationPlanV1
    let reviewDecision: CordisXPermissionAuthorizationDecisionV1
    if (operation === 'enable') {
      const target = active.plugins.find(plugin => plugin.id === pluginId)!
      staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
      const plan = authorizationPlan(staged, 'enable', this.options.profileId, this.options.runtimeGeneration, this.options.permissionPolicies)
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
      reviewPlan = await this.planFor(active.plugins.find(plugin => plugin.id === pluginId)!, 'install')
      reviewDecision = allowedDecision(reviewPlan)
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

  private async summaryFor(item: CordisXPluginActivationItemV1): Promise<CordisXPluginLifecyclePackageSummaryV1> {
    return packageSummary(await loadStagedPluginPackage(this.options.homeDir, item.digest))
  }

  private async planFor(item: CordisXPluginActivationItemV1, operation: 'install' | 'update' | 'enable'): Promise<CordisXPermissionAuthorizationPlanV1> {
    return authorizationPlan(
      await loadStagedPluginPackage(this.options.homeDir, item.digest),
      operation,
      this.options.profileId,
      this.options.runtimeGeneration,
      this.options.permissionPolicies,
    )
  }

  async handle(request: CordisXPluginLifecycleRequestV1): Promise<CordisXPluginLifecycleResultV1> {
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
        return await this.applyPackage(request, active, operation.candidateId, operation.authorizationDecision, operation.kind)
      }
      if (operation.kind === 'enable') {
        return await this.applyStateMutation(request, active, 'enable', operation.pluginId, operation.authorizationDecision)
      }
      if (operation.kind === 'disable' || operation.kind === 'uninstall') {
        return await this.applyStateMutation(request, active, operation.kind, operation.pluginId, undefined, operation.impactToken)
      }
      if (operation.kind !== 'reload') throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
      const item = active.plugins.find(plugin => plugin.id === operation.pluginId)
      if (item === undefined || !item.enabled) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
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
      return this.failed(request, active, classify(error))
    }
  }
}
