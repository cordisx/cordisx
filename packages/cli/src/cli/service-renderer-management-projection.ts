import type {
  PluginManagementCatalogDetail,
  PluginManagementCatalogSummary,
  PluginManagementPlugin,
  PluginManagementResult,
  PluginManagementSnapshot,
} from '../management/contracts.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { pluginDependentClosure } from '../launcher/plugin-activation.js'
import type { PluginManagementRpcRequest } from '../launcher/management-rpc.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import {
  hasSessionExecutionToken,
  ownerExecutionToken,
  restrictedExecutionToken,
  type RestrictedLifecycleIntent,
  restrictedLifecycleIntent,
  type ServiceRendererManagementPlans,
} from './service-renderer-management-plans.js'

type Snapshot = ReturnType<OwnerRendererLifecycle['snapshot']>

/** The bootstrap owns the entry, its locks and disposal; this view cannot create an identity. */
export interface ManagementProjectionEntry {
  readonly confirmed: boolean
  readonly current: () => boolean
  readonly unchanged: () => Promise<boolean>
  readonly identity: ServiceRendererIdentityProjection | undefined
  readonly aliases: ReadonlyMap<string, string> | undefined
  readonly snapshot: Snapshot | undefined
  readonly scopedLifecycle: boolean
  readonly restricted: {
    readonly writableIds: ReadonlySet<string>
    readonly configuredIds?: ReadonlySet<string>
    readonly plans: ServiceRendererManagementPlans
  } | undefined
}

type Operation = PluginManagementRpcRequest['operation']

function permittedIntent(entry: ManagementProjectionEntry, intent: RestrictedLifecycleIntent): boolean {
  if (!entry.snapshot || !entry.restricted) return false
  const active = entry.snapshot.active.plugins
  const target = active.find(plugin => plugin.id === intent.pluginId)
  if (intent.kind === 'plugin-plan-marketplace' && !target) return true
  if (!entry.restricted.writableIds.has(intent.pluginId)) return false
  if (intent.kind === 'plugin-plan-marketplace' && target?.canonicalSource !== intent.expectedCanonicalSource) {
    return false
  }
  if (
    !target || intent.kind === 'plugin-enable' && target.enabled || intent.kind === 'plugin-disable' && !target.enabled
  ) {
    return false
  }
  if (intent.kind === 'plugin-enable') return true
  try {
    const affected = pluginDependentClosure(active, intent.pluginId)
    return affected.every(id => entry.restricted!.writableIds.has(id))
      && (!['plugin-uninstall', 'plugin-plan-marketplace'].includes(intent.kind)
        || affected.every(id => !entry.restricted!.configuredIds?.has(id)))
  } catch {
    return false
  }
}

function isPluginLifecycleRequest(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { kind?: unknown }).kind === 'string'
    && (value as { kind: string }).kind.startsWith('plugin-')
}

/** Refuse a known read-only write before it enters the mutation lifetime. */
export function allowsManagementWrite(entry: ManagementProjectionEntry | undefined, operation: Operation): boolean {
  if (!entry?.confirmed || !entry.current()) return false
  if (operation.kind === 'migrate-legacy-sources') return true
  const restricted = entry.restricted
  if (operation.kind === 'plan') {
    const intent = restrictedLifecycleIntent(operation.request)
    if (entry.scopedLifecycle && isPluginLifecycleRequest(operation.request)) {
      return !!intent && !!restricted && restricted.plans.available && permittedIntent(entry, intent)
    }
    if (intent && restricted) return restricted.plans.available && permittedIntent(entry, intent)
    return !entry.identity
  }
  if (
    operation.kind === 'execute' && (hasSessionExecutionToken(operation.request)
      || entry.scopedLifecycle && isPluginLifecycleRequest(operation.request))
  ) {
    const token = restrictedExecutionToken(operation.request)
    const plan = token === undefined ? undefined : restricted?.plans.peek(token)
    return !!plan && operation.expectedRevision === plan.managementRevision
      && entry.snapshot?.active.revision === plan.activationRevision && permittedIntent(entry, plan.intent)
  }
  return !entry.identity
}

