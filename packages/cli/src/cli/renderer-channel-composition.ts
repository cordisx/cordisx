import { randomBytes } from 'node:crypto'
import { HostServiceConfigNarrowApi } from '../launcher/service-config.js'
import { createChannelHostServiceConfigContract } from '../launcher/channel-service.js'
import { createChannelCredentialBridgeHandler } from '../launcher/channel-credential-rpc.js'
import { createChannelActionsBridgeHandler } from '../launcher/channel-actions-rpc.js'
import { ChannelConversationManagement } from '../launcher/channel-conversation-management.js'
import { configuredChannelManager } from '../launcher/channel-connection-configuration.js'
import { LauncherSecretStore } from '../launcher/secret-store.js'
import type { ChannelConversationConsumer } from '../launcher/channel-conversation-consumer.js'
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
import type { HostServiceCapabilityOwner } from '../service-capability-ownership.js'
import type { ChannelManagerApi } from '../launcher/channel-manager-api.js'

export interface RendererChannelComposition {
  readonly serviceCapabilityOwners?: readonly HostServiceCapabilityOwner[]
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
  readonly appId: string
  readonly configPath: string
  readonly homeDir: string
  readonly environment: NodeJS.ProcessEnv
  readonly dryRun?: boolean
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
      identity: ref => service!.identity(ref),
    })
  }
  // Planning must not create a profile runtime, subscribe to messages or resolve credentials.
  if (plugin === undefined || input.dryRun) {
    return { loadManagerProjection, actionsBridgeToken: randomBytes(32).toString('hex') }
  }
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
    ...(plugin.configuredServiceEntry === undefined && plugin.package === undefined
      ? {}
      : { runtimeEntry: plugin.configuredServiceEntry ?? './services/runtime.mjs' as const }),
    dataDir: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-runtime'),
    source: plugin.source ?? pathToFileURL(plugin.entry).href,
    environment: input.environment,
    homeDir: input.homeDir,
  })
  await service.start(state.config)
  return {
    plugin,
    service,
    serviceCapabilityOwners: service.managementOwner() === undefined ? [] : [service.managementOwner()!],
    manager: await loadManagerProjection(),
    credentialBridgeToken: randomBytes(32).toString('hex'),
    actionsBridgeToken: randomBytes(32).toString('hex'),
    loadManagerProjection,
  }
}

/** The owning Channel service supplies CAS and restart; renderer callers never construct it. */
export function channelConfigurationApi(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly plugin: CordisXConfigPlugin
  readonly service: LocalChannelService
  readonly expectedServiceGeneration?: string
}): HostServiceConfigNarrowApi {
  const contract = createChannelHostServiceConfigContract({
    source: input.plugin.source ?? pathToFileURL(input.plugin.entry).href,
    pluginId: 'channel',
    serviceId: 'runtime',
  })
  return new HostServiceConfigNarrowApi({
    contract: contract as unknown as ConstructorParameters<typeof HostServiceConfigNarrowApi>[0]['contract'],
    profileId: input.profileId,
    generation: input.generation,
    ownerToken: input.token,
    configPath: input.configPath,
    writable: true,
    authorize: () => true,
    restartService: candidate => input.service.restart(candidate, input.expectedServiceGeneration),
  })
}

/** Bind credentials, actions and configuration to the same configured Channel owner. */
export function createChannelLaunchBridges(input: {
  readonly channel: RendererChannelComposition
  readonly token: string | undefined
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly consumer: ChannelConversationConsumer | undefined
  readonly execution?: (operation: string, args: Record<string, unknown>) => Promise<{ status: string; code?: string }>
}) {
  const { channel } = input
  const configApi = input.token !== undefined && channel.plugin && channel.service
    ? channelConfigurationApi({
      token: input.token,
      profileId: input.profileId,
      generation: input.generation,
      configPath: input.configPath,
      plugin: channel.plugin,
      service: channel.service,
    })
    : undefined
  const credentials = channel.credentialBridgeToken !== undefined && configApi
    ? createChannelCredentialBridgeHandler({
      token: channel.credentialBridgeToken,
      profileId: input.profileId,
      store: new LauncherSecretStore({ homeDir: path.dirname(input.configPath) }),
      service: configApi,
      projection: channel.loadManagerProjection,
    })
    : undefined
  const actions = channel.actionsBridgeToken !== undefined
    ? createChannelActionsBridgeHandler({
      token: channel.actionsBridgeToken,
      conversations: new ChannelConversationManagement(() => channel.service?.conversationAccess(), input.consumer),
      api: channel.service
        ? configuredChannelManager({
          service: channel.service,
          ...(channel.plugin && input.token
            ? {
              configuration: (expectedServiceGeneration: string) =>
                channelConfigurationApi({
                  token: input.token!,
                  profileId: input.profileId,
                  generation: input.generation,
                  configPath: input.configPath,
                  plugin: channel.plugin!,
                  service: channel.service!,
                  expectedServiceGeneration,
                }),
            }
            : {}),
        })
        : unavailableChannelManager(),
      ...(input.consumer === undefined ? {} : { consumer: input.consumer }),
      ...(input.execution === undefined ? {} : { execution: input.execution }),
    })
    : undefined
  return { configApi, credentials, actions }
}

/** Host settings remain available without inventing a Channel transport or connection. */
function unavailableChannelManager(): ChannelManagerApi {
  const unavailable = async () => ({ status: 'unavailable' as const, code: 'CHANNEL_NOT_CONFIGURED' })
  return {
    snapshot: () => undefined,
    logs: () => ({ records: [], total: 0, offset: 0, limit: 0, hasMore: false }),
    exportLogs: () => ({ filename: 'channel-logs.json', payload: '[]' }),
    connections: { enable: unavailable, disable: unavailable, reconnect: unavailable },
    bindings: { archive: unavailable, restore: unavailable, unbind: unavailable },
  }
}
