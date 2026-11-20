import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import { ManagerChannelCredentials } from '../launcher/manager-channel-credentials.js'
import { LauncherSecretStore } from '../launcher/secret-store.js'
import { ManagerChannelDraftJournal } from '../launcher/manager-channel-draft-journal.js'
import { configuredChannelManager } from '../launcher/channel-connection-configuration.js'
import { channelConfigurationApi } from './renderer-channel-composition.js'
import type { ManagerServiceAuthOperation } from '../launcher/manager-service-auth.js'
import type { ManagerChannelCredentialOperation } from '../launcher/manager-channel-credentials.js'

// Package-backed Channel and its credential recovery journal must use the same
// authoritative store before this bridge can be made available to real owners.
const PACKAGE_CHANNEL_STORAGE_RECONCILED: boolean = false

/** Only a running service with a verifiable active package may own credential writes. */
export function createManagerChannelCredentials(input: {
  readonly plugin?: CordisXConfigPlugin | undefined
  readonly service?: LocalChannelService | undefined
  readonly lifecycle: ManagedServicePluginLifecycleRuntime
  readonly configPath: string
  readonly profileId: string
  readonly generation: string
}): ManagerChannelCredentials | undefined {
  if (!PACKAGE_CHANNEL_STORAGE_RECONCILED) return undefined
  const { plugin, service } = input
  if (!plugin?.package || !service || plugin.id !== 'channel' || !plugin.enabled) return undefined
  const identity = {
    id: plugin.id,
    moduleGeneration: plugin.package.moduleGeneration,
    digest: plugin.package.digest,
    version: plugin.package.version,
    ...(plugin.package.canonicalSource === undefined ? {} : { canonicalSource: plugin.package.canonicalSource }),
  }
  const token = randomBytes(32).toString('hex')
  const homeDir = path.dirname(input.configPath)
  const store = new LauncherSecretStore({ homeDir })
  const openService = (serviceGeneration: string) =>
    channelConfigurationApi({
      token,
      profileId: input.profileId,
      generation: input.generation,
      configPath: input.configPath,
      plugin,
      service,
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
    withOwner: async action => await input.lifecycle.withActivePlugin(identity, action),
    openService,
    store,
    journal: new ManagerChannelDraftJournal({
      homeDir,
      configPath: input.configPath,
      profileId: input.profileId,
      store,
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
