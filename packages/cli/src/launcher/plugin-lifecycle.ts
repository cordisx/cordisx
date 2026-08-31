import { createHash, randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
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
import { createPermissionPolicyRecord, normalizePermissionScope, permissionRecordKey, permissionScopeFingerprint } from '../permissions.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationPlanV4,
  type CordisXPermissionAuthorizationPlanV5,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionDecisionV2,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyRecordV4,
} from '../permission-contracts.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV4,
  type CordisXPersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import {
  CapabilityRiskCatalog,
  buildPermissionAuthorizationPlanV2,
  buildPermissionAuthorizationPlanV5,
} from '../capability-risk-catalog.js'
import {
  assertPermissionAuthorizationDecisionV2,
  normalizePluginManifestV4,
} from '../permission-model-v2.js'
import {
  assertPermissionAuthorizationDecisionV4,
  normalizeCertifiedPermissionProjectionV1,
  normalizePluginManifestV5,
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
  stageLocalPluginPackage,
  type StagedPluginPackage,
} from './plugin-package.js'
import { stagePluginPackageSourceV1 } from './packages/delivery.js'
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
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'

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
  /** Host-private candidate for one explicitly selected local development entry. */
  readonly developmentPackage?: {
    readonly id: string
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly identitySource: string
    readonly readme?: string
    readonly development: CordisXLocalDevelopmentSnapshot
  }
  /** Host-only renderer artifact compiled from the authority-resolved immutable runtime module. */
  readonly runtimeArtifactSource?: string
  readonly authorizationDecision?: CordisXPermissionAuthorizationDecisionV1 | CordisXPermissionAuthorizationDecisionV2 | CordisXPermissionAuthorizationDecisionV4
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
  readonly permissionPolicies: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly loadPermissionPolicies?: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
  /** Launcher-owned trust lookup. Renderer/plugin requests cannot populate this projection. */
  readonly certifiedPermissionForArtifact?: (artifact: Readonly<{
    source: string
    pluginId: string
    version: string
    integrity: `sha256:${string}`
  }>) => Promise<CordisXCertifiedPermissionProjectionV1 | undefined>
  readonly runtime: PluginLifecycleRuntime
  readonly reservedPluginIds?: readonly string[]
}

interface PendingPermissionReview {
  readonly candidateId: string
  readonly plan: CordisXPermissionAuthorizationPlanV1 | CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4 | CordisXPermissionAuthorizationPlanV5
  readonly decision: CordisXPermissionAuthorizationDecisionV1 | CordisXPermissionAuthorizationDecisionV2 | CordisXPermissionAuthorizationDecisionV4
}

export interface HostPermissionLifecycleReviewV2Request {
  readonly requestId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly expectedRevision: number
  readonly target:
    | { readonly kind: 'candidate'; readonly candidateId: string }
    | { readonly kind: 'enable'; readonly pluginId: string }
}

export interface HostPermissionLifecycleApplyV2Request {
  readonly requestId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly expectedRevision: number
  readonly decision: CordisXPermissionAuthorizationDecisionV2
}

export type HostPermissionLifecycleReviewV4Request = HostPermissionLifecycleReviewV2Request

export interface HostPermissionLifecycleApplyV4Request {
  readonly requestId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly expectedRevision: number
  readonly decision: CordisXPermissionAuthorizationDecisionV4
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
  request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
    readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
  },
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
  if (staged.manifest.runtimeManifest.schemaVersion !== 1) {
    throw new LifecycleFailure('permission-denied', 'Permission V2 review must use the Host-private lifecycle seam.')
  }
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

