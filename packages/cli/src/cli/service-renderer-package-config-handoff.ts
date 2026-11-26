import type { CordisXConfig, CordisXConfigPlugin } from '../launcher/config.js'
import type { DesktopManagerConfigProof } from '../launcher/renderer-config-management.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { SharedProfilePluginConfigFence } from '../config/profile-plugin-config-fence.js'
import type { ConfigMutationOperation } from '../renderer/configuration/model.js'
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

/** Confirm that this page owns the same configured archive as the Desktop selection. */
function matchesConfiguredBinding(entry: ServiceRendererBootstrapEntry, plugin: CordisXConfigPlugin): boolean {
  try {
    const matches = entry.configuredPlugins?.filter(item => item.pluginId === plugin.id) ?? []
    if (matches.length !== 1 || !matches[0]!.isCurrent()) return false
    const binding = matches[0]!.permissionBinding(matches[0]!.permissionContext())
    return binding.original.source === plugin.source && binding.digest === plugin.configuredArchiveDigest
      && binding.original.digest === plugin.configuredArchiveDigest && binding.lease.pluginId === plugin.id
      && attachmentEqual(binding.artifact, plugin.distributionArtifact)
  } catch {
    return false
  }
}

/** Coordinate admitted Managers and one service-free plugin while its Desktop owner applies configuration. */
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
    readonly canCoordinatePluginConfig: (
      snapshot: ServiceRendererSnapshot,
      plugin: CordisXConfigPlugin,
    ) => Promise<boolean>
    readonly adoptSelectedConfiguredPlugins: (
      previous: readonly CordisXConfigPlugin[],
      next: readonly CordisXConfigPlugin[],
    ) => boolean
    readonly readInputs: (snapshot: ServiceRendererSnapshot) => Promise<Inputs>
    readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
  },
  origin: ManagerOriginFence,
  pluginId: string,
) {
  const pluginFence = input.pluginFence
  if (
    !pluginFence || !origin.desktopConfiguration
    || !isCurrentManagerOriginFence(origin, input.participants, input.lifecycle)
  ) throw new Error('renderer-package-config-unavailable')
  const peers = input.participants.ownerPeers()
  const cohort = peers.map(peer => {
    const id = peer.identity.rendererId
    const entry = input.entries.get(id)
    if (
      !entry || entry.peer !== peer || !entry.bootstrapConfirmed || !entry.snapshot || !entry.config || !entry.plugins
      || !entry.policies || !entry.packageInputs || !entry.desktopPackageConfigPlugins?.includes(pluginId)
      || entry.channelTransition || entry.lifecycleTransition || entry.pendingIdentity || !input.current(id, entry)
    ) throw new Error('renderer-package-config-unavailable')
    return { id, peer, entry }
  })
  const source = cohort.find(item => item.id === origin.rendererId)
  if (!source || cohort.length === 0) throw new Error('renderer-package-config-unavailable')
  const entry = source.entry
  if (!entry.snapshot || !entry.plugins || !entry.config) throw new Error('renderer-package-config-unavailable')
  const installed = entry.plugins.filter(value => value.id === pluginId)
  const configured = entry.config.plugins.filter(value => value.id === pluginId)
  if (installed.length + configured.length !== 1) throw new Error('renderer-package-config-unavailable')
  const isConfigured = configured.length === 1
  const plugin = (isConfigured ? configured[0] : installed[0])!
  const manifest = plugin?.manifest
  if (
    !plugin.enabled || entry.managedOwners?.has(pluginId)
    || isConfigured && (pluginId === 'channel' || plugin.package !== undefined
        || cohort.some(item => !matchesConfiguredBinding(item.entry, plugin)))
    || !isConfigured && (!plugin.package || manifest?.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1
        || manifest.schemaVersion !== 1 || manifest.capabilities.length !== 0)
  ) throw new Error('renderer-package-config-unavailable')
  const snapshot = entry.snapshot
  const transition = {
    isCurrent: () => origin.isCurrent() && cohort.every(item => input.current(item.id, item.entry)),
  }
  for (const item of cohort) item.entry.lifecycleTransition = transition
  const current = () => cohort.every(item => item.entry.lifecycleTransition === transition) && transition.isCurrent()
  const fail = () => {
    for (const item of cohort) {
      if (item.entry.lifecycleTransition === transition) delete item.entry.lifecycleTransition
      item.peer.close()
    }
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const checks = await Promise.race([
        Promise.allSettled(cohort.flatMap(item => [...item.entry.checks])),
        new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), 15_000)),
      ])
      if (!checks || checks.some(result => result.status !== 'fulfilled' || !result.value)) {
        throw new Error('renderer-package-config-unavailable')
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    const drained = await Promise.all(cohort.map(async item => await input.readLifetimes.drainCurrent(item.id)))
    if (drained.some(value => !value) || !current()) {
      throw new Error('renderer-package-config-unavailable')
    }
    const before = await input.readInputs(snapshot)
    if (
      !current() || !attachmentEqual(input.lifecycle.snapshot(), snapshot)
      || cohort.some(item =>
        !attachmentEqual(snapshot, item.entry.snapshot) || !attachmentEqual(before.config, item.entry.config)
        || !attachmentEqual(before.plugins, item.entry.plugins)
        || !attachmentEqual(before.policies, item.entry.policies)
        || !attachmentEqual(before.inputs, item.entry.packageInputs) || item.entry.managedOwners?.has(pluginId)
      )
      || !isConfigured && !await hasNoPackageServiceState(input.homeDir, input.profileId, pluginId)
    ) throw new Error('renderer-package-config-unavailable')
    const otherPlugins = (values: readonly CordisXConfigPlugin[]) => values.filter(value => value.id !== pluginId)
    const otherInputs = (values: Map<string, string>) => new Map([...values].filter(([id]) => id !== pluginId))
    const withoutConfig = (value: CordisXConfigPlugin) => {
      const { config: _config, revision: _revision, ...identity } = value
      return identity
    }
    const withoutConfiguredValue = (value: CordisXConfig) => ({
      ...value,
      plugins: value.plugins.map(item => item.id === pluginId ? withoutConfig(item) : item),
    })
    return {
      snapshot,
      plugin,
      isCurrent: current,
      run: async <T>(action: () => Promise<T>) =>
        isConfigured
          ? await pluginFence.runConfiguredMutation({ pluginId, isCurrent: current }, action)
          : await pluginFence.runPackageMutation({ pluginId, isCurrent: current }, action),
      async adopt(
        expected: unknown,
        proof: DesktopManagerConfigProof | undefined,
        applied: boolean,
        expectedStored: unknown = expected,
      ): Promise<boolean> {
        try {
          const after = await input.readInputs(snapshot)
          const target = (isConfigured ? after.config.plugins : after.plugins).find(value => value.id === pluginId)
          if (
            !current() || !proof || !target || !attachmentEqual(input.lifecycle.snapshot(), snapshot)
            || !attachmentEqual(after.policies, before.policies)
            || (isConfigured
              ? !attachmentEqual(withoutConfiguredValue(after.config), withoutConfiguredValue(before.config))
                || !attachmentEqual(after.plugins, before.plugins) || !attachmentEqual(after.inputs, before.inputs)
              : !attachmentEqual(after.config, before.config)
                || !attachmentEqual(otherPlugins(after.plugins), otherPlugins(before.plugins))
                || !attachmentEqual(otherInputs(after.inputs), otherInputs(before.inputs)))
            || !attachmentEqual(withoutConfig(target), withoutConfig(plugin))
            || target.revision !== (plugin.revision ?? 0) + (applied ? 1 : 0)
            // Package storage uses null-prototype records; compare the JSON
            // value rather than object prototypes after a confirmed commit.
            || !attachmentEqual(JSON.parse(JSON.stringify(target.config)), JSON.parse(JSON.stringify(expectedStored)))
            || !attachmentEqual(projectDesktopManagerConfig(snapshot, target, proof), expected)
            || !isConfigured && !await hasNoPackageServiceState(input.homeDir, input.profileId, pluginId)
            || !current()
          ) return false
          if (applied && !input.rememberPluginConfig(snapshot, target, proof)) return false
          const hasConfig = Object.keys(target.config as Record<string, unknown>).length > 0
          const lifecycle = !isConfigured && hasConfig && await input.canCoordinatePluginConfig(snapshot, target)
          if (!current()) return false
          if (
            isConfigured && applied
            && !input.adoptSelectedConfiguredPlugins(before.config.plugins, after.config.plugins)
          ) {
            return false
          }
          for (const item of cohort) {
            item.entry.plugins = after.plugins
            item.entry.packageInputs = new Map(after.inputs)
            if (isConfigured) {
              item.entry.config = after.config
              continue
            }
            const projections = new Map(item.entry.projectedConfigs)
            if (
              target.config !== null && typeof target.config === 'object' && Object.keys(target.config).length === 0
            ) {
              projections.delete(pluginId)
            } else projections.set(pluginId, expected)
            item.entry.projectedConfigs = projections
            const lifecyclePlugins = new Set(item.entry.desktopLifecycleConfigPlugins)
            if (lifecycle) lifecyclePlugins.add(pluginId)
            else lifecyclePlugins.delete(pluginId)
            item.entry.desktopLifecycleConfigPlugins = [...lifecyclePlugins]
          }
          return true
        } catch {
          return false
        }
      },
      cancel(): boolean {
        if (!current()) return false
        for (const item of cohort) delete item.entry.lifecycleTransition
        return true
      },
      prepareRendererConfirmation(
        requestId: string,
        expectedRevision: number,
        value: unknown,
        operations: readonly ConfigMutationOperation[],
      ): { confirm(): Promise<boolean> } | undefined {
        if (!current()) return undefined
        const revision = expectedRevision + 1
        if (!Number.isSafeInteger(revision)) return undefined
        try {
          const payloads = cohort.map(item => ({
            item,
            payload: {
              rendererId: item.id,
              ownerGeneration: snapshot.active.runtimeGeneration,
              requestId,
              pluginId,
              expectedRevision,
              revision,
              origin: item.id === origin.rendererId,
              operations: structuredClone(operations),
              value: structuredClone(value),
            },
          }))
          // Leave room for the enclosing lifecycle command and browser transport.
          if (payloads.some(item => Buffer.byteLength(JSON.stringify(item.payload)) > 240 * 1024)) return undefined
          let used = false
          const confirm = async (item: typeof payloads[number]) => {
            const receipt = await item.item.peer.request('desktop-package-configuration', item.payload)
            return current() && attachmentEqual(receipt, {
              rendererId: item.item.id,
              ownerGeneration: snapshot.active.runtimeGeneration,
              requestId,
              pluginId,
              revision,
              adopted: true,
            })
          }
          return {
            async confirm(): Promise<boolean> {
              if (used || !current()) return false
              used = true
              try {
                const others = payloads.filter(item => item.item.id !== origin.rendererId)
                if ((await Promise.all(others.map(confirm))).some(result => !result)) return false
                const writer = payloads.find(item => item.item.id === origin.rendererId)
                return writer !== undefined && await confirm(writer)
              } catch {
                return false
              }
            },
          }
        } catch {
          return undefined
        }
      },
      fence: fail,
    }
  } catch (error) {
    fail()
    throw error
  }
}
