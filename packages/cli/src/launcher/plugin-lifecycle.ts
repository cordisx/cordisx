import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
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

export interface PluginRuntimeMutation {
  readonly transactionId: string
  readonly operation: 'install' | 'update' | 'enable' | 'disable' | 'uninstall'
  readonly previous: CordisXPluginActivationRecordV1
  readonly candidate: CordisXPluginActivationRecordV1
  readonly targetId: string
  readonly affectedPluginIds: readonly string[]
  readonly package?: StagedPluginPackage
  readonly authorizationDecision?: CordisXPermissionAuthorizationDecisionV1
}

/** Stable renderer adapter. `stage` is reversible until `commit` acknowledges durable publication. */
export interface PluginLifecycleRuntime {
  stage(mutation: PluginRuntimeMutation): Promise<void>
  commit(transactionId: string): Promise<void>
  abort(transactionId: string): Promise<void>
  reload(input: {
    readonly pluginId: string
    readonly moduleGeneration: string
    readonly runtimeGeneration: string
  }): Promise<void>
}

interface CoordinatorOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly permissionPolicies: readonly CordisXPermissionPolicyRecordV1[]
  readonly runtime: PluginLifecycleRuntime
  readonly reservedPluginIds?: readonly string[]
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

  constructor(private readonly options: CoordinatorOptions) {
    if (!path.isAbsolute(options.homeDir)) throw new Error('CordisX home directory must be absolute')
    this.store = new PluginActivationStore(options.homeDir, options.profileId, options.runtimeGeneration)
    this.reservedPluginIds = new Set(options.reservedPluginIds ?? [])
  }

  async recover(): Promise<readonly string[]> {
    return this.store.recoverIncompleteCandidates()
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