function authorizationPlanV2(
  staged: StagedPluginPackage,
  operation: 'install' | 'update' | 'enable',
  profileId: string,
  generation: string,
  moduleGeneration: string,
  requestId: string,
  policies: readonly CordisXPermissionPolicyRecordV2[],
): CordisXPermissionAuthorizationPlanV2 {
  if (staged.manifest.runtimeManifest.schemaVersion !== 4) {
    throw new LifecycleFailure('permission-denied', 'Permission V2 review requires manifest-v4.')
  }
  const catalog = new CapabilityRiskCatalog()
  return buildPermissionAuthorizationPlanV2({
    planId: `${generation}:${staged.manifest.id}`,
    operation,
    profileId,
    identity: { source: staged.identitySource, pluginId: staged.manifest.id },
    binding: {
      operationId: `${generation}:${staged.manifest.id}`,
      runtimeGeneration: generation,
      moduleGeneration,
      requestId,
    },
    declarations: staged.manifest.runtimeManifest.capabilities,
    policies,
    contextFor: declaration => {
      const family = catalog.get(declaration.name).providerFamily
      return {
        operation,
        providerKind: family === 'platform' ? 'current-connection' : 'host-local',
        providerTrust: 'configured',
        availability: 'supported',
      }
    },
  }, catalog)
}

function authorizationPlanV4(
  staged: StagedPluginPackage,
  operation: 'install' | 'update' | 'enable',
  profileId: string,
  generation: string,
  moduleGeneration: string,
  requestId: string,
  policiesV2: readonly CordisXPermissionPolicyRecordV2[],
  policiesV4: readonly CordisXPermissionPolicyRecordV4[],
  certification?: CordisXCertifiedPermissionProjectionV1,
): CordisXPermissionAuthorizationPlanV5 {
  if (staged.manifest.runtimeManifest.schemaVersion !== 4 && staged.manifest.runtimeManifest.schemaVersion !== 5) {
    throw new LifecycleFailure('permission-denied', 'Permission v5 review requires manifest-v4 or manifest-v5.')
  }
  const catalog = new CapabilityRiskCatalog()
  return buildPermissionAuthorizationPlanV5({
    planId: `${generation}:${staged.manifest.id}`,
    operation,
    profileId,
    identity: { source: staged.identitySource, pluginId: staged.manifest.id },
    binding: {
      operationId: `${generation}:${staged.manifest.id}`,
      runtimeGeneration: generation,
      moduleGeneration,
      requestId,
    },
    declarations: staged.manifest.runtimeManifest.capabilities,
    policiesV2,
    policiesV4,
    ...(certification === undefined ? {} : { certification }),
  }, catalog)
}

function validateDecisionV2(
  plan: CordisXPermissionAuthorizationPlanV2,
  decision: CordisXPermissionAuthorizationDecisionV2,
): void {
  try {
    assertPermissionAuthorizationDecisionV2(plan, decision)
  } catch {
    throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
  }
  if (decision.decisions.some(item => (
    plan.declarations.find(declaration => declaration.capability === item.capability)?.required === true
      && item.decision.startsWith('deny')
  ))) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
}

function validateDecisionV4(
  plan: CordisXPermissionAuthorizationPlanV4 | CordisXPermissionAuthorizationPlanV5,
  decision: CordisXPermissionAuthorizationDecisionV4,
): void {
  try {
    assertPermissionAuthorizationDecisionV4(plan, decision)
  } catch {
    throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
  }
  if (plan.declarations.some(item => item.required
    && item.authorizationMode === 'persistent-policy'
    && item.policy === 'deny-persistent')
    || decision.decisions.some(selected => (
    plan.declarations.find(item => item.capability === selected.capability)?.required === true
      && selected.decision.startsWith('deny')
  ))) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
}

function allowedDecisionV2(plan: CordisXPermissionAuthorizationPlanV2): CordisXPermissionAuthorizationDecisionV2 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => {
      const decision: CordisXPermissionDecisionV2 = item.allowedDecisions.includes('allow-persistent')
        ? 'allow-persistent'
        : 'allow-once'
      return {
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision,
      }
    }),
  }
}

