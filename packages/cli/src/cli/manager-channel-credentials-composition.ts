import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import { ManagerChannelCredentials } from '../launcher/manager-channel-credentials.js'
import { LauncherSecretStore } from '../launcher/secret-store.js'
import { ManagerChannelDraftJournal } from '../launcher/manager-channel-draft-journal.js'
import { PackagePluginServiceConfigStore } from '../launcher/package-plugin-service-config.js'
import { configuredChannelManager } from '../launcher/channel-connection-configuration.js'
import { channelConfigurationApi } from './renderer-channel-composition.js'
import type { ManagerServiceAuthOperation } from '../launcher/manager-service-auth.js'
import type { ManagerChannelCredentialOperation } from '../launcher/manager-channel-credentials.js'
import { createConfiguredChannelOwner } from './configured-channel-owner.js'

/** Only a running service with a verifiable profile and plugin owner may handle credentials. */
export function createManagerChannelCredentials(input: {
  readonly plugin?: CordisXConfigPlugin | undefined
  readonly service?: LocalChannelService | undefined
  readonly lifecycle: ManagedServicePluginLifecycleRuntime
  readonly configPath: string
  readonly profileId: string
  readonly generation: string
  readonly ownerCurrent?: () => boolean
}, profileOwnerVerified = false): ManagerChannelCredentials | undefined {
  const { plugin, service } = input
  if (!profileOwnerVerified || !plugin || !service || plugin.id !== 'channel' || !plugin.enabled) {
    return undefined
  }
  const token = randomBytes(32).toString('hex')
  const homeDir = path.dirname(input.configPath)
  const configured = plugin.package || !input.ownerCurrent
    ? undefined
    : createConfiguredChannelOwner({
      homeDir,
      configPath: input.configPath,
      profileId: input.profileId,
      plugin,
      service,
      ownerCurrent: input.ownerCurrent,
    })
  if (!plugin.package && !configured) return undefined
  const identity = plugin.package === undefined ? undefined : {
    id: plugin.id,
    moduleGeneration: plugin.package.moduleGeneration,
    digest: plugin.package.digest,
    version: plugin.package.version,
    ...(plugin.package.canonicalSource === undefined ? {} : { canonicalSource: plugin.package.canonicalSource }),
  }
  const store = new LauncherSecretStore({ homeDir })
  const packageStore = new PackagePluginServiceConfigStore(homeDir, input.profileId, input.generation)
  const openService = (serviceGeneration: string) =>
    channelConfigurationApi({
      token,
      profileId: input.profileId,
      generation: input.generation,
      configPath: input.configPath,
      plugin,
      service,
      persistence: configured?.persistence ?? packageStore.persistence,
      expectedServiceGeneration: serviceGeneration,
    })
  const manager = configuredChannelManager({ service, configuration: openService })
  return new ManagerChannelCredentials({
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    generation: () => service.generation(),
    runtime: () => service.snapshot(),
    setEnabled: async ({ enabled, ...request }) =>
      await (enabled ? manager.connections.enable : manager.connections.disable)(request),
    withOwner: async action =>
      configured ? await configured.withOwner(action) : await input.lifecycle.withActivePlugin(identity!, action),
    openService,
    store,
    journal: new ManagerChannelDraftJournal({
      homeDir,
      configPath: input.configPath,
      profileId: input.profileId,
      store,
      packageStore,
      packageOwnerVerified: profileOwnerVerified,
    }),
  })
}

export function managerUserAuthorities(
  lifecycle: ManagedServicePluginLifecycleRuntime,
  channel: ManagerChannelCredentials | undefined,
) {
  return {
    managerServiceAuth: (operation: ManagerServiceAuthOperation) => lifecycle.managerAuth(operation),
    ...(channel === undefined ? {} : {
      managerChannelCredentials: (operation: ManagerChannelCredentialOperation) => channel.handle(operation),
    }),
  }
}
