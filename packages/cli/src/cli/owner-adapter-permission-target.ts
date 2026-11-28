import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { domPermissionAuthorizationKeyV3 } from '../permission-model-v3.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV3,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
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
  const selected = (record: CordisXPersistedPermissionPolicyRecord) =>
    isPermissionPolicyRecordV3(record) && record.key.profileId === input.profileId
    && record.key.identity.pluginId === identity.id && record.key.identity.source === identity.source
    && record.key.capability === 'ui.extension-points.render' && record.key.scope.extensionPoints?.length === 1
    && ['manager.settings.navigation-items', 'manager.content'].includes(record.key.scope.extensionPoints[0]!)
  const project = (records: readonly CordisXPersistedPermissionPolicyRecord[]) => {
    if (!current() || records.length > 4096) return invalid()
    const policies = records.map(record => normalizePersistedPermissionPolicyRecord(record)).filter(selected)
    if (new Set(policies.map(persistedPermissionRecordKey)).size !== policies.length || !current()) return invalid()
    return { identity, moduleGeneration: active.moduleGeneration, policies }
  }
  return Object.freeze({
    kind: 'installed' as const,
    identity,
    ownerIdentity: identity,
    moduleGeneration: active.moduleGeneration,
    digest: active.digest,
    artifact,
    isCurrent: current,
    project,
    resolve(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
      if (!current() || records.length < 1 || records.length > 2) return invalid()
      const values = records.map(record => normalizePersistedPermissionPolicyRecord(record))
      for (const record of values) {
        if (!selected(record) || !isPermissionPolicyRecordV3(record)) return invalid()
        const pointId = record.key.scope.extensionPoints![0]!
        const expected = domPermissionAuthorizationKeyV3({
          profileId: input.profileId,
          identity: record.key.identity,
          pointId,
          catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
        })
        if (record.key.securityFingerprint !== expected.securityFingerprint) return invalid()
      }
      if (new Set(values.map(persistedPermissionRecordKey)).size !== values.length || !current()) return invalid()
      return values
    },
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