function projectSnapshot(
  context: ManagerRendererChannelContext,
  entry: ManagementProjectionEntry,
  value: PluginManagementSnapshot,
): PluginManagementSnapshot {
  const { identity, aliases, snapshot } = entry
  if (
    !snapshot || identity && !aliases || !value || value.profileId !== context.profileId
    || value.activationRevision !== snapshot.active.revision || !Array.isArray(value.plugins)
    || value.plugins.length !== snapshot.active.plugins.length
    || new Set(value.plugins.map(plugin => plugin.id)).size !== value.plugins.length
  ) throw new Error('renderer-management-projection-unavailable')
  return {
    ...value,
    ...(entry.restricted === undefined ? {} : { rendererLifecycleAccess: 'session-scoped-v1' as const }),
    plugins: value.plugins.map(plugin => {
      const original = snapshot.active.plugins.find(item => item.id === plugin.id)
      const alias = aliases?.get(plugin.id)
      if (
        !original || identity && !alias || plugin.version !== original.version || plugin.digest !== original.digest
        || plugin.moduleGeneration !== original.moduleGeneration || plugin.enabled !== original.enabled
        || plugin.canonicalSource !== original.canonicalSource
      ) throw new Error('renderer-management-projection-unavailable')
      if (identity) identity.assertInstalledProjection(context, alias!, original)
      return {
        ...plugin,
        availableOperations: plugin.availableOperations.filter(
          (operation: PluginManagementPlugin['availableOperations'][number]) => {
            const kind = operation === 'enable'
              ? 'plugin-enable'
              : operation === 'disable'
              ? 'plugin-disable'
              : operation === 'uninstall'
              ? 'plugin-uninstall'
              : undefined
            return kind !== undefined && permittedIntent(entry, { kind, pluginId: plugin.id })
          },
        ),
        ...(original.canonicalSource === undefined || !identity ? {} : { canonicalSource: alias! }),
      }
    }),
  }
}

function resultError(result: PluginManagementResult): { readonly code: string; readonly message: string } {
  const code = 'error' in result && /^[a-z0-9-]{1,80}$/u.test(result.error.code)
    ? result.error.code
    : 'operation-unavailable'
  const messages: Readonly<Record<string, string>> = {
    'catalog-unavailable': 'The selected Marketplace source is unavailable.',
    'catalog-selection-changed': 'The Marketplace selection changed. Refresh and retry.',
    'artifact-inspection-failed': 'The plugin artifact could not be downloaded or verified.',
  }
  return { code, message: messages[code] ?? 'The plugin operation could not be completed. Review the current state.' }
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(id => right.includes(id))
}

async function projectRestrictedLifecycle(input: {
  readonly context: ManagerRendererChannelContext
  readonly operation: Extract<Operation, { readonly kind: 'plan' | 'execute' }>
  readonly dispatch: (operation?: Operation) => Promise<unknown>
  readonly entry: ManagementProjectionEntry
  readonly currentEntry: () => ManagementProjectionEntry | undefined
}): Promise<PluginManagementResult> {
  const { context, operation, entry } = input
  const plans = entry.restricted?.plans
  if (!plans || !entry.snapshot || !entry.current() || !await entry.unchanged()) {
    throw new Error('renderer-management-projection-unavailable')
  }
  if (operation.kind === 'plan') {
    const intent = restrictedLifecycleIntent(operation.request)
    if (!intent || !plans.available || !permittedIntent(entry, intent)) {
      throw new Error('renderer-management-projection-unavailable')
    }
    const result = await input.dispatch() as PluginManagementResult
    const ownerToken = result?.status === 'planned' ? ownerExecutionToken(result.executionRequest) : undefined
    try {
      const after = input.currentEntry()
      if (
        !after || after.identity !== entry.identity || after.restricted?.plans !== plans || !after.current()
        || !attachmentEqual(after.snapshot, entry.snapshot) || !await after.unchanged()
      ) throw new Error('renderer-management-projection-unavailable')
      const snapshot = projectSnapshot(context, after, result.snapshot)
      if (result.status === 'rejected' || result.status === 'conflict') {
        return { status: result.status, request: intent, snapshot, error: resultError(result) }
      }
      if (result.status !== 'planned' || !ownerToken || !attachmentEqual(result.request, intent)) {
        throw new Error('renderer-management-projection-unavailable')
      }
      const affected = intent.kind === 'plugin-enable' || intent.kind === 'plugin-plan-marketplace'
        ? undefined
        : pluginDependentClosure(entry.snapshot.active.plugins, intent.pluginId)
      if (
        affected !== undefined && (!result.affectedPluginIds || !sameMembers(result.affectedPluginIds, affected))
        || affected === undefined && result.affectedPluginIds !== undefined
      ) throw new Error('renderer-management-projection-unavailable')
      const token = plans.issue(ownerToken, {
        intent,
        managementRevision: snapshot.revision,
        activationRevision: snapshot.activationRevision,
      })
      if (!token) throw new Error('renderer-management-projection-unavailable')
      return {
        status: 'planned',
        request: intent,
        snapshot,
        executionRequest: { kind: 'plugin-execute-plan', executionToken: token },
        ...(affected === undefined ? {} : { affectedPluginIds: affected }),
      }
    } catch (error) {
      if (ownerToken) plans.discardOwner(ownerToken)
      throw error
    }
  }
  const token = restrictedExecutionToken(operation.request)
  const plan = token === undefined ? undefined : plans.take(token)
  try {
    if (
      !token || !plan || operation.expectedRevision !== plan.managementRevision
      || entry.snapshot.active.revision !== plan.activationRevision || !permittedIntent(entry, plan.intent)
    ) throw new Error('renderer-management-projection-unavailable')
    const result = await input.dispatch({
      ...operation,
      request: { kind: 'plugin-execute-plan', executionToken: plan.ownerToken },
    }) as PluginManagementResult
    const after = input.currentEntry()
    if (
      !after || after.identity !== entry.identity || after.restricted?.plans !== plans || !after.current()
      || !await after.unchanged()
    ) {
      throw new Error('renderer-management-projection-unavailable')
    }
    const snapshot = projectSnapshot(context, after, result.snapshot)
    if (result.status === 'applied' && attachmentEqual(result.request, plan.intent)) {
      return { status: 'applied', request: plan.intent, snapshot, pendingActivation: result.pendingActivation }
    }
    if (result.status === 'rejected' || result.status === 'conflict') {
      return { status: result.status, request: plan.intent, snapshot, error: resultError(result) }
    }
    if (result.status === 'permission-review-required' && plan.intent.kind === 'plugin-plan-marketplace') {
      return {
        status: 'rejected',
        request: plan.intent,
        snapshot,
        error: {
          code: 'permission-review-unavailable',
          message: 'This plugin needs a permission review that is not yet available in the independent Manager.',
        },
      }
    }
    throw new Error('renderer-management-projection-unavailable')
  } finally {
    if (plan) plans.discardOwner(plan.ownerToken)
  }
}

