import type { ProviderFleet } from '../providers/fleet.js'
import {
  type HostSecretState,
  HostServiceConfigNarrowApi,
  type HostServiceConfigPersistence,
} from '../launcher/service-config.js'
import type { PlatformProviderServiceReconfigureRuntime } from '../launcher/platform-provider-service-batch.js'
import { readServiceConfigState } from '../config/service-config.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
  parseCliProxyProviderStartupConfig,
  resolveCliProxyProviderConfigs,
} from '../providers/cli-proxy-service-config.js'

export function cliProxyServiceConfigApis(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly rootDir: string
  readonly environment: NodeJS.ProcessEnv
  readonly fleet: ProviderFleet
  readonly platformProviderServices?: PlatformProviderServiceReconfigureRuntime
  readonly persistence?: HostServiceConfigPersistence
}): readonly { readonly pluginId: string; readonly serviceId: string; readonly api: HostServiceConfigNarrowApi }[] {
  const secretState = (reference: string | undefined): HostSecretState => {
    if (reference === undefined || reference === '') return 'missing'
    const environmentName = /^host-secret:env\/([A-Z_][A-Z0-9_]*)$/u.exec(reference)?.[1]
    if (environmentName !== undefined) return input.environment[environmentName] === undefined ? 'missing' : 'ready'
    return 'unavailable'
  }
  const startup = new HostServiceConfigNarrowApi({
    contract: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
    profileId: input.profileId,
    generation: input.generation,
    ownerToken: input.token,
    configPath: input.configPath,
    writable: true,
    authorize: () => true,
    secretState,
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
  })
  const runtime = new HostServiceConfigNarrowApi({
    contract: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
    profileId: input.profileId,
    generation: input.generation,
    ownerToken: input.token,
    configPath: input.configPath,
    writable: true,
    authorize: () => true,
    secretState,
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    restartService: async candidate => {
      const startupState = await (input.persistence?.read ?? readServiceConfigState)({
        profileId: input.profileId,
        pluginId: 'cli-proxy-api',
        serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as Parameters<
          typeof readServiceConfigState
        >[0]['initialConfig'],
      }, input.configPath)
      const providers = resolveCliProxyProviderConfigs(
        CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT.parseStored(
          candidate,
        ) as unknown as typeof CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
        parseCliProxyProviderStartupConfig(startupState.config as unknown),
        { rootDir: input.rootDir },
      )
      return await (input.platformProviderServices?.reconfigure(input.fleet, providers, {
        pluginId: 'cli-proxy-api',
        serviceId: CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
        rawConfiguration: candidate,
      })
        ?? input.fleet.reconfigure(providers))
    },
  })
  return [
    { pluginId: 'cli-proxy-api', serviceId: CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID, api: runtime },
    { pluginId: 'cli-proxy-api', serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID, api: startup },
  ]
}
