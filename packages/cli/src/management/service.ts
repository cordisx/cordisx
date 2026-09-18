import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import path from 'node:path'
import { loadHomeConfig } from '../config/home-config.js'
import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginActivationItemV1,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import {
  allowedDecision,
  allowedDecisionV2,
  allowedDecisionV4,
  impactToken,
  type PluginLifecycleRuntime,
  type PluginRuntimeMutation,
} from '../launcher/plugin-lifecycle-model.js'
import { pluginDependentClosure } from '../launcher/plugin-activation.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { inspectMarketplaceArtifactPackage } from '../launcher/marketplace-artifact.js'
import { createPluginManagementCatalog } from './catalog.js'
import {
  type PluginManagementCatalogDetail,
  type PluginManagementCatalogQuery,
  type PluginManagementCatalogSnapshot,
  type PluginManagementCatalogSummary,
  type PluginManagementConfigRequest,
  type PluginManagementLegacySourceMigration,
  type PluginManagementMigrationResult,
  type PluginManagementPermissionPlan,
  type PluginManagementPlugin,
  type PluginManagementPluginRequest,
  type PluginManagementRequest,
  type PluginManagementResult,
  type PluginManagementSnapshot,
} from './contracts.js'
import {
  loadPluginManagementConfig,
  migrateLegacyPluginManagementSources,
  planPluginManagementConfig,
  type PluginManagementPersistenceOptions,
  projectPluginManagementSources,
  updatePluginManagementConfig,
} from './persistence.js'

export interface ActivePluginManagementLifecycle {
  readonly coordinator: PluginLifecycleCoordinator
  readonly runtimeGeneration: string
}

export interface OpenPluginManagementServiceOptions extends PluginManagementPersistenceOptions {
  readonly homeDir?: string
  readonly lifecycle?: ActivePluginManagementLifecycle
  readonly watch?: boolean
}

export interface PluginManagementService {
  query(): Promise<PluginManagementSnapshot>
  refreshCatalog(sourceUrl?: string): Promise<PluginManagementCatalogSnapshot>
  queryCatalog(query?: PluginManagementCatalogQuery): Promise<readonly PluginManagementCatalogSummary[]>
  pluginInfo(query: { readonly pluginId: string; readonly sourceUrl?: string; readonly version?: string }): Promise<
    PluginManagementCatalogDetail | undefined
  >
  plan(request: PluginManagementRequest): Promise<PluginManagementResult>
  execute(request: PluginManagementRequest, expectedRevision?: number): Promise<PluginManagementResult>
  migrateLegacySources(input: PluginManagementLegacySourceMigration): Promise<PluginManagementMigrationResult>
  subscribe(listener: (snapshot: PluginManagementSnapshot) => void): () => void
  close(): void
}

class InactivePluginLifecycleRuntime implements PluginLifecycleRuntime {
  async stage(_mutation: PluginRuntimeMutation): Promise<void> {}
  async commit(_transactionId: string): Promise<void> {}
  async abort(_transactionId: string): Promise<void> {}
  async reload(): Promise<void> {
    throw new Error('Plugin reload requires a running CordisX renderer.')
  }
}

function configRequest(request: PluginManagementRequest): request is PluginManagementConfigRequest {
  return request.kind.startsWith('source-') || request.kind.startsWith('catalog-')
}

type PluginManagementPlanIntent = Exclude<PluginManagementPluginRequest, { readonly kind: 'plugin-execute-plan' }>

function lifecycleOperation(
  request: PluginManagementPlanIntent,
  confirmedImpactToken?: string,
): CordisXPluginLifecycleOperationV1 {
  if (request.kind === 'plugin-plan-local') {
    return { kind: 'inspect-local', sourceDirectory: request.sourceDirectory }
  }
  if (request.kind === 'plugin-plan-marketplace') {
    throw new Error('Marketplace planning requires catalog artifact resolution.')
  }
  if (request.kind === 'plugin-enable') {
    return { kind: 'enable', pluginId: request.pluginId }
  }
  if (request.kind === 'plugin-disable') {
    return { kind: 'disable', pluginId: request.pluginId, impactToken: confirmedImpactToken ?? 'management-plan' }
  }
  return { kind: 'uninstall', pluginId: request.pluginId, impactToken: confirmedImpactToken ?? 'management-plan' }
}

function availableOperations(item: CordisXPluginActivationItemV1): PluginManagementPlugin['availableOperations'] {
  return item.enabled
    ? ['update', 'disable', 'share', 'uninstall']
    : ['update', 'enable', 'share', 'uninstall']
}