/** Project management reads through the same owner-issued identity snapshot. */
export async function projectManagementRequest(input: {
  readonly context: ManagerRendererChannelContext
  readonly operation: Operation
  readonly dispatch: (operation?: Operation) => Promise<unknown>
  readonly entry: () => ManagementProjectionEntry | undefined
  readonly ownerSnapshot: () => Snapshot
}): Promise<unknown> {
  const { context, dispatch, operation } = input
  const kind = operation.kind
  const entry = input.entry()
  if (!entry?.confirmed) {
    // A page may query before bootstrap in an empty profile. Installed
    // package identities require the owner's completed projection first.
    const before = input.ownerSnapshot()
    if (before.active.plugins.length !== 0) throw new Error('renderer-management-projection-unavailable')
    const result = await dispatch()
    if (!attachmentEqual(before, input.ownerSnapshot())) throw new Error('renderer-management-projection-unavailable')
    return result
  }
  if (!entry.current()) throw new Error('renderer-management-projection-unavailable')
  if (
    entry.scopedLifecycle && (operation.kind === 'plan' || operation.kind === 'execute')
    && isPluginLifecycleRequest(operation.request) && !allowsManagementWrite(entry, operation)
  ) throw new Error('renderer-management-projection-unavailable')
  if (
    operation.kind === 'plan' && !!restrictedLifecycleIntent(operation.request) && !!entry.restricted
    || operation.kind === 'execute' && hasSessionExecutionToken(operation.request)
  ) {
    return await projectRestrictedLifecycle({ context, operation, dispatch, entry, currentEntry: input.entry })
  }
  if (!entry.identity) {
    const projected = operation.kind === 'query' && entry.restricted !== undefined
    if ((!context.admitted || projected) && !await entry.unchanged()) {
      throw new Error('renderer-management-projection-unavailable')
    }
    const result = await dispatch()
    if ((!context.admitted || projected) && !await entry.unchanged()) {
      throw new Error('renderer-management-projection-unavailable')
    }
    return projected ? projectSnapshot(context, entry, result as PluginManagementSnapshot) : result
  }
  if (!['query', 'query-catalog', 'plugin-info', 'migrate-legacy-sources'].includes(kind)) {
    throw new Error('renderer-management-read-only')
  }
  if (!entry.snapshot || !entry.aliases || !await entry.unchanged()) {
    throw new Error('renderer-management-projection-unavailable')
  }
  const identity = entry.identity
  const aliases = entry.aliases
  const projectCatalog = <T extends PluginManagementCatalogSummary>(plugin: T): T => {
    const alias = aliases.get(plugin.identity.pluginId)
    const matches = alias !== undefined
      && identity.matchesSource(context, alias, plugin.identity.pluginId, plugin.canonicalSource)
    return {
      ...plugin,
      installable: false,
      ...(matches ? { canonicalSource: alias } : {}),
    }
  }
  const result = await dispatch()
  if (!await entry.unchanged()) throw new Error('renderer-management-projection-unavailable')
  if (kind === 'query') return projectSnapshot(context, entry, result as PluginManagementSnapshot)
  if (kind === 'migrate-legacy-sources') {
    if (!result || typeof result !== 'object' || !('snapshot' in result)) {
      throw new Error('renderer-management-projection-unavailable')
    }
    return { ...result, snapshot: projectSnapshot(context, entry, result.snapshot as PluginManagementSnapshot) }
  }
  if (kind === 'query-catalog') {
    const catalog = result as readonly PluginManagementCatalogSummary[]
    if (!Array.isArray(catalog)) throw new Error('renderer-management-projection-unavailable')
    return catalog.map(plugin => projectCatalog(plugin))
  }
  return result == null ? result : projectCatalog(result as PluginManagementCatalogDetail)
}
