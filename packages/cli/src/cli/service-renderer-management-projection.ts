import type {
  PluginManagementCatalogDetail,
  PluginManagementCatalogSnapshot,
  PluginManagementCatalogSummary,
  PluginManagementSnapshot,
} from '../management/contracts.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ServiceRendererIdentityProjection } from './service-renderer-identity.js'

type Snapshot = ReturnType<OwnerRendererLifecycle['snapshot']>

/** The bootstrap owns the entry, its locks and disposal; this view cannot create an identity. */
export interface ManagementProjectionEntry {
  readonly confirmed: boolean
  readonly current: () => boolean
  readonly unchanged: () => Promise<boolean>
  readonly identity: ServiceRendererIdentityProjection | undefined
  readonly aliases: ReadonlyMap<string, string> | undefined
  readonly snapshot: Snapshot | undefined
}

/** Refuse a known read-only write before it enters the mutation lifetime. */
export function allowsManagementWrite(entry: ManagementProjectionEntry | undefined, kind: string): boolean {
  return !!entry?.confirmed && entry.current() && (!entry.identity || kind === 'migrate-legacy-sources')
}

/** Project management reads through the same owner-issued identity snapshot. */
export async function projectManagementRequest(input: {
  readonly context: ManagerRendererChannelContext
  readonly kind: string
  readonly dispatch: () => Promise<unknown>
  readonly entry: ManagementProjectionEntry | undefined
  readonly ownerSnapshot: () => Snapshot
}): Promise<unknown> {
  const { context, kind, dispatch, entry } = input
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
  if (!entry.identity) {
    if (!context.admitted && !await entry.unchanged()) throw new Error('renderer-management-projection-unavailable')
    const result = await dispatch()
    if (!context.admitted && !await entry.unchanged()) throw new Error('renderer-management-projection-unavailable')
    return result
  }
  if (!['query', 'query-catalog', 'plugin-info', 'migrate-legacy-sources'].includes(kind)) {
    throw new Error('renderer-management-read-only')
  }
  if (!entry.snapshot || !entry.aliases || !await entry.unchanged()) {
    throw new Error('renderer-management-projection-unavailable')
  }
  const identity = entry.identity
  const aliases = entry.aliases
  const snapshot = entry.snapshot
  const projectSnapshot = (value: PluginManagementSnapshot): PluginManagementSnapshot => {
    if (
      !value || value.profileId !== context.profileId || value.activationRevision !== snapshot.active.revision
      || !Array.isArray(value.plugins) || value.plugins.length !== snapshot.active.plugins.length
      || new Set(value.plugins.map(plugin => plugin.id)).size !== value.plugins.length
    ) throw new Error('renderer-management-projection-unavailable')
    return {
      ...value,
      plugins: value.plugins.map(plugin => {
        const original = snapshot.active.plugins.find(item => item.id === plugin.id)
        const alias = aliases.get(plugin.id)
        if (
          !original || !alias || plugin.version !== original.version || plugin.digest !== original.digest
          || plugin.moduleGeneration !== original.moduleGeneration || plugin.enabled !== original.enabled
          || plugin.canonicalSource !== original.canonicalSource
        ) throw new Error('renderer-management-projection-unavailable')
        identity.resolve(context, alias, plugin.id)
        return {
          ...plugin,
          availableOperations: [],
          ...(original.canonicalSource === undefined ? {} : { canonicalSource: alias }),
        }
      }),
    }
  }
  const projectCatalog = <T extends PluginManagementCatalogSummary>(plugin: T): T => {
    const alias = aliases.get(plugin.identity.pluginId)
    const source = alias === undefined ? undefined : identity.resolve(context, alias, plugin.identity.pluginId).source
    return {
      ...plugin,
      installable: false,
      ...(alias !== undefined && plugin.canonicalSource === source ? { canonicalSource: alias } : {}),
    }
  }
  const result = await dispatch()
  if (!await entry.unchanged()) throw new Error('renderer-management-projection-unavailable')
  if (kind === 'query') return projectSnapshot(result as PluginManagementSnapshot)
  if (kind === 'migrate-legacy-sources') {
    if (!result || typeof result !== 'object' || !('snapshot' in result)) {
      throw new Error('renderer-management-projection-unavailable')
    }
    return { ...result, snapshot: projectSnapshot(result.snapshot as PluginManagementSnapshot) }
  }
  if (kind === 'query-catalog') {
    const catalog = result as PluginManagementCatalogSnapshot
    if (!catalog || !Array.isArray(catalog.plugins)) throw new Error('renderer-management-projection-unavailable')
    return { ...catalog, plugins: catalog.plugins.map(plugin => projectCatalog(plugin)) }
  }
  return result == null ? result : projectCatalog(result as PluginManagementCatalogDetail)
}