async function runtimeItem(
  homeDir: string,
  item: CordisXPluginActivationItemV1,
  plugins: readonly CordisXPluginActivationItemV1[],
  activeRuntime: boolean,
): Promise<PluginManagementPlugin> {
  const staged = await loadStagedPluginPackage(homeDir, item.digest).catch(() => undefined)
  const status = staged === undefined
    ? 'failed'
    : item.enabled
    ? (activeRuntime ? 'active' : 'pending-activation')
    : 'disabled'
  return {
    id: item.id,
    name: item.id,
    version: item.version,
    digest: item.digest,
    moduleGeneration: item.moduleGeneration,
    enabled: item.enabled,
    status,
    dependencies: item.dependencies.map(dependency => dependency.id),
    dependents: plugins
      .filter(plugin => plugin.dependencies.some(dependency => dependency.id === item.id))
      .map(plugin => plugin.id),
    favorite: false,
    availableOperations: availableOperations(item),
    ...(item.canonicalSource === undefined ? {} : { canonicalSource: item.canonicalSource }),
    ...(staged === undefined
      ? { error: { code: 'package-unavailable', message: 'Installed package is unavailable.' } }
      : {}),
  }
}

function permissionPlan(result: CordisXPluginLifecycleResultV1): PluginManagementPermissionPlan | undefined {
  return result.authorizationPlan
}

function persistedDecisionV1(plan: Extract<PluginManagementPermissionPlan, { readonly schemaVersion: 1 }>) {
  return {
    ...allowedDecision(plan),
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      decision: item.policy,
    })),
  }
}

function persistedDecisionV2(plan: Extract<PluginManagementPermissionPlan, { readonly schemaVersion: 2 }>) {
  return {
    ...allowedDecisionV2(plan),
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: item.policy === 'allow-persistent' ? 'allow-persistent' as const : 'deny-persistent' as const,
    })),
  }
}

