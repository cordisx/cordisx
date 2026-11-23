import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ServiceRendererBootstrapEntry } from './service-renderer-bootstrap-state.js'
import type { ServiceRendererConfiguredPlugin } from './service-renderer-configured-plugin.js'
import type { ManagerPolicyTarget } from './service-renderer-installed-permission.js'

/** Bind a policy target to one owner-verified configured archive and renderer lease. */
export function configuredManagerPermissionTarget(input: {
  readonly entry: ServiceRendererBootstrapEntry
  readonly context: ManagerRendererChannelContext
  readonly plugin: ServiceRendererConfiguredPlugin
  readonly lifecycle: OwnerRendererLifecycle
  readonly current: () => boolean
}): ManagerPolicyTarget {
  const invalid = (): never => {
    throw new Error('renderer-configured-permission-unavailable')
  }
  const { entry, context, plugin } = input
  const snapshot = entry.snapshot
  const selected = entry.config?.plugins.filter(item => item.id === plugin.pluginId) ?? []
  if (
    !snapshot || selected.length !== 1 || !entry.bootstrapConfirmed || context.admitted !== true
    || context.signal.aborted || entry.peer.identity.rendererId !== context.rendererId || !input.current()
    || !entry.configuredPlugins?.includes(plugin) || !entry.leases.includes(plugin.lease)
    || snapshot.active.recordKind !== 'active' || snapshot.active.profileId !== context.profileId
    || snapshot.active.runtimeGeneration !== context.ownerGeneration
    || !attachmentEqual(input.lifecycle.snapshot(), snapshot)
  ) return invalid()
  const captured = structuredClone(selected[0]!)
  const binding = plugin.permissionBinding(context)
  if (
    !captured.enabled || captured.id === 'channel' || captured.source !== binding.original.source
    || captured.configuredArchiveDigest !== binding.digest
    || !attachmentEqual(captured.distributionArtifact, binding.artifact)
  ) return invalid()
  const identity = Object.freeze({ id: plugin.pluginId, source: binding.alias })
  const ownerIdentity = Object.freeze({ id: plugin.pluginId, source: binding.original.source })
  const artifact = Object.freeze({ ...binding.artifact })
  const current = () => {
    try {
      const plugins = entry.config?.plugins.filter(item => item.id === plugin.pluginId) ?? []
      const next = plugin.permissionBinding(context)
      return entry.bootstrapConfirmed && !context.signal.aborted && input.current()
        && entry.snapshot === snapshot && entry.configuredPlugins?.includes(plugin) === true
        && entry.leases.includes(binding.lease) && plugins.length === 1 && attachmentEqual(plugins[0], captured)
        && attachmentEqual(input.lifecycle.snapshot(), snapshot) && next.identity === binding.identity
        && next.alias === binding.alias && next.lease === binding.lease
        && attachmentEqual(next.original, binding.original) && attachmentEqual(next.artifact, artifact)
    } catch {
      return false
    }
  }
  if (!current()) return invalid()
  return Object.freeze({
    kind: 'configured-plugin' as const,
    identity,
    ownerIdentity,
    moduleGeneration: binding.lease.moduleGeneration,
    digest: binding.digest,
    artifact,
    isCurrent: current,
    project(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
      if (!current()) return invalid()
      const policies = binding.identity.projectManagerPolicies(context, binding.alias, plugin.pluginId, records)
      if (!current()) return invalid()
      return { identity, moduleGeneration: binding.lease.moduleGeneration, policies }
    },
    resolve(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
      if (!current()) return invalid()
      const resolved = binding.identity.resolveManagerPolicies(context, binding.alias, plugin.pluginId, records)
      if (!current()) return invalid()
      return resolved
    },
  })
}
