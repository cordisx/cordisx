import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { HomeConfigProfile } from '../config/home-config.js'
import type { CdpPluginLifecycleRuntime } from '../launcher/cdp-plugin-lifecycle-runtime.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-artifact-server.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import type { PluginLifecycleRuntime } from '../launcher/plugin-lifecycle-model.js'
import { attachmentEqual, attachmentHomeDigest } from '../launcher/renderer-lifecycle-peer.js'
import { DesktopOwnerRendererLifecycle } from './desktop-owner-renderer-lifecycle.js'
import { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import {
  createServiceRendererProjector,
  inspectServiceRendererInitialPackage,
  loadServiceConfiguredChannelArchive,
} from './service-renderer-projection.js'
import { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import { createManagerRendererModelServicesChannel } from './manager-renderer-model-services.js'
import { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import { supportsReadonlyConfiguredChannel } from './readonly-headless-channel.js'
import { DesktopManagerConfigProjection } from './desktop-manager-config-projection.js'
import { DesktopPackageConfigWriteGate } from './desktop-package-config-write.js'
import type { ProductionPluginManagementComposition } from './production-plugin-management.js'
import { reserveServiceOwnerLifecycle } from './service-owner-lifecycle-fence.js'
import { ServiceOwnerLifecycleRuntime } from './service-owner-lifecycle-runtime.js'
import { inspectServiceRendererConfiguredPlugin } from './service-renderer-configured-plugin.js'

/** Compose the optional Manager inside an already-authorized Desktop owner. */
export function createDesktopManagerOwner(input: {
  readonly homeDir: string
  readonly configPath: string
  readonly appId: string
  readonly profileId: string
  readonly generation: string
  readonly ownerStartupConfig?: HomeConfigProfile['managedServiceStartupConfig']
  readonly cdp: CdpPluginLifecycleRuntime
  readonly artifactServer: PluginGenerationArtifactServer
  readonly store: PluginActivationStore
  /** Exact configured plugins selected before this Desktop owner starts. */
  readonly selectedConfiguredPlugins?: readonly CordisXConfigPlugin[]
  /** The Desktop owner's current, revision-checked model-service authority. */
  readonly codex?: (operation: string, request: unknown) => Promise<unknown>
  /** Exact configured archive selected before the Desktop service starts. */
  readonly configuredChannel?: CordisXConfigPlugin
  /** Bound lazily after the same owner opens its management RPC. */
  readonly management?: () => ProductionPluginManagementComposition | undefined
}) {
  const scope = {
    homeDigest: attachmentHomeDigest(input.homeDir),
    ownerAppId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
  }
  const participants = new ServiceRendererParticipants(scope)
  let bootstrap!: ServiceRendererBootstrap
  let closed = false
  let packageConfigWritesEnabled = false
  const lifecycle = new DesktopOwnerRendererLifecycle({
    scope,
    cdp: input.cdp,
    artifactServer: input.artifactServer,
    projectManagerMutation: createServiceRendererProjector({
      homeDir: input.homeDir,
      profileId: input.profileId,
      generation: input.generation,
      isLive: identity => participants.isLive(identity),
      canMutate: identity => participants.canMutate(identity),
      canProjectIdentity: identity => bootstrap?.canProjectLifecycle(identity) === true,
      projectIdentity: async (mutation, identity, stage) => {
        if (!bootstrap) throw new Error('renderer-projection-session-unavailable')
        return await bootstrap.projectLifecycleMutation(mutation, identity, stage)
      },
    }),
  })
  participants.bind(lifecycle)
  const packageConfigWrites = new DesktopPackageConfigWriteGate()
  const configProjection = new DesktopManagerConfigProjection({
    current: snapshot => {
      try {
        return !closed && attachmentEqual(lifecycle.snapshot(), snapshot)
      } catch {
        return false
      }
    },
    seat: () => input.cdp.managerConfigSeat()?.token,
    read: async pluginId => await lifecycle.managerConfigProof(pluginId),
  })
  const unsubscribeSeats = input.cdp.onConfigSeatsChanged(() => {
    packageConfigWrites.invalidate()
    const hadProjection = configProjection.hasValues
    configProjection.clear()
    if (hadProjection) participants.disconnectAll()
  })
  const unsubscribeNoSeats = input.cdp.onNoReadySessions(() => {
    configProjection.clear()
    participants.disconnectAll()
  })
  const participant = {
    create: (request: Parameters<typeof participants.participant.create>[0]) => {
      // No private session may outlive or precede its last admitted Desktop seat.
      lifecycle.snapshot()
      return participants.participant.create(request)
    },
    attach: participants.participant.attach,
  }
  let closing: Promise<boolean> | undefined
  let managedServiceUI: ReturnType<typeof createManagerManagedServiceUIBridge> | undefined
  const management = () => {
    try {
      const current = input.management?.()
      return !closed && current?.handler.profileId === input.profileId
          && current.handler.generation === input.generation && current.lifecycleParticipants
          && current.lifecycleParticipants.matchesDesktop?.(participants, lifecycle) === true
        ? current
        : undefined
    } catch {
      return undefined
    }
  }
  const channelBridge = input.configuredChannel === undefined
    ? undefined
    : new ReadonlyChannelRendererBridge({
      profileId: input.profileId,
      generation: input.generation,
      isCurrent: context => !closed && participants.peer(context.rendererId) !== undefined,
    })
  bootstrap = new ServiceRendererBootstrap({
    homeDir: input.homeDir,
    configPath: input.configPath,
    appId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
    ownerStartupConfig: input.ownerStartupConfig,
    lifecycle,
    participants,
    store: input.store,
    ...(input.selectedConfiguredPlugins === undefined
      ? {}
      : { selectedConfiguredPlugins: input.selectedConfiguredPlugins }),
    // Empty profiles also project permission and plugin-configuration snapshots.
    protectProfileInputs: process.platform === 'darwin' || process.platform === 'linux',
    projectPluginConfig: configProjection,
    reserveDesktopConfig: async peers => await lifecycle.reserveExternalMutation(peers),
    desktopPackageConfigEnabled: () => packageConfigWritesEnabled,
    ...(input.management === undefined ? {} : {
      restrictedManagement: {
        available: () => management()?.handler.service.discardExecutionPlan !== undefined,
        discardPlan: token => {
          const discard = management()?.handler.service.discardExecutionPlan
          if (!discard) throw new Error('renderer-management-plan-cleanup-unavailable')
          discard(token)
        },
      },
    }),
  })
  const rendererModelServices = input.codex === undefined
    ? undefined
    : createManagerRendererModelServicesChannel({
      profileId: input.profileId,
      generation: input.generation,
      isCurrent: context => !closed && participants.peer(context.rendererId) !== undefined,
      call: input.codex,
    })
  const bindManagedServiceRuntime = (runtime: ManagedServicePluginLifecycleRuntime): boolean => {
    if (closed || managedServiceUI) return false
    const bridge = createManagerManagedServiceUIBridge({
      profileId: input.profileId,
      runtimeGeneration: input.generation,
      ownerGeneration: input.generation,
      ownerCurrent: () => !closed,
      readLifecycleFence: () => runtime.readManagedServiceUIFence(),
      runtime,
    })
    if (!bootstrap.bindManagedServiceUI(bridge)) {
      bridge.dispose()
      return false
    }
    managedServiceUI = bridge
    return true
  }
  return {
    lifecycle,
    packageConfigWrites,
    get managementOptions() {
      return {
        rendererParticipant: participant,
        rendererBootstrap: bootstrap.channel(),
        rendererManagementAuthority: bootstrap,
        rendererRetirement: (rendererId: string) => bootstrap.waitForRetirement(rendererId),
        rendererWriteLifetimes: bootstrap.writeLifetimes,
        rendererReadLifetimes: bootstrap.readLifetimes,
        ...(input.management === undefined ? {} : {
          rendererDesktopLifecycle: { participant, participants, lifecycle },
        }),
        ...(packageConfigWritesEnabled
          ? {
            rendererDesktopPackageConfig: {
              participant,
              participants,
              lifecycle,
              bootstrap,
              writes: packageConfigWrites,
            },
          }
          : {}),
        ...(managedServiceUI === undefined ? {} : { rendererManagedServiceUI: managedServiceUI.channel }),
        ...(rendererModelServices === undefined ? {} : { rendererModelServices }),
        ...(channelBridge === undefined ? {} : { rendererReadonlyChannel: channelBridge.channel }),
      }
    },
    enablePackageConfigWrites(rendererGeneration: string): boolean {
      if (
        closed || packageConfigWritesEnabled || rendererGeneration !== input.generation
        || process.platform !== 'darwin' && process.platform !== 'linux'
      ) return false
      packageConfigWritesEnabled = true
      return true
    },
    bindConfiguredChannel(plugin: CordisXConfigPlugin, service: LocalChannelService): boolean {
      const owner = service.managementOwner()
      if (
        closed || !channelBridge || !input.configuredChannel || !attachmentEqual(plugin, input.configuredChannel)
        || !service.generation() || !owner || owner.source !== plugin.source || owner.pluginId !== 'channel'
        || owner.serviceId !== 'runtime' || owner.serviceKind !== 'channel-adapter'
      ) return false
      return bootstrap.bindConfiguredChannel({ plugin, service, bridge: channelBridge })
    },
    bindManagedServiceRuntime,
    coordinateLifecycle(runtime: PluginLifecycleRuntime): PluginLifecycleRuntime {
      return new ServiceOwnerLifecycleRuntime({
        runtime,
        reserve: mutation => {
          const livePeers = participants.ownerPeers()
          const owner = management()
          const managers = owner?.lifecycleParticipants
          if (!managers?.hasLive()) {
            if (livePeers.length > 0) throw new Error('manager-lifecycle-fence-unavailable')
            return undefined
          }
          if (!managedServiceUI) throw new Error('manager-lifecycle-fence-unavailable')
          return reserveServiceOwnerLifecycle({
            mutation,
            management: managers,
            bootstrap,
            managedUI: managedServiceUI,
            lifecycle,
            participants,
          })
        },
      })
    },
    initialize(
      active: CordisXPluginActivationRecordV1,
      recoveryPending: boolean,
      runtime?: ManagedServicePluginLifecycleRuntime,
    ) {
      lifecycle.initialize(active, recoveryPending)
      if (runtime) bindManagedServiceRuntime(runtime)
    },
    close(): Promise<boolean> {
      if (closing) return closing
      closed = true
      packageConfigWrites.close()
      configProjection.clear()
      unsubscribeSeats()
      unsubscribeNoSeats()
      closing = (async () => {
        const retired = await bootstrap.close()
        managedServiceUI?.dispose()
        return retired
      })()
      channelBridge?.close()
      participants.close()
      lifecycle.close()
      return closing
    },
  }
}

/** Preserve the current Desktop path for profiles we cannot safely project yet. */
export async function createDesktopManagerOwnerIfEligible(
  input: Omit<Parameters<typeof createDesktopManagerOwner>[0], 'configuredChannel'> & {
    readonly ownerVerified: boolean
    readonly attach: boolean
    readonly configuredPlugins: readonly CordisXConfigPlugin[]
  },
): Promise<ReturnType<typeof createDesktopManagerOwner> | undefined> {
  if (!input.ownerVerified || input.attach) return undefined
  const active = await input.store.loadActive()
  try {
    for (const plugin of active.plugins) {
      const inspected = await inspectServiceRendererInitialPackage(input.homeDir, plugin)
      if (!inspected.supported && !inspected.safeToOmit) return undefined
      const staged = inspected.staged
      if (
        (!inspected.supported || staged.manifest.runtimeManifest.capabilities.length > 0
          || staged.manifest.runtimeManifest.schemaVersion === 15
          || staged.manifest.runtimeManifest.schemaVersion === 16)
        && process.platform !== 'darwin' && process.platform !== 'linux'
      ) return undefined
    }
  } catch {
    return undefined
  }
  if (input.configuredPlugins.length > 0 && process.platform !== 'darwin' && process.platform !== 'linux') {
    return undefined
  }
  let configuredChannel: CordisXConfigPlugin | undefined
  const configuredIds = new Set<string>()
  for (const plugin of input.configuredPlugins) {
    if (configuredIds.has(plugin.id) || active.plugins.some(item => item.id === plugin.id)) return undefined
    configuredIds.add(plugin.id)
    if (!plugin.enabled) continue
    try {
      if (plugin.id === 'channel') {
        if (!supportsReadonlyConfiguredChannel(plugin)) return undefined
        await loadServiceConfiguredChannelArchive(input.homeDir, plugin)
        configuredChannel = plugin
      } else {
        const inspected = await inspectServiceRendererConfiguredPlugin(input.homeDir, plugin)
        // Installed-package transactions do not coordinate configured dependents yet.
        if (!inspected || inspected.staged.manifest.dependencies.length !== 0) return undefined
      }
    } catch {
      return undefined
    }
  }
  return createDesktopManagerOwner({
    ...input,
    selectedConfiguredPlugins: input.configuredPlugins,
    ...(configuredChannel === undefined ? {} : { configuredChannel }),
  })
}
