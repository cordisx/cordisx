import type { CordisXPluginManifestV10 } from '../extension-point-interaction-permissions.js'
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
  type CordisXPluginManifestV9,
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
    readonly readmes?: Readonly<Record<string, string>>
    readonly manifest?:
      | CordisXPluginManifestV7
      | CordisXPluginManifestV8
      | CordisXPluginManifestV9
      | CordisXPluginManifestV10
    readonly development: CordisXLocalDevelopmentSnapshot
  }
  /** Host-only renderer artifact compiled from the authority-resolved immutable runtime module. */
  readonly runtimeArtifactSource?: string
  /** Host-only browser graph lease; never projected into renderer mutation data. */
  readonly runtimeArtifactLease?: PluginGenerationGraphLease
  /** Host-only browser graph leases for the complete affected dependency closure. */
  readonly runtimeArtifactLeases?: readonly PluginGenerationGraphLease[]
  readonly authorizationDecision?:
    | CordisXPermissionAuthorizationDecisionV1
    | CordisXPermissionAuthorizationDecisionV2
    | CordisXPermissionAuthorizationDecisionV4
}

/** Stable renderer adapter. `stage` is reversible until `commit` acknowledges durable publication. */
export interface PluginLifecycleRuntime {
  prepare?(transactionId: string): RuntimeGenerationFence
  /** Host-private first-browser-graph admission; it returns with the normal generation fence already held. */
  prepareBrowserGraph?(
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): Promise<RuntimeGenerationFence>
  stage(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation>
  publish?(transactionId: string): Promise<RuntimePublicationObservation>
  complete?(transactionId: string): Promise<RuntimeCleanupObservation>
  finalize?(transactionId: string): Promise<void>
  /** Host-private terminal latch for a post-commit renderer projection failure. */
  terminal?(error: unknown): void
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

export interface CoordinatorOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly permissionPolicies: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly loadPermissionPolicies?: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
  /** Launcher-owned trust lookup. Renderer/plugin requests cannot populate this projection. */
  readonly certifiedPermissionForArtifact?: (
    artifact: Readonly<{
      source: string
      pluginId: string
      version: string
      integrity: `sha256:${string}`
    }>,
  ) => Promise<CordisXCertifiedPermissionProjectionV1 | undefined>
  readonly runtime: PluginLifecycleRuntime
  readonly pluginGenerationArtifactServer?: PluginGenerationArtifactServer
  readonly reservedPluginIds?: readonly string[]
}

export interface PendingPermissionReview {
  readonly candidateId: string
  readonly plan:
    | CordisXPermissionAuthorizationPlanV1
    | CordisXPermissionAuthorizationPlanV2
    | CordisXPermissionAuthorizationPlanV4
  readonly decision:
    | CordisXPermissionAuthorizationDecisionV1
    | CordisXPermissionAuthorizationDecisionV2
    | CordisXPermissionAuthorizationDecisionV4
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

export class LifecycleFailure extends Error {
  constructor(
    readonly code: CordisXPluginLifecycleErrorCode,
    message: string,
    readonly outcome: CordisXPluginLifecycleResultV1['outcome'] = 'rejected',
  ) {
    super(message)
  }
}

export function safeError(code: CordisXPluginLifecycleErrorCode): string {
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

export function classify(error: unknown): LifecycleFailure {
  if (error instanceof LifecycleFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('runtime ABI') || message.includes('protocol')) {
    return new LifecycleFailure('incompatible-runtime', safeError('incompatible-runtime'))
  }
  if (message.includes('integrity')) return new LifecycleFailure('integrity-failed', safeError('integrity-failed'))
  if (message.includes('missing dependency')) {
    return new LifecycleFailure('dependency-missing', safeError('dependency-missing'))
  }
  if (message.includes('requires') && message.includes('found')) {
    return new LifecycleFailure('dependency-version', safeError('dependency-version'))
  }
  if (message.includes('cycle')) return new LifecycleFailure('dependency-cycle', safeError('dependency-cycle'))
  if (message.includes('build') || message.includes('bundle a second')) {
    return new LifecycleFailure('build-failed', safeError('build-failed'))
  }
  if (message.includes('manifest') || message.includes('package.')) {
    return new LifecycleFailure('invalid-manifest', safeError('invalid-manifest'))
  }
  return new LifecycleFailure('invalid-source', safeError('invalid-source'))
}

export function resultBase(
  request: Pick<CordisXPluginLifecycleRequestV1, 'requestId' | 'profileId' | 'runtimeGeneration'> & {
    readonly operation: { readonly kind: CordisXPluginLifecycleResultV1['operation'] }
  },
  active: CordisXPluginActivationRecordV1,
  operation = request.operation.kind,
): Pick<
  CordisXPluginLifecycleResultV1,
  '$schema' | 'schemaVersion' | 'requestId' | 'profileId' | 'operation' | 'revision' | 'runtimeGeneration'
> {
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

export function packageSummary(staged: StagedPluginPackage): CordisXPluginLifecyclePackageSummaryV1 {
  return {
    id: staged.manifest.id,
    ...(staged.manifest.runtimeManifest.name === undefined ? {} : { name: staged.manifest.runtimeManifest.name }),
    version: staged.manifest.version,
    digest: staged.digest,
    dependencies: staged.manifest.dependencies,
    ...(staged.manifest.canonicalSource === undefined ? {} : { canonicalSource: staged.manifest.canonicalSource }),
  }
}

export function identity(staged: StagedPluginPackage): CordisXPluginIdentity {
  return { source: staged.identitySource, id: staged.manifest.id }
}

export function equalScope(
  left: unknown,
  right: unknown,
  capability: Parameters<typeof permissionScopeFingerprint>[0],
): boolean {
  return permissionScopeFingerprint(capability, normalizePermissionScope(left))
    === permissionScopeFingerprint(capability, normalizePermissionScope(right))
}

export function authorizationPlan(
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

export function authorizationPlanV2(
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
    declarations: staged.manifest.runtimeManifest.capabilities.filter(isLegacyPermissionDeclarationV4),
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

export function authorizationPlanV4(
  staged: StagedPluginPackage,
  operation: 'install' | 'update' | 'enable',
  profileId: string,
  generation: string,
  moduleGeneration: string,
  requestId: string,
  policiesV2: readonly CordisXPermissionPolicyRecordV2[],
  policiesV4: readonly CordisXPermissionPolicyRecordV4[],
  certification?: CordisXCertifiedPermissionProjectionV1,
): CordisXPermissionAuthorizationPlanV4 {
  if (
    staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6
    && staged.manifest.runtimeManifest.schemaVersion !== 7 && staged.manifest.runtimeManifest.schemaVersion !== 8
  ) {
    throw new LifecycleFailure(
      'permission-denied',
      'Permission V4 review requires manifest-v5, manifest-v6, manifest-v7, or manifest-v8.',
    )
  }
  const catalog = new CapabilityRiskCatalog()
  return buildPermissionAuthorizationPlanV4({
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
    declarations: staged.manifest.runtimeManifest.capabilities.filter(
      isLegacyPermissionDeclarationV4,
    ) as readonly CordisXCapabilityDeclarationV4[],
    policiesV2,
    policiesV4,
    ...(certification === undefined ? {} : { certification }),
  }, catalog)
}

export function isLegacyPermissionDeclarationV4(
  declaration: Readonly<{ readonly name: string }>,
): boolean {
  return !(declaration.name.startsWith('agents.')
    || declaration.name.startsWith('sessions.')
    || declaration.name.startsWith('approvals.'))
}

export function validateDecisionV2(
  plan: CordisXPermissionAuthorizationPlanV2,
  decision: CordisXPermissionAuthorizationDecisionV2,
): void {
  try {
    assertPermissionAuthorizationDecisionV2(plan, decision)
  } catch {
    throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
  }
  if (
    decision.decisions.some(item => (
      plan.declarations.find(declaration => declaration.capability === item.capability)?.required === true
      && item.decision.startsWith('deny')
    ))
  ) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
}

export function validateDecisionV4(
  plan: CordisXPermissionAuthorizationPlanV4,
  decision: CordisXPermissionAuthorizationDecisionV4,
): void {
  try {
    assertPermissionAuthorizationDecisionV4(plan, decision)
  } catch {
    throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
  }
  if (
    plan.declarations.some(item =>
      item.required
      && item.authorizationMode === 'persistent-policy'
      && item.policy === 'deny-persistent'
    )
    || decision.decisions.some(selected => (
      plan.declarations.find(item => item.capability === selected.capability)?.required === true
      && selected.decision.startsWith('deny')
    ))
  ) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
}

export function allowedDecisionV2(
  plan: CordisXPermissionAuthorizationPlanV2,
): CordisXPermissionAuthorizationDecisionV2 {
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

export function allowedDecisionV4(
  plan: CordisXPermissionAuthorizationPlanV4,
): CordisXPermissionAuthorizationDecisionV4 {
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

export function validateDecision(
  plan: CordisXPermissionAuthorizationPlanV1,
  decision: CordisXPermissionAuthorizationDecisionV1,
): void {
  if (
    decision.$schema === undefined
    || decision.schemaVersion !== 1
    || decision.planId !== plan.planId
    || decision.operation !== plan.operation
    || decision.profileId !== plan.profileId
    || decision.identity.source !== plan.identity.source
    || decision.identity.pluginId !== plan.identity.pluginId
    || !Array.isArray(decision.decisions)
  ) {
    throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
  }
  const declarations = new Map(plan.declarations.map(item => [item.capability, item]))
  const seen = new Set<string>()
  for (const item of decision.decisions) {
    const declaration = declarations.get(item.capability)
    if (
      declaration === undefined || seen.has(item.capability)
      || !equalScope(item.scope, declaration.scope, item.capability)
    ) {
      throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
    }
    seen.add(item.capability)
    if (declaration.required && (item.decision === 'deny' || item.decision === 'ask')) {
      throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
    }
  }
  if (seen.size !== declarations.size) throw new LifecycleFailure('permission-denied', safeError('permission-denied'))
}

export function allowedDecision(plan: CordisXPermissionAuthorizationPlanV1): CordisXPermissionAuthorizationDecisionV1 {
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

export function impactToken(
  profileId: string,
  revision: number,
  operation: string,
  pluginId: string,
  affected: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([profileId, revision, operation, pluginId, affected]))
    .digest('hex')
}

export function withGenerations(
  plugins: readonly CordisXPluginActivationItemV1[],
  affected: ReadonlySet<string>,
): readonly CordisXPluginActivationItemV1[] {
  return plugins.map(plugin =>
    affected.has(plugin.id)
      ? { ...plugin, moduleGeneration: `${plugin.id}-${randomUUID()}` }
      : plugin
  )
}

export function runtimeObservation(
  record: CordisXPluginActivationRecordV1,
  registryEpoch: number,
): PackageRuntimeObservation {
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

export function usesIsolatedWorker(
  manifest: StagedPluginPackage['manifest']['runtimeManifest'] | undefined,
): boolean {
  return manifest !== undefined && (manifest.schemaVersion === 7
    || ((manifest.schemaVersion === 5 || manifest.schemaVersion === 6)
      && manifest.capabilities.some(capability => (
        capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'
      ))))
}

export function changedTarget(
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
