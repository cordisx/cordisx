import path from 'node:path'
import { type HomeConfigProfile, loadHomeConfig } from '../config/home-config.js'
import { SharedProfilePermissionFence } from '../config/profile-permission-fence.js'
import { SharedProfilePluginConfigFence } from '../config/profile-plugin-config-fence.js'
import { buildRendererBundle } from '../launcher/bundle.js'
import { type CordisXConfig, type CordisXConfigPlugin, loadConfig } from '../launcher/config.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V15,
} from '../launcher/latest-runtime-manifest.js'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { createStandaloneRuntimeGraph } from '../launcher/standalone-runtime-graph.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import { type ManagerRendererGraph, parseManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import { encodeManagerRendererBundle, MANAGER_BUNDLE_RPC_LIMIT } from './manager-renderer-bundle-codec.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { ManagerRendererWriteLifetimes } from './manager-renderer-write-lifetimes.js'
import { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import { ServiceRendererConfiguredChannel } from './service-renderer-configured-channel.js'
import { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import {
  allowsManagementWrite,
  type ManagementProjectionEntry,
  projectManagementRequest,
} from './service-renderer-management-projection.js'
import type { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { HostServiceConfigMutationResult } from '../launcher/service-config.js'
import { isCurrentManagerOriginFence, type ManagerOriginFence } from './manager-origin-fence.js'
import { loadServiceRendererInitialPackage, serviceRendererPrivateGraph } from './service-renderer-projection.js'
import { readSettledProfileInputs } from './service-renderer-profile-inputs.js'

type Snapshot = ReturnType<OwnerRendererLifecycle['snapshot']>
type ConfiguredChannel = {
  readonly plugin: CordisXConfigPlugin
  readonly service: LocalChannelService
  readonly bridge: ReadonlyChannelRendererBridge
}
type Entry = {
  readonly peer: ManagerRendererCommandPeer
  readonly leases: PluginGenerationGraphLease[]
  readonly checks: Set<Promise<boolean>>
  readonly unsubscribe: () => void
  stale: boolean
  bootstrapConfirmed: boolean
  snapshot?: Snapshot
  config?: CordisXConfig
  plugins?: readonly CordisXConfigPlugin[]
  packageInputs?: Map<string, string>
  policies?: readonly CordisXPersistedPermissionPolicyRecord[]
  managedOwners?: ReadonlyMap<string, string>
  managedContext?: ManagerRendererChannelContext
  identity?: ServiceRendererIdentityProjection
  identityAliases?: ReadonlyMap<string, string>
  needsIdentityProjection?: boolean
  releasePermissionFence?: () => Promise<void>
  releasePluginConfigFence?: () => Promise<void>
  retirement?: Promise<boolean>
  cleanupFailed?: boolean
  configuredChannel?: ServiceRendererConfiguredChannel
  channelTransition?: { readonly isCurrent: () => boolean }
  preparing?: Promise<unknown>
  completing?: Promise<unknown>
}
const MAX_INITIAL_GRAPHS = 256
function emptyConfig(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/**
 * Owner-only, two-phase bootstrap. Phase one creates and retains immutable
 * leases; phase two accepts only the authenticated sidecar's same-origin
 * mappings and builds from the same owner snapshot. No credentials or source
 * addresses are ever intended for the browser.
 */
export class ServiceRendererBootstrap {
  readonly writeLifetimes = new ManagerRendererWriteLifetimes()
  readonly readLifetimes = new ManagerRendererReadLifetimes()
  private readonly entries = new Map<string, Entry>()
  private readonly retirements = new Map<string, Promise<boolean>>()
  private readonly unsubscribeFinalization: () => void
  private readonly permissionFence: SharedProfilePermissionFence | undefined
  private readonly pluginConfigFence: SharedProfilePluginConfigFence | undefined
  private readonly ownerStartupConfig: NonNullable<HomeConfigProfile['managedServiceStartupConfig']>
  private managedServiceUI: ReturnType<typeof createManagerManagedServiceUIBridge> | undefined
  private configuredChannel: ConfiguredChannel | undefined
  private closed = false
  private closing: Promise<boolean> | undefined

  constructor(
    private readonly input: {
      readonly homeDir: string
      readonly configPath: string
      readonly appId: string
      readonly profileId: string
      readonly generation: string
      /** Exact Host-only startup input selected by this owner before launching managed services. */
      readonly ownerStartupConfig?: HomeConfigProfile['managedServiceStartupConfig']
      readonly lifecycle: OwnerRendererLifecycle
      readonly participants: ServiceRendererParticipants
      readonly store: PluginActivationStore
      readonly managedServiceUI?: ReturnType<typeof createManagerManagedServiceUIBridge>
      /** Fence cooperative Home policy and configured-plugin writers while snapshots are active. */
      readonly protectProfileInputs?: boolean
      /** Owner-selected experimental, read-only configured Channel composition. */
      readonly experimentalConfiguredChannel?: ConfiguredChannel
      /** The production owner also supplied the coordinated Channel configuration bridge. */
      readonly experimentalChannelServiceConfig?: boolean
      /** The owner also supplied the private, coordinated credential bridge. */
      readonly experimentalChannelCredentials?: boolean
    },
  ) {
    this.ownerStartupConfig = structuredClone(input.ownerStartupConfig ?? {})
    this.configuredChannel = input.experimentalConfiguredChannel
    this.managedServiceUI = input.managedServiceUI
    this.permissionFence = input.protectProfileInputs
      ? new SharedProfilePermissionFence(input.configPath, input.profileId)
      : undefined
    this.pluginConfigFence = input.protectProfileInputs
      ? new SharedProfilePluginConfigFence(input.configPath, input.profileId)
      : undefined
    this.unsubscribeFinalization = input.lifecycle.onActivationFinalized(active => {
      for (const entry of this.entries.values()) {
        for (let index = entry.leases.length - 1; index >= 0; index--) {
          const lease = entry.leases[index]!
          if (lease === entry.configuredChannel?.lease) continue
          const plugin = active.plugins.find(item => item.id === lease.pluginId)
          if (plugin?.enabled !== true || plugin.moduleGeneration !== lease.moduleGeneration) {
            lease.retire()
            entry.leases.splice(index, 1)
          }
        }
      }
    })
  }

  /** Bind only before an owner publishes Manager admission; never from a browser. */
  bindConfiguredChannel(channel: ConfiguredChannel): boolean {
    if (this.closed || !this.input.protectProfileInputs || this.configuredChannel || this.entries.size !== 0) {
      return false
    }
    this.configuredChannel = channel
    return true
  }

  /** Bind the Desktop service authority before admission; its own fence gates readiness. */
  bindManagedServiceUI(bridge: ReturnType<typeof createManagerManagedServiceUIBridge>): boolean {
    if (this.closed || !this.input.protectProfileInputs || this.managedServiceUI || this.entries.size !== 0) {
      return false
    }
    this.managedServiceUI = bridge
    return true
  }

  private current(rendererId: string, entry: Entry): boolean {
    return !this.closed && !entry.stale && this.entries.get(rendererId) === entry && !entry.peer.closed
      && this.input.participants.peer(rendererId) === entry.peer
  }

  private async policies(): Promise<readonly CordisXPersistedPermissionPolicyRecord[]> {
    return (await loadHomeConfig(this.input.configPath)).permissions.filter(
      policy => policy.key.profileId === this.input.profileId,
    )
  }

  private async profileInputs(snapshot: Snapshot): Promise<Map<string, string>> {
    return await readSettledProfileInputs({
      homeDir: this.input.homeDir,
      configPath: this.input.configPath,
      appId: this.input.appId,
      profileId: this.input.profileId,
      generation: this.input.generation,
      ownerStartupConfig: this.ownerStartupConfig,
      pluginIds: snapshot.active.plugins.map(plugin => plugin.id),
    })
  }

  private async trackCheck(entry: Entry, operation: () => Promise<boolean>): Promise<boolean> {
    const check = operation()
    entry.checks.add(check)
    try {
      return await check
    } finally {
      entry.checks.delete(check)
    }
  }

  /** Detect stale startup configuration without comparing the live package epoch. */
  private async configurationCurrent(rendererId: string, entry: Entry): Promise<boolean> {
    return await this.trackCheck(entry, async () => {
      try {
        if (
          !this.current(rendererId, entry) || !entry.config || !entry.policies || !entry.packageInputs
          || entry.configuredChannel && !entry.configuredChannel.isCurrent()
        ) return false
        const snapshot = this.input.lifecycle.snapshot()
        const [configRead, policiesRead, inputsRead] = await Promise.allSettled([
          loadConfig(this.input.configPath, { profileId: this.input.profileId, projectRoot: this.input.homeDir }),
          this.policies(),
          this.profileInputs(snapshot),
        ])
        if (
          configRead.status !== 'fulfilled' || policiesRead.status !== 'fulfilled' || inputsRead.status !== 'fulfilled'
        ) return false
        const config = configRead.value
        const policies = policiesRead.value
        if (
          !this.current(rendererId, entry) || !attachmentEqual(this.input.lifecycle.snapshot(), snapshot)
          || !attachmentEqual(config, entry.config) || !attachmentEqual(policies, entry.policies)
        ) return false
        for (const [id, digest] of inputsRead.value) {
          if (entry.packageInputs.has(id) && entry.packageInputs.get(id) !== digest) return false
        }
        for (const [id, digest] of inputsRead.value) entry.packageInputs.set(id, digest)
        return true
      } catch {
        return false
      }
    })
  }

  private async unchanged(rendererId: string, entry: Entry): Promise<boolean> {
    return await this.trackCheck(entry, async () => {
      try {
        if (
          !this.current(rendererId, entry) || !entry.snapshot || !entry.config || !entry.plugins || !entry.policies
          || !entry.packageInputs
          || entry.configuredChannel && !entry.configuredChannel.isCurrent()
        ) {
          return false
        }
        if (entry.managedContext) this.managedServiceUI?.projectInitial(entry.managedContext)
        if (!attachmentEqual(this.input.lifecycle.snapshot(), entry.snapshot)) return false
        const [configRead, pluginsRead, policiesRead, inputsRead] = await Promise.allSettled([
          loadConfig(this.input.configPath, { profileId: this.input.profileId, projectRoot: this.input.homeDir }),
          loadPluginComposition(this.input.store, entry.snapshot.active),
          this.policies(),
          this.profileInputs(entry.snapshot),
        ])
        if (
          configRead.status !== 'fulfilled' || pluginsRead.status !== 'fulfilled' || policiesRead.status !== 'fulfilled'
          || inputsRead.status !== 'fulfilled'
        ) return false
        const config = configRead.value
        const plugins = pluginsRead.value
        const policies = policiesRead.value
        if (entry.managedContext) this.managedServiceUI?.projectInitial(entry.managedContext)
        return this.current(rendererId, entry) && attachmentEqual(this.input.lifecycle.snapshot(), entry.snapshot)
          && attachmentEqual(config, entry.config) && attachmentEqual(plugins, entry.plugins)
          && attachmentEqual(policies, entry.policies) && attachmentEqual(inputsRead.value, entry.packageInputs)
      } catch {
        return false
      }
    })
  }

  /**
   * Bootstrap must use its exact package snapshot. Once that snapshot is
   * confirmed, package transactions are synchronized by the lifecycle; the
   * configured Channel is reserved separately and remains bound to the
   * owner-selected config, policies, graph and service generation.
   */
  private async channelAuthorityCurrent(rendererId: string, entry: Entry): Promise<boolean> {
    return entry.bootstrapConfirmed
      ? await this.configurationCurrent(rendererId, entry)
      : await this.unchanged(rendererId, entry)
  }

  private retire(rendererId: string, entry: Entry): void {
    // A session can disconnect while an asynchronous lease is being created.
    // Drain this entry even if it has already been removed from the map.
    if (this.entries.get(rendererId) === entry) this.entries.delete(rendererId)
    entry.unsubscribe()
    const writes = this.writeLifetimes.retire(rendererId)
    const reads = this.readLifetimes.retire(rendererId)
    // A failed bootstrap is no longer a usable participant. Closing the peer
    // also fences new admissions until all in-flight calls and resources drain.
    entry.peer.close()
    if (!entry.retirement) {
      entry.retirement = (async () => {
        // A disconnected renderer may still be finishing bootstrap and may
        // acquire a late lease. Do not confirm retirement until that work and
        // both profile locks have actually completed.
        await Promise.allSettled(
          [entry.preparing, entry.completing, ...entry.checks].filter(value => value !== undefined),
        )
        const writesSettled = await writes
        await reads
        const managedSettled = entry.managedContext
          ? await (this.managedServiceUI?.waitForRetirement(rendererId) ?? Promise.resolve(false))
          : true
        const releases = [entry.releasePermissionFence, entry.releasePluginConfigFence]
        delete entry.releasePermissionFence
        delete entry.releasePluginConfigFence
        const results = await Promise.allSettled(releases.map(async release => await release?.()))
        return writesSettled && managedSettled && !entry.cleanupFailed
          && results.every(result => result.status === 'fulfilled')
      })().catch(() => false)
      this.retirements.set(rendererId, entry.retirement)
    }
    try {
      if (entry.managedContext) this.managedServiceUI?.retire(entry.managedContext)
    } catch {
      entry.cleanupFailed = true
    }
    try {
      entry.configuredChannel?.close()
    } catch {
      entry.cleanupFailed = true
    }
    entry.identity?.close()
    for (const lease of entry.leases) {
      try {
        lease.retire()
      } catch {
        entry.cleanupFailed = true
      }
    }
    entry.leases.length = 0
  }

  /** Owner RPC calls this after closing the exact peer, before acknowledging revocation. */
  async waitForRetirement(rendererId: string): Promise<boolean> {
    return await (this.retirements.get(rendererId) ?? Promise.resolve(true))
  }

  /** Resolve only an admitted renderer's exact, still-current configured Channel identity. */
  async configuredChannelServiceIdentity(context: ManagerRendererChannelContext, alias?: string): Promise<{
    readonly alias: string
    readonly source: string
  }> {
    const entry = this.entries.get(context.rendererId)
    if (
      !entry?.configuredChannel || !entry.bootstrapConfirmed || entry.channelTransition
      || !this.current(context.rendererId, entry) || !await this.channelAuthorityCurrent(context.rendererId, entry)
    ) throw new Error('renderer-configured-channel-unavailable')
    return entry.configuredChannel.serviceIdentity(context, alias)
  }

  /** Read back the new redacted view only for the admitted originating Manager. */
  async configuredChannelProjection(context: ManagerRendererChannelContext) {
    await this.configuredChannelServiceIdentity(context)
    const entry = this.entries.get(context.rendererId)
    if (!entry?.configuredChannel || !this.current(context.rendererId, entry)) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    return entry.configuredChannel.projection(context)
  }

  /** Owner-only Channel write handoff; callers must already reserve the originating Manager and lifecycle. */
  async mutateConfiguredChannel(
    origin: ManagerOriginFence,
    action: () => Promise<HostServiceConfigMutationResult>,
  ): Promise<HostServiceConfigMutationResult> {
    const rendererId = origin.rendererId
    const channel = this.configuredChannel
    const pluginFence = this.pluginConfigFence
    const ownerLive = () => {
      try {
        return isCurrentManagerOriginFence(origin, this.input.participants, this.input.lifecycle)
      } catch {
        return false
      }
    }
    if (!channel || !pluginFence || !ownerLive()) throw new Error('renderer-configured-channel-unavailable')
    const cohort = this.input.participants.ownerPeers().map(peer => {
      const id = peer.identity.rendererId
      const entry = this.entries.get(id)
      const configured = entry?.configuredChannel
      if (
        !entry || entry.peer !== peer || !configured || entry.channelTransition
        || !this.current(id, entry) || !configured.isCurrent()
      ) throw new Error('renderer-configured-channel-unavailable')
      return { id, entry, configured, peer }
    })
    if (!cohort.some(item => item.id === rendererId) || !ownerLive()) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    for (const { entry } of cohort) entry.channelTransition = { isCurrent: ownerLive }
    let reservation: Awaited<ReturnType<ReadonlyChannelRendererBridge['suspendAll']>> | undefined
    try {
      await Promise.allSettled(cohort.flatMap(({ entry }) => [...entry.checks]))
      if (
        !ownerLive() || cohort.some(({ id, entry, configured }) => !this.current(id, entry) || !configured.isCurrent())
      ) {
        throw new Error('renderer-configured-channel-unavailable')
      }
      reservation = await channel.bridge.suspendAll(cohort.map(item => item.id))
      const drained = await Promise.all(cohort.map(async item => await this.readLifetimes.drainCurrent(item.id)))
      if (drained.some(value => !value) || !reservation.isCurrent() || !ownerLive()) {
        throw new Error('renderer-configured-channel-unavailable')
      }
      const result = await pluginFence.runServiceMutation({
        pluginId: 'channel',
        serviceId: 'runtime',
        isCurrent: () =>
          ownerLive() && reservation!.isCurrent()
          && cohort.every(({ id, entry }) => this.current(id, entry)),
      }, async () => {
        const value = await action()
        if (value.status === 'applied') {
          for (const { id, configured } of cohort) {
            await configured.handoff(reservation!.forRenderer(id), {
              generation: value.serviceGeneration,
              revision: value.revision,
            })
          }
        } else if (value.status === 'conflict' || value.status === 'rejected') {
          for (const { id, configured } of cohort) await configured.handoff(reservation!.forRenderer(id))
        } else {
          throw new Error('renderer-configured-channel-result-uncertain')
        }
        return value
      })
      if (!ownerLive() || !reservation.release()) {
        throw new Error('renderer-configured-channel-result-uncertain')
      }
      for (const { entry } of cohort) delete entry.channelTransition
      if (result.status === 'applied') {
        // The writer adopts its own receipt; other pages confirm the new view
        // before the write fence is released, without unmounting their drafts.
        await Promise.all(
          cohort.filter(item => item.id !== rendererId).map(async item => {
            const receipt = await item.peer.request('channel-configuration', {
              rendererId: item.id,
              ownerGeneration: this.input.generation,
              revision: result.revision,
              projection: item.configured.handoffProjection(),
            })
            if (
              !attachmentEqual(receipt, {
                rendererId: item.id,
                ownerGeneration: this.input.generation,
                revision: result.revision,
                adopted: true,
              })
            ) throw new Error('renderer-configured-channel-result-uncertain')
          }),
        )
      }
      if (!ownerLive()) throw new Error('renderer-configured-channel-result-uncertain')
      return result
    } catch (error) {
      reservation?.fence()
      for (const { entry } of cohort) {
        delete entry.channelTransition
        entry.peer.close()
      }
      throw error
    }
  }

  async prepare(rendererId: string): Promise<unknown> {
    if (this.closed || this.retirements.has(rendererId)) throw new Error('renderer-bootstrap-unavailable')
    const existing = this.entries.get(rendererId)
    if (existing?.channelTransition) throw new Error('renderer-bootstrap-unavailable')
    if (existing?.preparing) {
      const result = await existing.preparing
      if (!await this.unchanged(rendererId, existing)) throw new Error('renderer-bootstrap-stale')
      return result
    }
    if (existing) throw new Error('renderer-bootstrap-unavailable')
    const peer = this.input.participants.peer(rendererId)
    if (!peer) throw new Error('renderer-bootstrap-unavailable')
    const leases: PluginGenerationGraphLease[] = []
    let entry!: Entry
    const unsubscribe = peer.onDisconnect(() => {
      if (entry !== undefined) this.retire(rendererId, entry)
    })
    entry = { peer, leases, checks: new Set(), unsubscribe, stale: false, bootstrapConfirmed: false }
    this.entries.set(rendererId, entry)
    if (peer.closed) {
      this.retire(rendererId, entry)
      throw new Error('renderer-bootstrap-unavailable')
    }
    entry.preparing = (async () => {
      try {
        if (this.permissionFence) {
          const release = await this.permissionFence.acquire()
          if (!this.current(rendererId, entry)) {
            await release()
            throw new Error('renderer-bootstrap-stale')
          }
          entry.releasePermissionFence = release
        }
        if (this.pluginConfigFence) {
          const release = await this.pluginConfigFence.acquire()
          if (!this.current(rendererId, entry)) {
            await release()
            throw new Error('renderer-bootstrap-stale')
          }
          entry.releasePluginConfigFence = release
        }
        const snapshot = this.input.lifecycle.snapshot()
        const [configRead, pluginsRead, policiesRead, inputsRead] = await Promise.allSettled([
          loadConfig(this.input.configPath, { profileId: this.input.profileId, projectRoot: this.input.homeDir }),
          loadPluginComposition(this.input.store, snapshot.active),
          this.policies(),
          this.profileInputs(snapshot),
        ])
        if (
          configRead.status !== 'fulfilled' || pluginsRead.status !== 'fulfilled' || policiesRead.status !== 'fulfilled'
          || inputsRead.status !== 'fulfilled'
        ) throw new Error('renderer-bootstrap-unavailable')
        const config = configRead.value
        const plugins = pluginsRead.value
        const policies = policiesRead.value
        // Configured plugins stay closed unless the owner explicitly supplies
        // the constrained read-only Channel composition.
        if (
          plugins.some(plugin => !emptyConfig(plugin.config))
          || config.plugins.length !== 0 && (
              !this.input.protectProfileInputs || !this.configuredChannel
              || config.plugins.length !== 1
              || config.plugins[0]?.id !== 'channel' || plugins.some(plugin => plugin.id === 'channel')
            )
        ) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        // Disabled packages are also serialized as Manager metadata.
        const packages = new Map<string, Awaited<ReturnType<typeof loadServiceRendererInitialPackage>>>()
        const managedOwners = new Map<string, string>()
        let needsIdentityProjection = false
        for (const item of snapshot.active.plugins) {
          const staged = await loadServiceRendererInitialPackage(this.input.homeDir, item)
          packages.set(item.id, staged)
          const manifest = staged.manifest.runtimeManifest
          if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V15 || manifest.capabilities.length > 0) {
            needsIdentityProjection = true
          }
          if (
            manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V14
            || manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V15
          ) {
            if (!this.managedServiceUI) throw new Error('renderer-bootstrap-plugin-unsupported')
            if (item.enabled) managedOwners.set(item.id, item.moduleGeneration)
          }
        }
        if (needsIdentityProjection && !this.input.protectProfileInputs) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        const active = snapshot.active.plugins.filter(plugin => plugin.enabled)
        if (active.length > MAX_INITIAL_GRAPHS) throw new Error('renderer-bootstrap-limit')
        if (active.length > 0) {
          const server = await this.input.lifecycle.artifactServer()
          for (const item of active) {
            const staged = packages.get(item.id)!
            if (!staged.browserArtifact) throw new Error('renderer-bootstrap-plugin-unsupported')
            const lease = await server.lease(
              {
                packageIdentity: { pluginId: item.id, version: item.version, integrity: item.digest },
                artifactDirectory: stagedPluginBrowserArtifactDirectory(this.input.homeDir, item.digest),
                runtimeEntry: staged.browserArtifact.manifest.entry,
              },
              item.moduleGeneration,
              staged.browserArtifact.manifest,
            )
            leases.push(lease)
            if (!this.current(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
          }
        }
        if (config.plugins.length === 1) {
          const channel = this.configuredChannel!
          const configured = await ServiceRendererConfiguredChannel.prepare({
            homeDir: this.input.homeDir,
            configPath: this.input.configPath,
            profileId: this.input.profileId,
            plugin: config.plugins[0]!,
            selectedPlugin: channel.plugin,
            service: channel.service,
            bridge: channel.bridge,
            allowConfiguration: this.input.experimentalChannelServiceConfig === true,
            server: await this.input.lifecycle.artifactServer(),
            current: () => this.current(rendererId, entry),
            unchanged: async () => await this.channelAuthorityCurrent(rendererId, entry),
            retire: () => entry.peer.close(),
          })
          entry.configuredChannel = configured
          entry.leases.push(configured.lease)
          if (!this.current(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
        }
        entry.snapshot = snapshot
        entry.config = config
        entry.plugins = plugins
        entry.policies = policies
        entry.packageInputs = inputsRead.value
        entry.managedOwners = managedOwners
        entry.needsIdentityProjection = needsIdentityProjection
        if (!await this.unchanged(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
        return {
          status: 'ok',
          snapshot,
          // Never send this object to the browser; the sidecar rewrites it.
          privateGraphs: leases.map(serviceRendererPrivateGraph),
        }
      } catch (error) {
        this.retire(rendererId, entry)
        throw error
      }
    })()
    return await entry.preparing
  }

  async complete(
    context: ManagerRendererChannelContext,
    managerOrigin: string,
    rawGraphs: unknown,
  ): Promise<unknown> {
    const rendererId = context.rendererId
    const entry = this.entries.get(rendererId)
    if (!entry || !entry.preparing || entry.channelTransition) throw new Error('renderer-bootstrap-unavailable')
    await entry.preparing
    if (entry.completing) {
      const result = await entry.completing
      if (!await this.unchanged(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
      return result
    }
    entry.completing = (async () => {
      try {
        if (
          !await this.unchanged(rendererId, entry) || !entry.snapshot || !entry.config || !entry.plugins
          || !entry.policies || !entry.managedOwners
        ) {
          throw new Error('renderer-bootstrap-stale')
        }
        if (!Array.isArray(rawGraphs) || rawGraphs.length !== entry.leases.length) {
          throw new Error('renderer-bootstrap-graphs-invalid')
        }
        const graphs = rawGraphs.map(value => parseManagerRendererGraph(value, managerOrigin))
        const byLease = new Map(graphs.map(graph => [graph.leaseId, graph]))
        const byPlugin = new Map<string, ManagerRendererGraph>(graphs.map(graph => [graph.pluginId, graph]))
        const bases = new Set(graphs.map(graph => graph.baseUrl))
        if (byLease.size !== graphs.length || byPlugin.size !== graphs.length || bases.size !== graphs.length) {
          throw new Error('renderer-bootstrap-graphs-invalid')
        }
        for (const lease of entry.leases) {
          // The authenticated sidecar assigns a distinct session-local alias;
          // the private owner lease identifier must never reach the browser.
          const graph = byPlugin.get(lease.pluginId)
          if (
            !graph || graph.pluginId !== lease.pluginId || graph.moduleGeneration !== lease.moduleGeneration
            || graph.entryUrl.slice(graph.baseUrl.length) !== lease.entryUrl.slice(lease.baseUrl.length)
            || !attachmentEqual(
              graph.initialStyleUrls.map(url => url.slice(graph.baseUrl.length)),
              lease.initialStyleUrls.map(url => url.slice(lease.baseUrl.length)),
            )
          ) throw new Error('renderer-bootstrap-graphs-invalid')
        }
        const configuredGraph = entry.configuredChannel && byPlugin.get('channel')
        if (entry.configuredChannel && !configuredGraph) throw new Error('renderer-bootstrap-graphs-invalid')
        const configured = entry.configuredChannel
          ? await entry.configuredChannel.project(context, configuredGraph!, managerOrigin, entry.policies)
          : undefined
        const snapshot = entry.snapshot
        let projectedSnapshot: Snapshot | undefined
        let projectedPolicies = entry.policies
        let projectedPlugins = entry.plugins
        if (entry.needsIdentityProjection) {
          const identity = new ServiceRendererIdentityProjection({
            homeDir: this.input.homeDir,
            context,
            isCurrent: () => this.current(rendererId, entry),
          })
          entry.identity = identity
          const aliases = new Map<string, string>()
          for (const plugin of entry.plugins) {
            const item = snapshot.active.plugins.find(value => value.id === plugin.id)
            if (!item) throw new Error('renderer-bootstrap-plugin-unsupported')
            aliases.set(plugin.id, await identity.issueInstalled(context, plugin, item))
          }
          entry.identityAliases = aliases
          projectedSnapshot = {
            active: identity.projectActivation(context, snapshot.active),
            registryEpoch: snapshot.registryEpoch,
          }
          projectedPolicies = entry.plugins.flatMap(plugin =>
            identity.projectManagerPolicies(context, aliases.get(plugin.id)!, plugin.id, entry.policies!)
          )
          projectedPlugins = entry.plugins.map(plugin => {
            const alias = aliases.get(plugin.id)!
            if (!plugin.package) throw new Error('renderer-bootstrap-plugin-unsupported')
            return {
              ...plugin,
              source: alias,
              package: {
                ...plugin.package,
                ...(plugin.package.canonicalSource === undefined ? {} : { canonicalSource: alias }),
              },
              readme: '',
              readmes: {},
              documents: [],
            }
          })
        }
        const config: CordisXConfig = {
          ...entry.config,
          plugins: [
            ...projectedPlugins.map(plugin => {
              if (!plugin.enabled) return plugin
              const graph = byPlugin.get(plugin.id)
              if (!graph) throw new Error('renderer-bootstrap-graphs-invalid')
              return { ...plugin, runtimeGraph: createStandaloneRuntimeGraph(graph, managerOrigin) }
            }),
            ...(configured === undefined ? [] : [configured.plugin]),
          ],
        }
        const managedServiceUICapabilities = entry.managedOwners.size === 0
          ? undefined
          : this.managedServiceUI?.projectInitial(context)
        if (entry.managedOwners.size > 0 && managedServiceUICapabilities === undefined) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        if (managedServiceUICapabilities !== undefined) entry.managedContext = context
        if (
          managedServiceUICapabilities?.some(capability =>
            entry.managedOwners!.get(capability.pluginId) !== capability.pluginGeneration
          )
        ) throw new Error('renderer-bootstrap-plugin-unsupported')
        const bundle = await buildRendererBundle(config, {
          managerPresentationMode: 'standalone',
          standaloneOwner: {
            rendererId,
            profileId: this.input.profileId,
            generation: this.input.generation,
            managerOrigin,
            isCurrent: async () => await this.unchanged(rendererId, entry),
          },
          profileId: this.input.profileId,
          appId: this.input.appId,
          generation: this.input.generation,
          permission: {
            profileId: this.input.profileId,
            policies: configured === undefined ? projectedPolicies : [
              ...projectedPolicies.filter(policy => policy.key.identity.pluginId !== 'channel'),
              ...configured.policies,
            ],
          },
          pluginActivation: projectedSnapshot?.active ?? snapshot.active,
          initialRegistryEpoch: snapshot.registryEpoch,
          pluginManagement: { profileId: this.input.profileId, token: 'renderer-binding-placeholder' },
          ...(configured === undefined ? {} : {
            channelManager: configured.projection,
            serviceCapabilityOwners: [configured.serviceOwner],
            channelActionsBridgeToken: 'renderer-binding-placeholder',
            ...(this.input.experimentalChannelServiceConfig && configured.projection.service.writable
              ? { serviceConfigBridgeToken: 'renderer-binding-placeholder' }
              : {}),
            ...(this.input.experimentalChannelCredentials && configured.projection.service.writable
              ? { channelCredentialBridgeToken: 'renderer-binding-placeholder' }
              : {}),
          }),
          ...(managedServiceUICapabilities === undefined ? {} : { managedServiceUICapabilities }),
        })
        if (entry.managedContext) this.managedServiceUI?.assertBundleSafe(context, bundle)
        if (entry.identity && entry.plugins.some(plugin => plugin.source && bundle.includes(plugin.source))) {
          throw new Error('renderer-bootstrap-unavailable')
        }
        if (entry.leases.some(lease => bundle.includes(lease.baseUrl)) || !await this.unchanged(rendererId, entry)) {
          throw new Error('renderer-bootstrap-unavailable')
        }
        const bytes = Buffer.from(bundle)
        let encoded: Awaited<ReturnType<typeof encodeManagerRendererBundle>>
        try {
          encoded = await encodeManagerRendererBundle(bytes)
        } finally {
          bytes.fill(0)
        }
        if (entry.managedContext) this.managedServiceUI?.assertBundleSafe(context, bundle)
        // Include the largest allowed request ID, the session envelope and the
        // terminating newline. The actual management RPC caps the whole frame.
        const result = { status: 'ok', bundle: encoded, initialGraphs: graphs }
        const response = { requestId: 'x'.repeat(128), ok: true, value: { status: 'ok', value: result } }
        if (
          Buffer.byteLength(`${JSON.stringify(response)}\n`) > MANAGER_BUNDLE_RPC_LIMIT
          || !await this.unchanged(rendererId, entry)
        ) throw new Error('renderer-bootstrap-unavailable')
        entry.configuredChannel?.bind(context)
        this.input.participants.confirmBootstrap(rendererId, snapshot, projectedSnapshot)
        entry.bootstrapConfirmed = true
        return result
      } catch (error) {
        this.retire(rendererId, entry)
        throw error
      }
    })()
    return await entry.completing
  }

  private managementEntry(context: ManagerRendererChannelContext): ManagementProjectionEntry | undefined {
    const entry = this.entries.get(context.rendererId)
    if (!entry) return undefined
    return {
      confirmed: entry.bootstrapConfirmed,
      current: () => this.current(context.rendererId, entry),
      unchanged: async () => await this.unchanged(context.rendererId, entry),
      identity: entry.identity,
      aliases: entry.identityAliases,
      snapshot: entry.snapshot,
    }
  }

  allowsManagementWrite(context: ManagerRendererChannelContext, kind: string): boolean {
    return allowsManagementWrite(this.managementEntry(context), kind)
  }

  async managementRequest(
    context: ManagerRendererChannelContext,
    kind: string,
    dispatch: () => Promise<unknown>,
  ): Promise<unknown> {
    return await projectManagementRequest({
      context,
      kind,
      dispatch,
      entry: this.managementEntry(context),
      ownerSnapshot: () => this.input.lifecycle.snapshot(),
    })
  }

  /** Not exposed as a generic browser binding. The sidecar supplies graph mappings. */
  channel(): ManagerRendererChannel {
    return {
      prepare: (payload, context) => {
        if (
          payload === null || typeof payload !== 'object' || Array.isArray(payload)
          || context.profileId !== this.input.profileId || context.ownerGeneration !== this.input.generation
        ) throw new Error('renderer-bootstrap-unavailable')
        const item = payload as Record<string, unknown>
        if (item.action === 'prepare' && Object.keys(item).length === 1) {
          return { mode: 'read', dispatch: async () => await this.prepare(context.rendererId) }
        }
        if (item.action === 'status' && Object.keys(item).length === 1) {
          return {
            mode: 'read',
            dispatch: async () => {
              const peer = this.input.participants.peer(context.rendererId)
              if (!peer) throw new Error('renderer-bootstrap-unavailable')
              const entry = this.entries.get(context.rendererId)
              if (entry?.channelTransition) {
                const current = this.current(context.rendererId, entry) && entry.channelTransition.isCurrent()
                if (!current) entry.peer.close()
                return { status: 'ok', current }
              }
              if (entry?.config && !await this.configurationCurrent(context.rendererId, entry)) {
                entry.stale = true
                entry.peer.close()
                return { status: 'ok', current: false }
              }
              if (entry?.managedContext) {
                try {
                  this.managedServiceUI?.projectInitial(context)
                } catch {
                  return { status: 'ok', current: false }
                }
              }
              return { status: 'ok', current: true }
            },
          }
        }
        if (
          item.action === 'complete' && Object.keys(item).length === 3
          && typeof item.managerOrigin === 'string' && Array.isArray(item.graphs)
          && Object.keys(item).every(key => ['action', 'managerOrigin', 'graphs'].includes(key))
        ) {
          return {
            mode: 'read',
            dispatch: async () => await this.complete(context, item.managerOrigin as string, item.graphs),
          }
        }
        throw new Error('renderer-bootstrap-unavailable')
      },
    }
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing
    this.closed = true
    this.unsubscribeFinalization()
    for (const [rendererId, entry] of this.entries) {
      entry.peer.close()
      this.retire(rendererId, entry)
    }
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const results = await Promise.race([
          Promise.all(this.retirements.values()),
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), 15_000)
          }),
        ])
        if (!results || !results.every(Boolean)) return false
        await Promise.all([this.permissionFence?.close(), this.pluginConfigFence?.close()])
        return true
      } catch {
        return false
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    return this.closing
  }
}
