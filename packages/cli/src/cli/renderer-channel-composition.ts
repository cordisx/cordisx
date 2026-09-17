import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readServiceConfigState } from '../config/service-config.js'
import {
  CHANNEL_SERVICE_CONFIG_INITIAL,
  createLocalChannelService,
  type LocalChannelService,
  projectLocalChannelManager,
} from '../launcher/channel-service.js'
import type { CordisXConfig, CordisXConfigPlugin } from '../launcher/config.js'
import type { ChannelManagerBundleProjection } from './renderer-composition.js'

export interface RendererChannelComposition {
  readonly plugin?: CordisXConfigPlugin
  readonly service?: LocalChannelService
  readonly manager?: ChannelManagerBundleProjection
  readonly credentialBridgeToken?: string
  readonly actionsBridgeToken?: string
  readonly loadManagerProjection: () => Promise<ChannelManagerBundleProjection | undefined>
}

/** Start the configured Channel service and project its exact state into renderer composition metadata. */
export async function createRendererChannelComposition(input: {
  readonly composition: CordisXConfig
  readonly profileId: string
  readonly configPath: string
  readonly homeDir: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<RendererChannelComposition> {
  const plugin = input.composition.plugins.find(plugin => plugin.enabled && plugin.id === 'channel')
  let service: LocalChannelService | undefined
  const loadManagerProjection = async (): Promise<ChannelManagerBundleProjection | undefined> => {
    if (plugin === undefined || service === undefined) return undefined
    const state = await readServiceConfigState({
      profileId: input.profileId,
      pluginId: 'channel',
      serviceId: 'runtime',
      initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
        typeof readServiceConfigState
      >[0]['initialConfig'],
    }, input.configPath)
    return projectLocalChannelManager({
      configuration: state.config,
      revision: state.revision,
      lastGoodRevision: state.lastGoodRevision,
      writable: true,
      ...(service.snapshot() === undefined ? {} : { runtime: service.snapshot()! }),
      audit: service.auditSnapshot(),
    })
  }
  if (plugin === undefined) return { loadManagerProjection }
  const state = await readServiceConfigState({
    profileId: input.profileId,
    pluginId: 'channel',
    serviceId: 'runtime',
    initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
      typeof readServiceConfigState
    >[0]['initialConfig'],
  }, input.configPath)
  service = createLocalChannelService({
    artifactDirectory: path.dirname(plugin.entry),
    dataDir: path.join(input.homeDir, 'cache', 'channel-runtime'),
    source: plugin.source ?? pathToFileURL(plugin.entry).href,
    environment: input.environment,
  })
  await service.start(state.config)
  return {
    plugin,
    service,
    manager: await loadManagerProjection(),
    credentialBridgeToken: randomBytes(32).toString('hex'),
    actionsBridgeToken: randomBytes(32).toString('hex'),
    loadManagerProjection,
  }
}