export async function openPluginManagementService(
  options: OpenPluginManagementServiceOptions,
): Promise<PluginManagementService> {
  const homeDir = options.homeDir ?? path.dirname(options.configPath)
  const inactiveRuntimeGeneration = `inactive-${randomUUID()}`
  const initialStore = new PluginActivationStore(homeDir, options.profileId, inactiveRuntimeGeneration)
  const [initialManagement, existing] = await Promise.all([
    loadPluginManagementConfig(options),
    initialStore.loadActive(),
  ])
  const runtimeGeneration = options.lifecycle?.runtimeGeneration ?? inactiveRuntimeGeneration
  let inactiveCoordinator: PluginLifecycleCoordinator | undefined
  const coordinator = async (): Promise<PluginLifecycleCoordinator> => {
    if (options.lifecycle !== undefined) return options.lifecycle.coordinator
    if (inactiveCoordinator !== undefined) return inactiveCoordinator
    const permissionPolicies = async () => {
      try {
        return (await loadHomeConfig(options.configPath)).permissions.filter(policy =>
          policy.key.profileId === options.profileId
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return []
      }
    }
    inactiveCoordinator = new PluginLifecycleCoordinator({
      homeDir,
      profileId: options.profileId,
      runtimeGeneration: inactiveRuntimeGeneration,
      permissionPolicies: await permissionPolicies(),
      loadPermissionPolicies: permissionPolicies,
      runtime: new InactivePluginLifecycleRuntime(),
    })
    return inactiveCoordinator
  }
  const listeners = new Set<(snapshot: PluginManagementSnapshot) => void>()
  const watchers: FSWatcher[] = []
  let poller: ReturnType<typeof setInterval> | undefined
  let closed = false
  let notifyQueued = false
  let notifyTimer: ReturnType<typeof setTimeout> | undefined
  let deliveredFingerprint: string | undefined
  let observedManagementRevision = initialManagement.revision
  let observedActivationRevision = existing.revision
  let observationInFlight = false
  const catalog = createPluginManagementCatalog(options)
  const executionPlans = new Map<string, {
    readonly request: PluginManagementPlanIntent
    readonly activationRevision: number
    readonly impactToken?: string
  }>()

  const query = async (): Promise<PluginManagementSnapshot> => {
    const [management, activation] = await Promise.all([
      loadPluginManagementConfig(options),
      (options.lifecycle?.coordinator.store ?? initialStore).loadActive(),
    ])
    const plugins = await Promise.all(
      activation.plugins.map(item => runtimeItem(homeDir, item, activation.plugins, options.lifecycle !== undefined)),
    )
    return {
      profileId: options.profileId,
      revision: management.revision,
      sources: projectPluginManagementSources(management),
      hiddenCatalogEntries: management.hiddenCatalogEntries,
      migrations: { legacyBrowserSourcesV2: management.migrations?.legacyBrowserSourcesV2 === true },
      runtime: options.lifecycle === undefined
        ? { kind: 'inactive', pendingActivation: activation.plugins.some(plugin => plugin.enabled) }
        : { kind: 'active', runtimeGeneration },
      activationRevision: activation.revision,
      plugins,
    }
  }

  const emitSnapshot = (snapshot: PluginManagementSnapshot): void => {
    observedManagementRevision = snapshot.revision
    observedActivationRevision = snapshot.activationRevision
    const fingerprint = `${snapshot.revision}:${snapshot.activationRevision}:${JSON.stringify(snapshot.runtime)}`
    if (closed || fingerprint === deliveredFingerprint) return
    deliveredFingerprint = fingerprint
    for (const listener of listeners) listener(snapshot)
  }

  const observeChanges = async (): Promise<void> => {
    if (closed || listeners.size === 0 || observationInFlight) return
    observationInFlight = true
    try {
      const [management, activation] = await Promise.all([
        loadPluginManagementConfig(options),
        (options.lifecycle?.coordinator.store ?? initialStore).loadActive(),
      ])
      if (
        management.revision === observedManagementRevision
        && activation.revision === observedActivationRevision
      ) return
      emitSnapshot(await query())
    } catch {
      // A concurrent atomic replacement can briefly hide a watched path; the fallback poll retries it.
    } finally {
      observationInFlight = false
    }
  }

  const notify = (): void => {
    if (closed || listeners.size === 0) return
    if (notifyTimer !== undefined) clearTimeout(notifyTimer)
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined
      if (closed || notifyQueued) return
      notifyQueued = true
      void observeChanges().finally(() => {
        notifyQueued = false
      })
    }, 20)
  }

  if (options.watch !== false) {
    const configDirectory = path.dirname(options.configPath)
    try {
      watchers.push(watch(configDirectory, { persistent: false }, notify))
    } catch { /* the directory may not exist until configuration is initialized */ }
    try {
      watchers.push(watch(path.dirname(initialStore.root), { persistent: false }, notify))
    } catch { /* the activation profile may not exist until the first package mutation */ }
    poller = setInterval(() => void observeChanges(), 5_000)
    poller.unref()
  }

  const lifecycleRequest = async (
    request: PluginManagementPlanIntent,
    confirmedImpactToken?: string,
  ): Promise<CordisXPluginLifecycleResultV1> => {
    const lifecycle = await coordinator()
    const active = await lifecycle.store.loadActive()
    const requestId = `management-${randomUUID()}`
    if (request.kind === 'plugin-plan-marketplace') {
      const plugin = await catalog.pluginInfo(request)
      if (plugin === undefined) throw new Error('Marketplace plugin was not found.')
      if (plugin.artifact === undefined) throw new Error('Marketplace plugin has no installable artifact.')
      return await inspectMarketplaceArtifactPackage({
        token: 'plugin-management-service',
        profileId: options.profileId,
        generation: runtimeGeneration,
        coordinator: lifecycle,
      }, {
        pluginId: plugin.identity.pluginId,
        version: plugin.version,
        canonicalSource: plugin.canonicalSource,
        artifact: plugin.artifact,
      }, AbortSignal.timeout(40_000))
    }
    return await lifecycle.handle({
      $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId,
      profileId: options.profileId,
      expectedRevision: active.revision,
      runtimeGeneration,
      operation: lifecycleOperation(request, confirmedImpactToken),
    })
  }

  const enrichPermissionPlan = async (
    request: PluginManagementPlanIntent,
    result: CordisXPluginLifecycleResultV1,
  ): Promise<PluginManagementPermissionPlan | undefined> => {
    const direct = permissionPlan(result)
    if (direct !== undefined || result.candidateId === undefined) return direct
    const lifecycle = await coordinator()
    const active = await lifecycle.store.loadActive()
    const target = request.kind === 'plugin-enable'
      ? { kind: 'enable' as const, pluginId: request.pluginId }
      : { kind: 'candidate' as const, candidateId: result.candidateId }
    const common = {
      requestId: `management-review-${randomUUID()}`,
      profileId: options.profileId,
      runtimeGeneration,
      expectedRevision: active.revision,
      target,
    }
    return await lifecycle.permissionReviewPlanV4(common)
      ?? await lifecycle.permissionReviewPlanV2(common)
  }

  const lifecycleResult = async (
    request: PluginManagementPlanIntent,
    result: CordisXPluginLifecycleResultV1,
  ): Promise<PluginManagementResult> => {
    const snapshot = await query()
    if (result.outcome === 'planned') {
      const plan = await enrichPermissionPlan(request, result)
      if (plan !== undefined && result.candidateId !== undefined) {
        return {
          status: 'permission-review-required',
          request,
          snapshot,
          candidateId: plan.schemaVersion === 1
            ? result.candidateId
            : plan.binding.requestId ?? result.candidateId,
          ...(result.package === undefined ? {} : { package: result.package }),
          permissionPlan: plan,
        }
      }
      return { status: 'planned', request, snapshot, lifecycle: result }
    }
    if (result.outcome === 'applied') {
      return {
        status: 'applied',
        request,
        snapshot,
        pendingActivation: options.lifecycle === undefined && result.scope !== 'config-live',
        lifecycle: result,
      }
    }
    return {
      status: result.outcome === 'conflict' ? 'conflict' : 'rejected',
      request,
      snapshot,
      error: result.error ?? { code: result.outcome, message: `Plugin operation ${result.outcome}.` },
      lifecycle: result,
    }
  }

  const plan = async (request: PluginManagementRequest): Promise<PluginManagementResult> => {
    if (configRequest(request)) {
      const current = await loadPluginManagementConfig(options)
      planPluginManagementConfig(current, request)
      return { status: 'planned', request, snapshot: await query(), executionRequest: request }
    }
    if (request.kind === 'plugin-execute-plan') {
      return {
        status: 'rejected',
        request,
        snapshot: await query(),
        error: { code: 'invalid-operation', message: 'An execution token cannot be planned.' },
      }
    }
    if (request.kind === 'plugin-plan-marketplace') {
      const plugin = await catalog.pluginInfo(request)
      if (plugin === undefined) {
        return {
          status: 'rejected',
          request,
          snapshot: await query(),
          error: { code: 'not-found', message: 'Marketplace plugin was not found.' },
        }
      }
      if (plugin.artifact === undefined) {
        return {
          status: 'rejected',
          request,
          snapshot: await query(),
          error: { code: 'artifact-unavailable', message: 'Marketplace plugin has no installable artifact.' },
        }
      }
      const snapshot = await query()
      const executionToken = `management-execution-${randomUUID()}`
      executionPlans.set(executionToken, { request, activationRevision: snapshot.activationRevision })
      return {
        status: 'planned',
        request,
        snapshot,
        executionRequest: { kind: 'plugin-execute-plan', executionToken },
      }
    }
    if (request.kind === 'plugin-plan-local') {
      if (!path.isAbsolute(request.sourceDirectory)) {
        return {
          status: 'rejected',
          request,
          snapshot: await query(),
          error: { code: 'invalid-source', message: 'Local plugin source must be an absolute path.' },
        }
      }
      const snapshot = await query()
      const executionToken = `management-execution-${randomUUID()}`
      executionPlans.set(executionToken, { request, activationRevision: snapshot.activationRevision })
      return {
        status: 'planned',
        request,
        snapshot,
        executionRequest: { kind: 'plugin-execute-plan', executionToken },
      }
    }
    const snapshot = await query()
    const plugin = snapshot.plugins.find(item => item.id === request.pluginId)
    const available = request.kind === 'plugin-enable' ? plugin?.enabled === false : plugin !== undefined
    if (!available) {
      return {
        status: 'rejected',
        request,
        snapshot,
        error: { code: 'operation-unavailable', message: 'Plugin operation is unavailable.' },
      }
    }
    const executionToken = `management-execution-${randomUUID()}`
    let affectedPluginIds: readonly string[] | undefined
    let confirmedImpactToken: string | undefined
    if (request.kind === 'plugin-disable' || request.kind === 'plugin-uninstall') {
      const active = await (options.lifecycle?.coordinator.store ?? initialStore).loadActive()
      affectedPluginIds = pluginDependentClosure(active.plugins, request.pluginId)
      confirmedImpactToken = impactToken(
        active.profileId,
        active.revision,
        request.kind === 'plugin-disable' ? 'disable' : 'uninstall',
        request.pluginId,
        affectedPluginIds,
      )
    }
    executionPlans.set(executionToken, {
      request,
      activationRevision: snapshot.activationRevision,
      ...(confirmedImpactToken === undefined ? {} : { impactToken: confirmedImpactToken }),
    })
    return {
      status: 'planned',
      request,
      snapshot,
      executionRequest: { kind: 'plugin-execute-plan', executionToken },
      ...(affectedPluginIds === undefined ? {} : { affectedPluginIds }),
    }
  }

  const execute = async (
    request: PluginManagementRequest,
    expectedRevision?: number,
  ): Promise<PluginManagementResult> => {
    if (configRequest(request)) {
      const current = await loadPluginManagementConfig(options)
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        return {
          status: 'conflict',
          request,
          snapshot: await query(),
          error: { code: 'stale-revision', message: 'Plugin management configuration changed.' },
        }
      }
      await updatePluginManagementConfig(options, request)
      catalog.invalidate()
      const snapshot = await query()
      emitSnapshot(snapshot)
      return { status: 'applied', request, snapshot, pendingActivation: false }
    }
    if (request.kind !== 'plugin-execute-plan') {
      return {
        status: 'rejected',
        request,
        snapshot: await query(),
        error: { code: 'confirmation-required', message: 'Plan the plugin operation before executing it.' },
      }
    }
    const planned = executionPlans.get(request.executionToken)
    executionPlans.delete(request.executionToken)
    if (planned === undefined) {
      return {
        status: 'rejected',
        request,
        snapshot: await query(),
        error: { code: 'invalid-execution-token', message: 'Plugin execution token is missing or expired.' },
      }
    }
    const before = await query()
    if (before.activationRevision !== planned.activationRevision) {
      return {
        status: 'conflict',
        request: planned.request,
        snapshot: before,
        error: { code: 'stale-revision', message: 'Plugin activation changed after planning.' },
      }
    }
    if (options.lifecycle === undefined) await initialStore.bindRuntimeGeneration()
    let lifecycle = await lifecycleRequest(planned.request, planned.impactToken)
    if (lifecycle.outcome === 'planned' && lifecycle.candidateId !== undefined) {
      const permission = await enrichPermissionPlan(planned.request, lifecycle)
      if (permission !== undefined) {
        const requiresReview = permission.declarations.some(item => item.decisionRequired)
        if (requiresReview) {
          const snapshot = await query()
          return {
            status: 'permission-review-required',
            request: planned.request,
            snapshot,
            candidateId: lifecycle.candidateId,
            ...(lifecycle.package === undefined ? {} : { package: lifecycle.package }),
            permissionPlan: permission,
          }
        }
        const active = await (await coordinator()).store.loadActive()
        const requestId = `management-apply-${randomUUID()}`
        if (permission.schemaVersion === 4) {
          lifecycle = await (await coordinator()).applyPermissionReviewV4({
            requestId,
            profileId: options.profileId,
            runtimeGeneration,
            expectedRevision: active.revision,
            decision: allowedDecisionV4(permission),
          })
        } else if (permission.schemaVersion === 2) {
          lifecycle = await (await coordinator()).applyPermissionReviewV2({
            requestId,
            profileId: options.profileId,
            runtimeGeneration,
            expectedRevision: active.revision,
            decision: persistedDecisionV2(permission),
          })
        } else {
          const decision = persistedDecisionV1(permission)
          const operation: CordisXPluginLifecycleOperationV1 = lifecycle.operation === 'enable'
            ? { kind: 'enable', pluginId: permission.identity.pluginId, authorizationDecision: decision }
            : {
              kind: lifecycle.operation as 'install' | 'update',
              candidateId: lifecycle.candidateId,
              authorizationDecision: decision,
            }
          lifecycle = await (await coordinator()).handle({
            $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
            schemaVersion: 1,
            requestId,
            profileId: options.profileId,
            expectedRevision: active.revision,
            runtimeGeneration,
            operation,
          })
        }
      }
    }
    const result = await lifecycleResult(planned.request, lifecycle)
    emitSnapshot(result.snapshot)
    return result
  }

  return {
    query,
    refreshCatalog: catalog.refresh,
    queryCatalog: catalog.query,
    pluginInfo: catalog.pluginInfo,
    plan,
    execute,
    async migrateLegacySources(input) {
      const result = await migrateLegacyPluginManagementSources(options, input)
      const snapshot = await query()
      emitSnapshot(snapshot)
      return { migrated: result.migrated, clearLegacyStorage: true, snapshot }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (closed) return
      closed = true
      for (const watcher of watchers) watcher.close()
      watchers.length = 0
      if (notifyTimer !== undefined) clearTimeout(notifyTimer)
      notifyTimer = undefined
      if (poller !== undefined) clearInterval(poller)
      poller = undefined
      listeners.clear()
      executionPlans.clear()
    },
  }
}