function allowedDecisionV4(plan: CordisXPermissionAuthorizationPlanV4 | CordisXPermissionAuthorizationPlanV5): CordisXPermissionAuthorizationDecisionV4 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
    schemaVersion: 4,
    origin: 'explicit-user',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: item.allowedDecisions.includes('allow-persistent') ? 'allow-persistent' : 'allow-once',
    })),
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

  private async permissionPolicies(): Promise<readonly CordisXPersistedPermissionPolicyRecord[]> {
    return this.options.loadPermissionPolicies === undefined
      ? this.options.permissionPolicies
      : await this.options.loadPermissionPolicies()
  }

  private async permissionPoliciesV1(): Promise<readonly CordisXPermissionPolicyRecordV1[]> {
    return (await this.permissionPolicies()).filter(
      (record): record is CordisXPermissionPolicyRecordV1 => record.schemaVersion === 1,
    )
  }

  private async permissionPoliciesV2(): Promise<readonly CordisXPermissionPolicyRecordV2[]> {
    return (await this.permissionPolicies()).filter(isPermissionPolicyRecordV2)
  }

  private async permissionPoliciesV4(): Promise<readonly CordisXPermissionPolicyRecordV4[]> {
    return (await this.permissionPolicies()).filter(isPermissionPolicyRecordV4)
  }

  private async certifiedPermission(staged: StagedPluginPackage): Promise<CordisXCertifiedPermissionProjectionV1 | undefined> {
    const lookup = this.options.certifiedPermissionForArtifact
    if (lookup === undefined || staged.manifest.runtimeManifest.capabilities.length === 0) return undefined
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

  private async stageLocalSource(sourceDirectory: string): Promise<StagedPluginPackage> {
    const formalManifest = path.join(sourceDirectory, 'cordisx-package.json')
    try {
      await access(formalManifest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return await stageLocalPluginPackage(this.options.homeDir, sourceDirectory)
    }
    return await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(sourceDirectory).href,
    }, {
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
      staged = await this.stageLocalSource(sourceDirectory)
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
    const plan = staged.manifest.runtimeManifest.schemaVersion === 1
      ? authorizationPlan(staged, operation, this.options.profileId, this.options.runtimeGeneration, await this.permissionPoliciesV1())
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

  private async applyPackage(
    request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
      readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
    },
    active: CordisXPluginActivationRecordV1,
    candidateId: string,
    decision: CordisXPermissionAuthorizationDecisionV1 | CordisXPermissionAuthorizationDecisionV2 | CordisXPermissionAuthorizationDecisionV4,
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
        : authorizationPlan(staged, operation, this.options.profileId, this.options.runtimeGeneration, await this.permissionPoliciesV1())
    if (decision.schemaVersion === 4) validateDecisionV4(plan as CordisXPermissionAuthorizationPlanV5, decision)
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
    readonly authorizationPlan: CordisXPermissionAuthorizationPlanV1 | CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4 | CordisXPermissionAuthorizationPlanV5
    readonly authorizationDecision: CordisXPermissionAuthorizationDecisionV1 | CordisXPermissionAuthorizationDecisionV2 | CordisXPermissionAuthorizationDecisionV4
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
      const target = active.plugins.find(plugin => plugin.id === pluginId)!
      const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
      const plan = staged.manifest.runtimeManifest.schemaVersion === 1
        ? authorizationPlan(staged, 'install', this.options.profileId, this.options.runtimeGeneration, await this.permissionPoliciesV1())
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
    let reviewPlan: CordisXPermissionAuthorizationPlanV1 | CordisXPermissionAuthorizationPlanV2 | CordisXPermissionAuthorizationPlanV4 | CordisXPermissionAuthorizationPlanV5
    let reviewDecision: CordisXPermissionAuthorizationDecisionV1 | CordisXPermissionAuthorizationDecisionV2 | CordisXPermissionAuthorizationDecisionV4
    if (operation === 'enable') {
      const target = active.plugins.find(plugin => plugin.id === pluginId)!
      staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
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
      const plan = authorizationPlan(staged, 'enable', this.options.profileId, this.options.runtimeGeneration, await this.permissionPoliciesV1())
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
      const reviewStaged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
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

  private async summaryFor(item: CordisXPluginActivationItemV1): Promise<CordisXPluginLifecyclePackageSummaryV1> {
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
      if (candidate.lastGoodRevision !== active.revision) throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
      const pluginId = changedTarget(active, candidate)
      const existing = active.plugins.some(plugin => plugin.id === pluginId)
      const operation = existing ? 'update' : 'install'
      const target = candidate.plugins.find(plugin => plugin.id === pluginId)!
      const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
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
    if (activeTarget === undefined || activeTarget.enabled) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    const staged = await loadStagedPluginPackage(this.options.homeDir, activeTarget.digest).catch(error => { throw classify(error) })
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

  /** Host-private permission v5 review; uses the same PackageLifecycleAuthority transaction. */
  async permissionReviewPlanV4(
    input: HostPermissionLifecycleReviewV4Request,
  ): Promise<CordisXPermissionAuthorizationPlanV5 | undefined> {
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
      if (candidate.lastGoodRevision !== active.revision) throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
      const pluginId = changedTarget(active, candidate)
      const operation = active.plugins.some(plugin => plugin.id === pluginId) ? 'update' : 'install'
      const target = candidate.plugins.find(plugin => plugin.id === pluginId)!
      const staged = await loadStagedPluginPackage(this.options.homeDir, target.digest).catch(error => { throw classify(error) })
      if (staged.manifest.runtimeManifest.schemaVersion !== 4 && staged.manifest.runtimeManifest.schemaVersion !== 5) return undefined
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
    if (activeTarget === undefined || activeTarget.enabled) throw new LifecycleFailure('operation-unavailable', safeError('operation-unavailable'))
    const staged = await loadStagedPluginPackage(this.options.homeDir, activeTarget.digest).catch(error => { throw classify(error) })
    if (staged.manifest.runtimeManifest.schemaVersion !== 4 && staged.manifest.runtimeManifest.schemaVersion !== 5) return undefined
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

  /** Applies one manifest-v5 review through the existing lifecycle authority. */
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

  private async applyStateMutationV2(
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
    if (candidate.lastGoodRevision !== active.revision || before === undefined || before.enabled || after?.enabled !== true
      || before.digest !== after.digest || before.version !== after.version || before.moduleGeneration === after.moduleGeneration
      || candidate.plugins.length !== active.plugins.length
      || active.plugins.some(item => item.id !== pluginId && JSON.stringify(item) !== JSON.stringify(candidate.plugins.find(next => next.id === item.id)))) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const staged = await loadStagedPluginPackage(this.options.homeDir, after.digest).catch(error => { throw classify(error) })
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

  private async applyStateMutationV4(
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
    if (candidate.lastGoodRevision !== active.revision || before === undefined || before.enabled || after?.enabled !== true
      || before.digest !== after.digest || before.version !== after.version || before.moduleGeneration === after.moduleGeneration
      || candidate.plugins.length !== active.plugins.length
      || active.plugins.some(item => item.id !== pluginId && JSON.stringify(item) !== JSON.stringify(candidate.plugins.find(next => next.id === item.id)))) {
      throw new LifecycleFailure('stale-revision', safeError('stale-revision'), 'conflict')
    }
    const staged = await loadStagedPluginPackage(this.options.homeDir, after.digest).catch(error => { throw classify(error) })
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

  private async planFor(item: CordisXPluginActivationItemV1, operation: 'install' | 'update' | 'enable'): Promise<CordisXPermissionAuthorizationPlanV1> {
    return authorizationPlan(
      await loadStagedPluginPackage(this.options.homeDir, item.digest),
      operation,
      this.options.profileId,
      this.options.runtimeGeneration,
      await this.permissionPoliciesV1(),
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
