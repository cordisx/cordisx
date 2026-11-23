import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ServiceRendererBootstrapEntry } from './service-renderer-bootstrap-state.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'

/** Owner-private, generation-bound projection; possession is not a permission grant. */
export interface ManagerPolicyTarget {
  readonly kind: 'installed' | 'configured-channel' | 'configured-plugin'
  readonly identity: { readonly id: string; readonly source: string }
  readonly ownerIdentity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly digest: `sha256:${string}`
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
  isCurrent(): boolean
  project(records: readonly CordisXPersistedPermissionPolicyRecord[]): {
    readonly identity: { readonly id: string; readonly source: string }
    readonly moduleGeneration: string
    readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
  }
  resolve(records: readonly CordisXPersistedPermissionPolicyRecord[]): readonly CordisXPersistedPermissionPolicyRecord[]
}

/** Resolve only the immutable package and graph actually admitted to this Manager. */
export function installedManagerPermissionTarget(input: {
  readonly entry: ServiceRendererBootstrapEntry
  readonly context: ManagerRendererChannelContext
  readonly pluginId: string
  readonly lifecycle: OwnerRendererLifecycle
  readonly current: () => boolean
}): ManagerPolicyTarget {
  const invalid = (): never => {
    throw new Error('renderer-installed-permission-unavailable')
  }
  const { entry, context, pluginId } = input
  const identity = entry.identity
  const bound = entry.identityContext
  const alias = entry.identityAliases?.get(pluginId)
  const plugin = entry.plugins?.find(item => item.id === pluginId)
  const packageItem = plugin?.package
  const snapshot = entry.snapshot
  const active = snapshot?.active.plugins.find(item => item.id === pluginId)
  const leases = entry.leases.filter(lease =>
    lease.pluginId === pluginId && lease.moduleGeneration === active?.moduleGeneration
  )
  if (
    !identity || !bound || !alias || !plugin || !packageItem || !snapshot || !active || leases.length !== 1
    || !entry.bootstrapConfirmed || context.admitted !== true || context.signal.aborted
    || bound.signal !== context.signal || bound.rendererId !== context.rendererId
    || bound.profileId !== context.profileId || bound.ownerGeneration !== context.ownerGeneration
    || entry.peer.identity.rendererId !== context.rendererId || !input.current()
    || !attachmentEqual(input.lifecycle.snapshot(), snapshot) || snapshot.active.recordKind !== 'active'
    || snapshot.active.profileId !== context.profileId || snapshot.active.runtimeGeneration !== context.ownerGeneration
    || !plugin.enabled || !active.enabled || plugin.source === undefined
    || active.digest !== packageItem.digest || active.version !== packageItem.version
    || active.moduleGeneration !== packageItem.moduleGeneration
    || active.canonicalSource !== packageItem.canonicalSource
  ) return invalid()
  const original = identity.resolve(context, alias, pluginId)
  if (original.source !== plugin.source || original.digest !== packageItem.digest) return invalid()
  const artifact = Object.freeze({
    version: packageItem.version,
    integrity: packageItem.artifactIntegrity ?? packageItem.digest,
  })
  const rendererIdentity = Object.freeze({ id: pluginId, source: alias })
  const ownerIdentity = Object.freeze({ id: pluginId, source: original.source })
  const lease = leases[0]!
  const current = () => {
    try {
      return entry.bootstrapConfirmed && !context.signal.aborted && input.current()
        && entry.identity === identity && entry.identityContext === bound
        && entry.identityAliases?.get(pluginId) === alias
        && entry.plugins?.find(item => item.id === pluginId) === plugin && entry.snapshot === snapshot
        && entry.leases.includes(lease) && attachmentEqual(input.lifecycle.snapshot(), snapshot)
        && attachmentEqual(identity.resolve(context, alias, pluginId), original)
    } catch {
      return false
    }
  }
  if (!current()) return invalid()
  return Object.freeze({
    kind: 'installed' as const,
    identity: rendererIdentity,
    ownerIdentity,
    moduleGeneration: packageItem.moduleGeneration,
    digest: packageItem.digest,
    artifact,
    isCurrent: current,
    project(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
      if (!current()) return invalid()
      const policies = identity.projectManagerPolicies(context, alias, pluginId, records)
      if (!current()) return invalid()
      return { identity: rendererIdentity, moduleGeneration: packageItem.moduleGeneration, policies }
    },
    resolve(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
      if (!current()) return invalid()
      const resolved = identity.resolveManagerPolicies(context, alias, pluginId, records)
      if (!current()) return invalid()
      return resolved
    },
  })
}
