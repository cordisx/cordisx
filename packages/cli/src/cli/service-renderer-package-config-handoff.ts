import type { CordisXConfig, CordisXConfigPlugin } from '../launcher/config.js'
import type { DesktopManagerConfigProof } from '../launcher/renderer-config-management.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { SharedProfilePluginConfigFence } from '../config/profile-plugin-config-fence.js'
import { projectDesktopManagerConfig } from './desktop-manager-config-projection.js'
import { isCurrentManagerOriginFence, type ManagerOriginFence } from './manager-origin-fence.js'
import type { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererBootstrapEntry, ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'
import { hasNoPackageServiceState } from './service-renderer-profile-inputs.js'

type Inputs = {
  readonly config: CordisXConfig
  readonly plugins: readonly CordisXConfigPlugin[]
  readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly inputs: Map<string, string>
}

/** Coordinate one Manager and one service-free package while its Desktop owner applies configuration. */
export async function reserveServiceRendererPackageConfig(
  input: {
    readonly homeDir: string
    readonly profileId: string
    readonly entries: Map<string, ServiceRendererBootstrapEntry>
    readonly participants: ServiceRendererParticipants
    readonly lifecycle: OwnerRendererLifecycle
    readonly readLifetimes: ManagerRendererReadLifetimes
    readonly pluginFence?: SharedProfilePluginConfigFence
    readonly rememberPluginConfig: (
      snapshot: ServiceRendererSnapshot,
      plugin: CordisXConfigPlugin,
      proof: DesktopManagerConfigProof,
    ) => boolean
    readonly readInputs: (snapshot: ServiceRendererSnapshot) => Promise<Inputs>
    readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
  },
  origin: ManagerOriginFence,
  pluginId: string,
) {
  const pluginFence = input.pluginFence
  const peer = input.participants.peer(origin.rendererId)
  const entry = input.entries.get(origin.rendererId)
  if (
    !pluginFence || !origin.desktopConfiguration || !peer || !entry
    || entry.peer !== peer || !entry.bootstrapConfirmed || !entry.snapshot || !entry.config || !entry.plugins
    || !entry.policies || !entry.packageInputs || !entry.desktopPackageConfigPlugins?.includes(pluginId)
    || entry.channelTransition || entry.lifecycleTransition
    || !isCurrentManagerOriginFence(origin, input.participants, input.lifecycle)
  ) throw new Error('renderer-package-config-unavailable')
  const peers = input.participants.ownerPeers()
  const plugin = entry.plugins.find(value => value.id === pluginId)
  const manifest = plugin?.manifest
  if (
    peers.length !== 1 || peers[0] !== peer || !plugin?.enabled || !plugin.package
    || manifest?.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 || manifest.schemaVersion !== 1
    || manifest.capabilities.length !== 0 || entry.managedOwners?.has(pluginId)
  ) throw new Error('renderer-package-config-unavailable')
  const snapshot = entry.snapshot
  const transition = { isCurrent: () => origin.isCurrent() && input.current(origin.rendererId, entry) }
  entry.lifecycleTransition = transition
  const current = () => entry.lifecycleTransition === transition && transition.isCurrent()
  const fail = () => {
    if (entry.lifecycleTransition === transition) delete entry.lifecycleTransition
    entry.peer.close()
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const checks = await Promise.race([
        Promise.allSettled([...entry.checks]),
        new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), 15_000)),
      ])
      if (!checks || checks.some(result => result.status !== 'fulfilled' || !result.value)) {
        throw new Error('renderer-package-config-unavailable')
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!await input.readLifetimes.drainCurrent(origin.rendererId) || !current()) {
      throw new Error('renderer-package-config-unavailable')
    }
    const before = await input.readInputs(snapshot)
    if (
      !current() || !attachmentEqual(input.lifecycle.snapshot(), snapshot)
      || !attachmentEqual(before.config, entry.config) || !attachmentEqual(before.plugins, entry.plugins)
      || !attachmentEqual(before.policies, entry.policies) || !attachmentEqual(before.inputs, entry.packageInputs)
      || !await hasNoPackageServiceState(input.homeDir, input.profileId, pluginId)
    ) throw new Error('renderer-package-config-unavailable')
    const otherPlugins = (values: readonly CordisXConfigPlugin[]) => values.filter(value => value.id !== pluginId)
    const otherInputs = (values: Map<string, string>) => new Map([...values].filter(([id]) => id !== pluginId))
    const withoutConfig = (value: CordisXConfigPlugin) => {
      const { config: _config, revision: _revision, ...identity } = value
      return identity
    }
    return {
      snapshot,
      plugin,
      isCurrent: current,
      run: async <T>(action: () => Promise<T>) =>
        await pluginFence.runPackageMutation({ pluginId, isCurrent: current }, action),
      async adopt(expected: unknown, proof: DesktopManagerConfigProof | undefined, applied: boolean): Promise<boolean> {
        try {
          const after = await input.readInputs(snapshot)
          const target = after.plugins.find(value => value.id === pluginId)
          if (
            !current() || !proof || !target || !attachmentEqual(input.lifecycle.snapshot(), snapshot)
            || !attachmentEqual(after.config, before.config) || !attachmentEqual(after.policies, before.policies)
            || !attachmentEqual(otherPlugins(after.plugins), otherPlugins(before.plugins))
            || !attachmentEqual(otherInputs(after.inputs), otherInputs(before.inputs))
            || !attachmentEqual(withoutConfig(target), withoutConfig(plugin))
            || target.revision !== (plugin.revision ?? 0) + (applied ? 1 : 0)
            // Package storage uses null-prototype records; compare the JSON
            // value rather than object prototypes after a confirmed commit.
            || !attachmentEqual(JSON.parse(JSON.stringify(target.config)), JSON.parse(JSON.stringify(expected)))
            || !attachmentEqual(projectDesktopManagerConfig(snapshot, target, proof), expected)
            || !await hasNoPackageServiceState(input.homeDir, input.profileId, pluginId)
            || !current()
          ) return false
          if (applied && !input.rememberPluginConfig(snapshot, target, proof)) return false
          entry.plugins = after.plugins
          entry.packageInputs = after.inputs
          const projections = new Map(entry.projectedConfigs)
          if (target.config !== null && typeof target.config === 'object' && Object.keys(target.config).length === 0) {
            projections.delete(pluginId)
          } else projections.set(pluginId, expected)
          entry.projectedConfigs = projections
          return true
        } catch {
          return false
        }
      },
      cancel(): boolean {
        if (!current()) return false
        delete entry.lifecycleTransition
        return true
      },
      async confirmRenderer(requestId: string, expectedRevision: number, value: unknown): Promise<boolean> {
        if (!current()) return false
        const revision = expectedRevision + 1
        const receipt = await peer.request('desktop-package-configuration', {
          rendererId: origin.rendererId,
          ownerGeneration: snapshot.active.runtimeGeneration,
          requestId,
          pluginId,
          expectedRevision,
          revision,
          value,
        })
        return current() && attachmentEqual(receipt, {
          rendererId: origin.rendererId,
          ownerGeneration: snapshot.active.runtimeGeneration,
          requestId,
          pluginId,
          revision,
          adopted: true,
        })
      },
      fence: fail,
    }
  } catch (error) {
    fail()
    throw error
  }
}
