import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { CdpPluginLifecycleRuntime } from '../launcher/cdp-plugin-lifecycle-runtime.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-artifact-server.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import { attachmentEqual, attachmentHomeDigest } from '../launcher/renderer-lifecycle-peer.js'
import { DesktopOwnerRendererLifecycle } from './desktop-owner-renderer-lifecycle.js'
import { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import {
  createServiceRendererProjector,
  loadServiceConfiguredChannelArchive,
  loadServiceRendererInitialPackage,
} from './service-renderer-projection.js'
import { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import { createManagerRendererModelServicesChannel } from './manager-renderer-model-services.js'
import { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import { supportsReadonlyConfiguredChannel } from './readonly-headless-channel.js'

/** Compose the optional Manager inside an already-authorized Desktop owner. */
export function createDesktopManagerOwner(input: {
  readonly homeDir: string
  readonly configPath: string
  readonly appId: string
  readonly profileId: string
  readonly generation: string
  readonly cdp: CdpPluginLifecycleRuntime
  readonly artifactServer: PluginGenerationArtifactServer
  readonly store: PluginActivationStore
  /** The Desktop owner's current, revision-checked model-service authority. */
  readonly codex?: (operation: string, request: unknown) => Promise<unknown>
  /** Exact configured archive selected before the Desktop service starts. */
  readonly configuredChannel?: CordisXConfigPlugin
}) {
  const scope = {
    homeDigest: attachmentHomeDigest(input.homeDir),
    ownerAppId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
  }
  const participants = new ServiceRendererParticipants(scope)
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
    }),
  })
  participants.bind(lifecycle)
  const unsubscribeNoSeats = input.cdp.onNoReadySessions(() => participants.disconnectAll())
  const participant = {
    create: (request: Parameters<typeof participants.participant.create>[0]) => {
      // No private session may outlive or precede its last admitted Desktop seat.
      lifecycle.snapshot()
      return participants.participant.create(request)
    },
    attach: participants.participant.attach,
  }
  let closed = false
  let closing: Promise<boolean> | undefined
  let managedServiceUI: ReturnType<typeof createManagerManagedServiceUIBridge> | undefined
  const channelBridge = input.configuredChannel === undefined
    ? undefined
    : new ReadonlyChannelRendererBridge({
      profileId: input.profileId,
      generation: input.generation,
      isCurrent: context => !closed && participants.peer(context.rendererId) !== undefined,
    })
  const bootstrap = new ServiceRendererBootstrap({
    homeDir: input.homeDir,
    configPath: input.configPath,
    appId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
    lifecycle,
    participants,
    store: input.store,
    // Empty profiles also project permission and plugin-configuration snapshots.
    protectProfileInputs: process.platform === 'darwin' || process.platform === 'linux',
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
    get managementOptions() {
      return {
        rendererParticipant: participant,
        rendererBootstrap: bootstrap.channel(),
        rendererManagementAuthority: bootstrap,
        rendererRetirement: (rendererId: string) => bootstrap.waitForRetirement(rendererId),
        rendererWriteLifetimes: bootstrap.writeLifetimes,
        rendererReadLifetimes: bootstrap.readLifetimes,
        ...(managedServiceUI === undefined ? {} : { rendererManagedServiceUI: managedServiceUI.channel }),
        ...(rendererModelServices === undefined ? {} : { rendererModelServices }),
        ...(channelBridge === undefined ? {} : { rendererReadonlyChannel: channelBridge.channel }),
      }
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
      const staged = await loadServiceRendererInitialPackage(input.homeDir, plugin)
      if (
        (staged.manifest.runtimeManifest.capabilities.length > 0
          || staged.manifest.runtimeManifest.schemaVersion === 15)
        && process.platform !== 'darwin' && process.platform !== 'linux'
      ) return undefined
    }
  } catch {
    return undefined
  }
  let configuredChannel: CordisXConfigPlugin | undefined
  if (input.configuredPlugins.length !== 0) {
    const plugin = input.configuredPlugins[0]
    if (
      input.configuredPlugins.length !== 1 || !plugin || !supportsReadonlyConfiguredChannel(plugin)
      || active.plugins.some(item => item.id === plugin.id)
      || process.platform !== 'darwin' && process.platform !== 'linux'
    ) return undefined
    try {
      await loadServiceConfiguredChannelArchive(input.homeDir, plugin)
    } catch {
      return undefined
    }
    configuredChannel = plugin
  }
  return createDesktopManagerOwner({
    ...input,
    ...(configuredChannel === undefined ? {} : { configuredChannel }),
  })
}
