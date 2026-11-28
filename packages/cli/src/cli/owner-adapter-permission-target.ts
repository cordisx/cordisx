import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { ownerAdapterManagerPolicyTarget } from './owner-adapter-manager-policy-target.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { OwnerAdapterDocumentContext, OwnerAdapterManagementContext } from './owner-adapter-sessions.js'
import type { ManagerPolicyTarget } from './service-renderer-installed-permission.js'

/** Resolve a native Manager target from the owner's active, integrity-checked package. */
export async function ownerAdapterInstalledPermissionTarget(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly pluginId: string
  readonly context: OwnerAdapterManagementContext
  readonly lifecycle: OwnerRendererLifecycle
  readonly loadPackage?: typeof loadStagedPluginPackage
}): Promise<ManagerPolicyTarget> {
  const invalid = (): never => {
    throw new Error('adapter-permission-target-unavailable')
  }
  if (!input.context.live()) return invalid()
  const snapshot = structuredClone(input.lifecycle.snapshot())
  const matches = snapshot.active.plugins.filter(plugin => plugin.id === input.pluginId)
  const active = matches[0]
  if (
    snapshot.active.recordKind !== 'active' || snapshot.active.profileId !== input.profileId
    || snapshot.active.runtimeGeneration !== input.generation || matches.length !== 1 || !active?.enabled
  ) return invalid()
  const staged = await (input.loadPackage ?? loadStagedPluginPackage)(input.homeDir, active.digest)
  if (
    !input.context.live() || !attachmentEqual(snapshot, input.lifecycle.snapshot())
    || staged.digest !== active.digest || staged.manifest.id !== active.id || staged.manifest.version !== active.version
    || staged.manifest.canonicalSource !== active.canonicalSource
    || !attachmentEqual(staged.manifest.dependencies, active.dependencies) || !staged.browserArtifact
  ) return invalid()
  const identity = Object.freeze({ id: active.id, source: staged.identitySource })
  const artifact = Object.freeze({ version: active.version, integrity: staged.artifactIntegrity ?? active.digest })
  const current = () => {
    try {
      return input.context.live() && attachmentEqual(snapshot, input.lifecycle.snapshot())
    } catch {
      return false
    }
  }
  return ownerAdapterManagerPolicyTarget({
    kind: 'installed' as const,
    profileId: input.profileId,
    identity,
    moduleGeneration: active.moduleGeneration,
    digest: active.digest,
    artifact,
    isCurrent: current,
  })
}

/** A disabled installed package may expose its own history, but cannot receive a policy write. */
export async function ownerAdapterInstalledHistoryIdentity(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly pluginId: string
  readonly context: OwnerAdapterDocumentContext
  readonly lifecycle: OwnerRendererLifecycle
  readonly loadPackage?: typeof loadStagedPluginPackage
}): Promise<{ readonly identity: { readonly id: string; readonly source: string }; isCurrent(): boolean }> {
  const invalid = (): never => {
    throw new Error('adapter-permission-history-unavailable')
  }
  if (!input.context.current(false)) return invalid()
  const snapshot = structuredClone(input.lifecycle.snapshot())
  const matches = snapshot.active.plugins.filter(plugin => plugin.id === input.pluginId)
  const item = matches[0]
  if (
    snapshot.active.recordKind !== 'active' || snapshot.active.profileId !== input.profileId
    || snapshot.active.runtimeGeneration !== input.generation || matches.length !== 1 || !item
  ) return invalid()
  const staged = await (input.loadPackage ?? loadStagedPluginPackage)(input.homeDir, item.digest)
  const current = () => {
    try {
      return input.context.current(false) && attachmentEqual(snapshot, input.lifecycle.snapshot())
    } catch {
      return false
    }
  }
  if (
    !current() || staged.digest !== item.digest || staged.manifest.id !== item.id
    || staged.manifest.version !== item.version || staged.manifest.canonicalSource !== item.canonicalSource
    || !attachmentEqual(staged.manifest.dependencies, item.dependencies)
  ) return invalid()
  return Object.freeze({ identity: Object.freeze({ id: item.id, source: staged.identitySource }), isCurrent: current })
}
