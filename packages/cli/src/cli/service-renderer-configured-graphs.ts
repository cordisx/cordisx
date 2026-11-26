import type { CordisXConfigPlugin } from '../launcher/config.js'
import type {
  PluginGenerationArtifactServer,
  PluginGenerationGraphLease,
} from '../launcher/plugin-generation-artifact-server.js'
import { ServiceRendererConfiguredChannel } from './service-renderer-configured-channel.js'
import { prepareConfiguredPlugins, type ServiceRendererConfiguredPlugin } from './service-renderer-configured-plugin.js'
import type { ServiceRendererConfiguredChannelInput } from './service-renderer-bootstrap-state.js'

/** Prepare configured graphs under the bootstrap owner's existing resource lifecycle. */
export async function prepareServiceRendererConfiguredGraphs(input: {
  readonly homeDir: string
  readonly configPath: string
  readonly profileId: string
  readonly plugins: readonly CordisXConfigPlugin[]
  readonly channel?: CordisXConfigPlugin
  readonly channelOwner?: ServiceRendererConfiguredChannelInput
  readonly configured: ServiceRendererConfiguredPlugin[]
  readonly unavailable: CordisXConfigPlugin[]
  readonly leases: PluginGenerationGraphLease[]
  readonly setChannel: (channel: ServiceRendererConfiguredChannel) => void
  readonly server: () => Promise<PluginGenerationArtifactServer>
  readonly allowConfiguration: boolean
  readonly allowConnectionControl: boolean
  readonly allowConnectionReconnect: boolean
  readonly allowPendingTenantResolution: boolean
  readonly current: () => boolean
  readonly unchanged: () => Promise<boolean>
  readonly retire: () => void
  readonly projectConfiguration?: (plugin: CordisXConfigPlugin) => Promise<unknown>
}): Promise<void> {
  if (input.channel !== undefined && input.channelOwner === undefined) input.unavailable.push(input.channel)
  if (input.plugins.length > 0) {
    const unavailable = await prepareConfiguredPlugins({
      homeDir: input.homeDir,
      plugins: input.plugins,
      server: await input.server(),
      configured: input.configured,
      leases: input.leases,
      current: input.current,
      ...(input.projectConfiguration === undefined ? {} : { projectConfiguration: input.projectConfiguration }),
    })
    input.unavailable.push(...unavailable)
  }
  if (input.channel !== undefined && input.channelOwner !== undefined) {
    const channel = await ServiceRendererConfiguredChannel.prepare({
      homeDir: input.homeDir,
      configPath: input.configPath,
      profileId: input.profileId,
      plugin: input.channel,
      selectedPlugin: input.channelOwner.plugin,
      service: input.channelOwner.service,
      bridge: input.channelOwner.bridge,
      allowConfiguration: input.allowConfiguration,
      allowConnectionControl: input.allowConnectionControl,
      allowConnectionReconnect: input.allowConnectionReconnect,
      allowPendingTenantResolution: input.allowPendingTenantResolution,
      server: await input.server(),
      current: input.current,
      unchanged: input.unchanged,
      retire: input.retire,
    })
    input.setChannel(channel)
    input.leases.push(channel.lease)
    if (!input.current()) throw new Error('renderer-bootstrap-stale')
  }
}
