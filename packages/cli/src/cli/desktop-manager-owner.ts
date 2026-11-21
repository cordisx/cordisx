import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { CdpPluginLifecycleRuntime } from '../launcher/cdp-plugin-lifecycle-runtime.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-artifact-server.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import { attachmentEqual, attachmentHomeDigest } from '../launcher/renderer-lifecycle-peer.js'
import { DesktopOwnerRendererLifecycle } from './desktop-owner-renderer-lifecycle.js'
import { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { createServiceRendererProjector, loadServiceConfiguredChannelArchive } from './service-renderer-projection.js'
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
  return {
    lifecycle,
    managementOptions: {
      rendererParticipant: participant,
      rendererBootstrap: bootstrap.channel(),
      rendererRetirement: (rendererId: string) => bootstrap.waitForRetirement(rendererId),
      rendererWriteLifetimes: bootstrap.writeLifetimes,
      rendererReadLifetimes: bootstrap.readLifetimes,
      ...(rendererModelServices === undefined ? {} : { rendererModelServices }),
      ...(channelBridge === undefined ? {} : { rendererReadonlyChannel: channelBridge.channel }),
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
    initialize(active: CordisXPluginActivationRecordV1, recoveryPending: boolean) {
      lifecycle.initialize(active, recoveryPending)
    },
    close(): Promise<boolean> {
      if (closing) return closing
      closed = true
      unsubscribeNoSeats()
      closing = bootstrap.close()
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
  if (
    !input.ownerVerified || input.attach || (await input.store.loadActive()).plugins.length !== 0
  ) return undefined
  let configuredChannel: CordisXConfigPlugin | undefined
  if (input.configuredPlugins.length !== 0) {
    const plugin = input.configuredPlugins[0]
    if (
      input.configuredPlugins.length !== 1 || !plugin || !supportsReadonlyConfiguredChannel(plugin)
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
