import { type HomeConfigProfile, loadHomeConfig } from '../config/home-config.js'
import { SharedProfilePermissionFence } from '../config/profile-permission-fence.js'
import { SharedProfilePluginConfigFence } from '../config/profile-plugin-config-fence.js'
import { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { buildRendererBundle } from '../launcher/bundle.js'
import { StandaloneRuntimeBundleCache } from '../launcher/standalone-runtime-bundle.js'
import type { CordisXConfig, CordisXConfigPlugin } from '../launcher/config.js'
import { loadServiceRendererConfig } from './service-renderer-config.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { RendererAttachmentIdentity } from '../launcher/renderer-lifecycle-peer.js'
import type { PluginRuntimeMutation } from '../launcher/plugin-lifecycle-model.js'
import type { PluginManagementRpcOperation } from '../launcher/management-rpc.js'
import { createStandaloneRuntimeGraph } from '../launcher/standalone-runtime-graph.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../standalone-permission-contract.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import type { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import { encodeManagerRendererBundle, MANAGER_BUNDLE_RPC_LIMIT } from './manager-renderer-bundle-codec.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { ManagerRendererWriteLifetimes } from './manager-renderer-write-lifetimes.js'
import { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import { prepareServiceRendererConfiguredGraphs } from './service-renderer-configured-graphs.js'
import {
  prepareServiceRendererInstalledGraphs,
  unavailableInstalledPlugin,
} from './service-renderer-installed-graphs.js'
import {
  assertConfiguredSourcesHidden,
  disabledConfiguredPlugin,
  projectConfiguredPlugins,
  unavailableConfiguredPlugin,
} from './service-renderer-configured-plugin.js'
import { ServiceRendererIdentityProjection } from './service-renderer-identity.js'
import { allowsManagementWrite, projectManagementRequest } from './service-renderer-management-projection.js'
import { serviceRendererManagementEntry } from './service-renderer-management-entry.js'
import type { ManagerOriginFence } from './manager-origin-fence.js'
import {
  retireFinalizedServiceRendererGraphs,
  serviceRendererPrivateGraph,
  validateServiceRendererGraphs,
} from './service-renderer-projection.js'
import { readOwnerProfileInputs } from './service-renderer-profile-inputs.js'
import { ServiceRendererLifecycleHandoff } from './service-renderer-lifecycle-handoff.js'
import { ServiceRendererPermissionAccess } from './service-renderer-permission-access.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import type { DesktopConfigurationReservation } from '../launcher/desktop-configuration-reservation.js'
import { restrictedLifecycleIds } from './service-renderer-management-eligibility.js'
import { ServiceRendererManagementPlans } from './service-renderer-management-plans.js'
import { serviceRendererBootstrapStatus } from './service-renderer-bootstrap-status.js'
import { closeBootstrapFences } from './service-renderer-bootstrap-cleanup.js'
import {
  type ConfiguredChannelHandoffResult,
  mutateServiceRendererConfiguredChannel,
} from './service-renderer-channel-handoff.js'
import {
  type DesktopConfigProjector,
  desktopPackageConfigBundleOptions,
  emptyPluginConfig,
  prepareDesktopManagerConfigs,
} from './desktop-manager-config-eligibility.js'
import type {
  ServiceRendererBootstrapEntry as Entry,
  ServiceRendererConfiguredChannelInput as ConfiguredChannel,
  ServiceRendererSnapshot as Snapshot,
} from './service-renderer-bootstrap-state.js'
const MAX_INITIAL_GRAPHS = 256
const MANAGED_STARTUP_WAIT_MS = 45_000
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
  private readonly runtimeBundle = new StandaloneRuntimeBundleCache()
  private readonly retirements = new Map<string, Promise<boolean>>()
  private readonly unsubscribeFinalization: () => void
  private readonly permissionFence: SharedProfilePermissionFence | undefined
  private readonly pluginConfigFence: SharedProfilePluginConfigFence | undefined
  private readonly ownerStartupConfig: NonNullable<HomeConfigProfile['managedServiceStartupConfig']>
  private readonly lifecycleHandoff: ServiceRendererLifecycleHandoff
  /** Owner-only policy projection and handoff; never exposed to the browser. */
  readonly permissionAccess: ServiceRendererPermissionAccess
  private managedServiceUI: ReturnType<typeof createManagerManagedServiceUIBridge> | undefined
  private configuredChannel: ConfiguredChannel | undefined
  private readonly selectedConfiguredPlugins: readonly CordisXConfigPlugin[] | undefined
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
      /** Desktop owner-selected configured graphs; never replaced by a later file edit. */
      readonly selectedConfiguredPlugins?: readonly CordisXConfigPlugin[]
      /** Fence cooperative Home policy and configured-plugin writers while snapshots are active. */
      readonly protectProfileInputs?: boolean
      /** Service owner may resolve its own bundled Channel archive. */
      readonly serviceOwnerBundledChannel?: boolean
      /** Owner-selected experimental, read-only configured Channel composition. */
      readonly experimentalConfiguredChannel?: ConfiguredChannel
      /** The production owner also supplied the coordinated Channel configuration bridge. */
      readonly experimentalChannelServiceConfig?: boolean
      /** The owner also supplied the coordinated connection-control bridge. */
      readonly experimentalChannelControl?: boolean
      /** The coordinated Channel bridge also supports reconnect. */
      readonly experimentalChannelReconnect?: boolean
      /** The owner also supplied the private, coordinated credential bridge. */
      readonly experimentalChannelCredentials?: boolean
      /** Owner-created verifier, enabled only with an independently coordinated policy channel. */
      readonly permissionProof?: Pick<ManagerPermissionProofAuthority, 'register'>
      /** Service owner has a coordinated policy channel for configured Channel UI. */
      readonly experimentalConfiguredPermissionPolicy?: boolean
      /** Service owner has the same policy handoff for eligible configured plugin graphs. */
      readonly experimentalConfiguredPluginPermissionPolicy?: boolean
      /** Service owner has a coordinated policy channel for installed Manager UI graphs. */
      readonly experimentalInstalledPermissionPolicy?: boolean
      /** Service owner only: the full lifecycle federation and owner plan cleanup are available. */
      readonly restrictedManagement?: {
        readonly available: () => boolean
        readonly discardPlan: (token: string) => void
      }
      /** Desktop owner only: read schema-redacted values from its existing authorized seat. */
      readonly projectPluginConfig?: DesktopConfigProjector
      /** Reprove configuration after a coordinated Desktop generation change. */
      readonly reserveDesktopConfig?: (
        peers: readonly ManagerRendererCommandPeer[],
      ) => Promise<DesktopConfigurationReservation>
      /** Available only after the Desktop owner's native config bridge is installed. */
      readonly desktopPackageConfigEnabled?: () => boolean
    },
  ) {
    if (
      (input.experimentalInstalledPermissionPolicy === true
        || input.experimentalConfiguredPluginPermissionPolicy === true)
      && (!input.protectProfileInputs || !input.permissionProof
        || !(input.lifecycle instanceof ServiceRendererLifecycle))
    ) throw new Error('renderer-permission-handoff-unavailable')
    this.ownerStartupConfig = structuredClone(input.ownerStartupConfig ?? {})
    this.selectedConfiguredPlugins = input.selectedConfiguredPlugins === undefined
      ? undefined
      : structuredClone(input.selectedConfiguredPlugins)
    this.configuredChannel = input.experimentalConfiguredChannel
    this.managedServiceUI = input.managedServiceUI
    this.permissionFence = input.protectProfileInputs
      ? new SharedProfilePermissionFence(input.configPath, input.profileId)
      : undefined
    this.pluginConfigFence = input.protectProfileInputs
      ? new SharedProfilePluginConfigFence(input.configPath, input.profileId)
      : undefined
    this.permissionAccess = new ServiceRendererPermissionAccess({
      profileId: input.profileId,
      generation: input.generation,
      configuredPolicyEnabled: input.experimentalConfiguredPermissionPolicy === true,
      configuredPluginPolicyEnabled: input.experimentalConfiguredPluginPermissionPolicy === true,
      installedPolicyEnabled: input.experimentalInstalledPermissionPolicy === true,
      channel: () => this.configuredChannel,
      permissionFence: this.permissionFence,
      entries: this.entries,
      participants: input.participants,
      lifecycle: input.lifecycle,
      readLifetimes: this.readLifetimes,
      policies: async () => await this.policies(),
      current: (rendererId, entry) => this.current(rendererId, entry),
    })
    this.lifecycleHandoff = new ServiceRendererLifecycleHandoff({
      homeDir: input.homeDir,
      configPath: input.configPath,
      profileId: input.profileId,
      store: input.store,
      entries: this.entries,
      participants: input.participants,
      lifecycle: input.lifecycle,
      ...(this.pluginConfigFence === undefined ? {} : { pluginFence: this.pluginConfigFence }),
      rememberPluginConfig: (snapshot, plugin, proof) =>
        this.input.projectPluginConfig?.remember?.(snapshot, plugin, proof) === true,
      canCoordinatePluginConfig: async (snapshot, plugin) =>
        await this.input.projectPluginConfig?.canCoordinateLifecycle?.(snapshot, plugin) === true,
      ...(input.reserveDesktopConfig === undefined ? {} : { reserveDesktopConfig: input.reserveDesktopConfig }),
      readLifetimes: this.readLifetimes,
      configuredChannel: () => this.configuredChannel,
      serviceOwnerBundledChannel: input.serviceOwnerBundledChannel === true,
      snapshot: () => input.lifecycle.snapshot(),
      policies: async () => await this.policies(),
      profileInputs: async snapshot => await this.profileInputs(snapshot),
      current: (rendererId, entry) => this.current(rendererId, entry),
    })
    this.unsubscribeFinalization = input.lifecycle.onActivationFinalized(active =>
      retireFinalizedServiceRendererGraphs(this.entries.values(), active)
    )
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

  /** Match the exact verifier shared by bootstrap and the owner policy channel. */
  usesPermissionProof(proof: ManagerPermissionProofAuthority): boolean {
    return !this.closed && this.input.permissionProof === proof
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
    return await readOwnerProfileInputs(this.input, this.ownerStartupConfig, snapshot)
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
          || entry.configuredPlugins?.some(plugin => !plugin.isCurrent())
        ) return false
        const snapshot = this.input.lifecycle.snapshot()
        const [configRead, policiesRead, inputsRead] = await Promise.allSettled([
          loadServiceRendererConfig(this.input),
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
          || entry.configuredPlugins?.some(plugin => !plugin.isCurrent())
        ) {
          return false
        }
        if (entry.managedContext) this.managedServiceUI?.projectInitial(entry.managedContext)
        if (!attachmentEqual(this.input.lifecycle.snapshot(), entry.snapshot)) return false
        const [configRead, pluginsRead, policiesRead, inputsRead] = await Promise.allSettled([
          loadServiceRendererConfig(this.input),
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
        if (
          this.selectedConfiguredPlugins !== undefined
          && !attachmentEqual(config.plugins, this.selectedConfiguredPlugins)
        ) return false
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
    try {
      if (this.entries.size === 0) this.input.projectPluginConfig?.clear()
    } catch {
      entry.cleanupFailed = true
    }
    entry.startupAbort.abort()
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
    for (const plugin of entry.configuredPlugins ?? []) {
      try {
        plugin.close()
      } catch {
        entry.cleanupFailed = true
      }
    }
    try {
      entry.managementPlans?.close()
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
      !entry?.configuredChannel || !entry.bootstrapConfirmed || entry.channelTransition || entry.lifecycleTransition
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
  async mutateConfiguredChannel<Result extends ConfiguredChannelHandoffResult>(
    origin: ManagerOriginFence,
    action: () => Promise<Result>,
  ): Promise<Result> {
    return await mutateServiceRendererConfiguredChannel(
      {
        generation: this.input.generation,
        channel: this.configuredChannel,
        pluginFence: this.pluginConfigFence,
        entries: this.entries,
        participants: this.input.participants,
        lifecycle: this.input.lifecycle,
        readLifetimes: this.readLifetimes,
        current: (rendererId, entry) => this.current(rendererId, entry),
      },
      origin,
      action,
    )
  }

  async prepare(rendererId: string): Promise<unknown> {
    if (this.closed || this.retirements.has(rendererId)) throw new Error('renderer-bootstrap-unavailable')
    const existing = this.entries.get(rendererId)
    if (existing?.channelTransition || existing?.lifecycleTransition) throw new Error('renderer-bootstrap-unavailable')
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
    entry = {
      peer,
      leases,
      checks: new Set(),
      unsubscribe,
      startupAbort: new AbortController(),
      stale: false,
      bootstrapConfirmed: false,
      ...(this.input.protectProfileInputs && this.input.restrictedManagement
        ? { managementPlans: new ServiceRendererManagementPlans(this.input.restrictedManagement.discardPlan) }
        : {}),
    }
    this.entries.set(rendererId, entry)
    if (peer.closed) {
      this.retire(rendererId, entry)
      throw new Error('renderer-bootstrap-unavailable')
    }
    entry.preparing = (async () => {
      try {
        if (this.managedServiceUI) {
          await this.managedServiceUI.waitForInitialReadiness(
            AbortSignal.any([entry.startupAbort.signal, AbortSignal.timeout(MANAGED_STARTUP_WAIT_MS)]),
          )
          if (!this.current(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
        }
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
          loadServiceRendererConfig(this.input),
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
        if (
          this.selectedConfiguredPlugins !== undefined
          && !attachmentEqual(config.plugins, this.selectedConfiguredPlugins)
        ) throw new Error('renderer-bootstrap-plugin-unsupported')
        // Channel requires its live service owner. Other enabled archives are
        // independently checked before their graph can join this projection.
        const activeConfigured = config.plugins.filter(plugin => plugin.enabled)
        const channelPlugin = activeConfigured.find(plugin => plugin.id === 'channel')
        const configuredPlugins = activeConfigured.filter(plugin => plugin.id !== 'channel')
        if (
          config.plugins.length > MAX_INITIAL_GRAPHS
          || config.plugins.length > 0 && !this.input.protectProfileInputs
          || config.plugins.some(plugin => plugins.some(installed => installed.id === plugin.id))
          || this.configuredChannel !== undefined && channelPlugin === undefined
        ) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        const active = snapshot.active.plugins.filter(plugin => plugin.enabled)
        if (active.length + activeConfigured.length > MAX_INITIAL_GRAPHS) throw new Error('renderer-bootstrap-limit')
        const installed = await prepareServiceRendererInstalledGraphs({
          homeDir: this.input.homeDir,
          plugins: snapshot.active.plugins,
          unprojectedConfigIds: new Set(
            this.input.projectPluginConfig === undefined
              ? plugins.filter(plugin => !emptyPluginConfig(plugin.config)).map(plugin => plugin.id)
              : [],
          ),
          managedServiceUIAvailable: this.managedServiceUI !== undefined,
          leases,
          server: async () => await this.input.lifecycle.artifactServer(),
          current: () => this.current(rendererId, entry),
        })
        const { unavailable, managedOwners } = installed
        let needsIdentityProjection = installed.needsIdentityProjection
        const availablePlugins = plugins.filter(plugin => !unavailable.has(plugin.id))
        if (
          availablePlugins.some(plugin => !emptyPluginConfig(plugin.config))
          && (!this.input.protectProfileInputs || !this.input.projectPluginConfig)
        ) throw new Error('renderer-bootstrap-plugin-unsupported')
        const {
          projectedConfigs,
          writablePlugins: desktopPackageConfigPlugins,
          lifecyclePlugins: desktopLifecycleConfigPlugins,
        } = await prepareDesktopManagerConfigs(
          this.input,
          snapshot,
          availablePlugins,
          managedOwners,
          () => this.current(rendererId, entry),
        )
        if (projectedConfigs.size > 0 || desktopPackageConfigPlugins.length > 0) needsIdentityProjection = true
        if (needsIdentityProjection && !this.input.protectProfileInputs) {
          throw new Error('renderer-bootstrap-plugin-unsupported')
        }
        entry.configuredPlugins = []
        entry.unavailableConfiguredPlugins = []
        await prepareServiceRendererConfiguredGraphs({
          homeDir: this.input.homeDir,
          configPath: this.input.configPath,
          profileId: this.input.profileId,
          plugins: configuredPlugins,
          ...(channelPlugin === undefined ? {} : { channel: channelPlugin }),
          ...(this.configuredChannel === undefined ? {} : { channelOwner: this.configuredChannel }),
          configured: entry.configuredPlugins,
          unavailable: entry.unavailableConfiguredPlugins,
          leases: entry.leases,
          setChannel: channel => entry.configuredChannel = channel,
          server: async () => await this.input.lifecycle.artifactServer(),
          allowConfiguration: this.input.experimentalChannelServiceConfig === true,
          allowConnectionControl: this.input.experimentalChannelControl === true,
          allowConnectionReconnect: this.input.experimentalChannelReconnect === true,
          allowPendingTenantResolution: this.input.experimentalChannelCredentials === true,
          current: () => this.current(rendererId, entry),
          unchanged: async () => await this.channelAuthorityCurrent(rendererId, entry),
          retire: () => entry.peer.close(),
          ...(this.input.protectProfileInputs && this.input.projectPluginConfig
            ? { projectConfiguration: async plugin => await this.input.projectPluginConfig!.project(snapshot, plugin) }
            : {}),
        })
        entry.snapshot = snapshot
        entry.config = config
        entry.plugins = plugins
        entry.projectedConfigs = projectedConfigs
        entry.desktopPackageConfigPlugins = desktopPackageConfigPlugins
        entry.desktopLifecycleConfigPlugins = desktopLifecycleConfigPlugins
        entry.policies = policies
        entry.packageInputs = inputsRead.value
        entry.managedOwners = managedOwners
        entry.unavailableInstalledPlugins = unavailable
        entry.needsIdentityProjection = needsIdentityProjection
        if (entry.managementPlans) {
          entry.restrictedLifecycleIds = await restrictedLifecycleIds(
            this.input.homeDir,
            snapshot,
            plugins,
            new Set(entry.desktopLifecycleConfigPlugins),
            unavailable,
          )
        }
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
    permissionPublicKey?: unknown,
  ): Promise<unknown> {
    const rendererId = context.rendererId
    const entry = this.entries.get(rendererId)
    if (!entry || !entry.preparing || entry.channelTransition || entry.lifecycleTransition) {
      throw new Error('renderer-bootstrap-unavailable')
    }
    if (
      this.input.permissionProof === undefined
        ? permissionPublicKey !== undefined
        : !permissionPublicKey || typeof permissionPublicKey !== 'object' || Array.isArray(permissionPublicKey)
          || context.admitted === true
    ) throw new Error('renderer-bootstrap-unavailable')
    const permissionKey = permissionPublicKey === undefined ? undefined : JSON.stringify(permissionPublicKey)
    if (permissionKey !== undefined && (typeof permissionKey !== 'string' || permissionKey.length > 1024)) {
      throw new Error('renderer-bootstrap-unavailable')
    }
    await entry.preparing
    if (entry.completing) {
      if (entry.permissionKey !== permissionKey) throw new Error('renderer-bootstrap-unavailable')
      const result = await entry.completing
      if (!await this.unchanged(rendererId, entry)) throw new Error('renderer-bootstrap-stale')
      return result
    }
    if (permissionKey !== undefined) entry.permissionKey = permissionKey
    entry.completing = (async () => {
      try {
        if (
          !await this.unchanged(rendererId, entry) || !entry.snapshot || !entry.config || !entry.plugins
          || !entry.policies || !entry.managedOwners
        ) {
          throw new Error('renderer-bootstrap-stale')
        }
        const { graphs, byPlugin } = validateServiceRendererGraphs(rawGraphs, managerOrigin, entry.leases)
        const configuredGraph = entry.configuredChannel && byPlugin.get('channel')
        if (entry.configuredChannel && !configuredGraph) throw new Error('renderer-bootstrap-graphs-invalid')
        const configured = entry.configuredChannel
          ? await entry.configuredChannel.project(context, configuredGraph!, managerOrigin, entry.policies)
          : undefined
        const configuredPlugins = await projectConfiguredPlugins({
          plugins: entry.configuredPlugins ?? [],
          graphs: byPlugin,
          context,
          origin: managerOrigin,
          policies: entry.policies,
        })
        const snapshot = entry.snapshot
        const unavailableInstalled = entry.unavailableInstalledPlugins ?? new Set<string>()
        let projectedSnapshot: Snapshot | undefined
        const disabledConfigured = entry.config.plugins.filter(plugin => !plugin.enabled)
        const disabledIds = new Set(disabledConfigured.map(plugin => plugin.id))
        const unavailableConfigured = entry.unavailableConfiguredPlugins ?? []
        const configuredIds = new Set([
          ...configuredPlugins.map(item => item.plugin.id),
          ...unavailableConfigured.map(plugin => plugin.id),
        ])
        let projectedPolicies = entry.policies.filter(policy =>
          !disabledIds.has(policy.key.identity.pluginId) && !configuredIds.has(policy.key.identity.pluginId)
        )
        let projectedPlugins = entry.plugins.map(plugin => {
          if (unavailableInstalled.has(plugin.id)) return plugin
          if (emptyPluginConfig(plugin.config)) return plugin
          if (!entry.projectedConfigs?.has(plugin.id)) throw new Error('renderer-bootstrap-plugin-unsupported')
          return { ...plugin, config: entry.projectedConfigs.get(plugin.id) }
        })
        if (entry.needsIdentityProjection) {
          const identity = new ServiceRendererIdentityProjection({
            homeDir: this.input.homeDir,
            context,
            isCurrent: () => this.current(rendererId, entry),
          })
          entry.identity = identity
          entry.identityContext = context
          const aliases = new Map<string, string>()
          for (const plugin of entry.plugins) {
            const item = snapshot.active.plugins.find(value => value.id === plugin.id)
            if (!item) throw new Error('renderer-bootstrap-plugin-unsupported')
            aliases.set(
              plugin.id,
              await identity.issueInstalled(
                context,
                plugin,
                item,
                unavailableInstalled.has(plugin.id) ? { unavailable: true } : {},
              ),
            )
          }
          entry.identityAliases = aliases
          projectedSnapshot = {
            active: identity.projectActivation(context, snapshot.active),
            registryEpoch: snapshot.registryEpoch,
          }
          projectedPolicies = entry.plugins.flatMap(plugin =>
            unavailableInstalled.has(plugin.id)
              ? []
              : identity.projectManagerPolicies(context, aliases.get(plugin.id)!, plugin.id, entry.policies!)
          )
          projectedPlugins = projectedPlugins.map(plugin => {
            const alias = aliases.get(plugin.id)!
            if (unavailableInstalled.has(plugin.id)) return unavailableInstalledPlugin(plugin, alias)
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
              if (!plugin.enabled || plugin.standaloneUnavailable) return plugin
              const graph = byPlugin.get(plugin.id)
              if (!graph) throw new Error('renderer-bootstrap-graphs-invalid')
              return { ...plugin, runtimeGraph: createStandaloneRuntimeGraph(graph, managerOrigin) }
            }),
            ...disabledConfigured.map(disabledConfiguredPlugin),
            ...unavailableConfigured.map(unavailableConfiguredPlugin),
            ...configuredPlugins.map(item => item.plugin),
            ...(configured === undefined ? [] : [configured.plugin]),
          ],
        }
        const managedServiceUICapabilities = entry.managedOwners.size === 0
          ? undefined
          : this.managedServiceUI?.projectInitial(context, entry.managedOwners)
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
            installedPermissionPolicy: this.input.experimentalInstalledPermissionPolicy === true,
            configuredChannelPermissionPolicy: this.input.experimentalConfiguredPermissionPolicy === true
              && this.input.permissionProof !== undefined,
            ...(this.input.experimentalConfiguredPluginPermissionPolicy === true
              ? { configuredPluginPermissionPolicy: configuredPlugins.map(item => item.plugin.id) }
              : {}),
            isCurrent: async () => await this.unchanged(rendererId, entry),
          },
          profileId: this.input.profileId,
          appId: this.input.appId,
          generation: this.input.generation,
          permission: {
            profileId: this.input.profileId,
            ...(this.input.permissionProof === undefined ? {} : { bridgeToken: STANDALONE_PERMISSION_BINDING_MARKER }),
            policies: [
              ...projectedPolicies.filter(policy =>
                configured === undefined || policy.key.identity.pluginId !== 'channel'
              ),
              ...configuredPlugins.flatMap(item => item.policies),
              ...(configured?.policies ?? []),
            ],
          },
          pluginActivation: projectedSnapshot?.active ?? snapshot.active,
          initialRegistryEpoch: snapshot.registryEpoch,
          pluginManagement: { profileId: this.input.profileId, token: 'renderer-binding-placeholder' },
          ...desktopPackageConfigBundleOptions(
            entry.desktopPackageConfigPlugins,
            this.input.desktopPackageConfigEnabled?.(),
          ),
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
        }, this.runtimeBundle)
        if (entry.managedContext) this.managedServiceUI?.assertBundleSafe(context, bundle)
        if (entry.identity && entry.plugins.some(plugin => plugin.source && bundle.includes(plugin.source))) {
          throw new Error('renderer-bootstrap-unavailable')
        }
        assertConfiguredSourcesHidden(bundle, entry.config.plugins, configuredIds)
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
        this.input.participants.confirmBootstrap(
          rendererId,
          snapshot,
          projectedSnapshot,
          entry.identity === undefined
            ? undefined
            : (alias, pluginId, snapshotItem) =>
              entry.identity!.resolveLifecycle(context, alias, pluginId, snapshotItem),
        )
        entry.bootstrapConfirmed = true
        this.input.permissionProof?.register(context, permissionPublicKey)
        return result
      } catch (error) {
        this.retire(rendererId, entry)
        throw error
      }
    })()
    return await entry.completing
  }

  private managementEntry(context: ManagerRendererChannelContext) {
    return serviceRendererManagementEntry(this.entries.get(context.rendererId), {
      ...(this.input.restrictedManagement === undefined
        ? {}
        : { available: this.input.restrictedManagement.available }),
      current: entry => this.current(context.rendererId, entry),
      unchanged: async entry => await this.unchanged(context.rendererId, entry),
    })
  }

  allowsManagementWrite(context: ManagerRendererChannelContext, operation: PluginManagementRpcOperation): boolean {
    return allowsManagementWrite(this.managementEntry(context), operation)
  }

  async managementRequest(
    context: ManagerRendererChannelContext,
    operation: PluginManagementRpcOperation,
    dispatch: (operation?: PluginManagementRpcOperation) => Promise<unknown>,
  ): Promise<unknown> {
    return await projectManagementRequest({
      context,
      operation,
      dispatch,
      entry: () => this.managementEntry(context),
      ownerSnapshot: () => this.input.lifecycle.snapshot(),
    })
  }

  /** Owner-only lifecycle handoff; the caller must already hold the wider profile fences. */
  async reserveLifecycleHandoff(input: Parameters<ServiceRendererLifecycleHandoff['reserve']>[0]) {
    return await this.lifecycleHandoff.reserve(input)
  }

  readonly reservePackageConfig = (origin: ManagerOriginFence, pluginId: string) =>
    this.lifecycleHandoff.reservePackageConfig(origin, pluginId)

  canProjectLifecycle(identity: RendererAttachmentIdentity): boolean {
    return this.lifecycleHandoff.canProject(identity)
  }

  async projectLifecycleMutation(
    mutation: PluginRuntimeMutation,
    identity: RendererAttachmentIdentity,
    stage?: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.lifecycleHandoff.project(mutation, identity, stage)
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
              return await serviceRendererBootstrapStatus({
                entry: this.entries.get(context.rendererId),
                current: entry => this.current(context.rendererId, entry),
                configurationCurrent: async entry => await this.configurationCurrent(context.rendererId, entry),
                checkManagedServiceUI: () => {
                  if (!this.managedServiceUI) throw new Error('renderer-bootstrap-unavailable')
                  this.managedServiceUI.assertStatusCurrent(context)
                },
              })
            },
          }
        }
        if (
          item.action === 'complete' && Object.keys(item).length === (this.input.permissionProof ? 4 : 3)
          && typeof item.managerOrigin === 'string' && Array.isArray(item.graphs)
          && Object.keys(item).every(key => ['action', 'managerOrigin', 'graphs', 'permissionPublicKey'].includes(key))
          && (this.input.permissionProof === undefined || Object.hasOwn(item, 'permissionPublicKey'))
        ) {
          return {
            mode: 'read',
            dispatch: async () =>
              await this.complete(context, item.managerOrigin as string, item.graphs, item.permissionPublicKey),
          }
        }
        throw new Error('renderer-bootstrap-unavailable')
      },
    }
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing
    this.closed = true
    this.runtimeBundle.close()
    this.lifecycleHandoff.close()
    this.unsubscribeFinalization()
    for (const [rendererId, entry] of this.entries) {
      entry.peer.close()
      this.retire(rendererId, entry)
    }
    this.closing = closeBootstrapFences(this.retirements.values(), [this.permissionFence, this.pluginConfigFence])
    return this.closing
  }
}
