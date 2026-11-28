import { markServiceConfigAppRestartApplied, readServiceConfigState } from '../config/service-config.js'
import {
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
} from '../providers/cli-proxy-service-config.js'
import type { PackagePluginServiceConfigStore } from '../launcher/package-plugin-service-config.js'

export function createCliProxyStartupMarker(input: {
  readonly configured: boolean
  readonly configPath: string
  readonly profileId: string
  readonly persistence?: PackagePluginServiceConfigStore['persistence']
  readonly stdout: (line: string) => void
}): () => Promise<void> {
  return async () => {
    if (!input.configured) return
    try {
      const read = input.persistence?.read ?? readServiceConfigState
      const state = await read({
        profileId: input.profileId,
        pluginId: 'cli-proxy-api',
        serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as Parameters<
          typeof readServiceConfigState
        >[0]['initialConfig'],
      }, input.configPath)
      if (state.restartRequired !== true) return
      const markApplied = input.persistence?.markAppRestartApplied ?? markServiceConfigAppRestartApplied
      await markApplied({
        profileId: input.profileId,
        pluginId: 'cli-proxy-api',
        serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
        expectedRevision: state.revision,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as Parameters<
          typeof markServiceConfigAppRestartApplied
        >[0]['initialConfig'],
      }, input.configPath)
    } catch (error) {
      input.stdout(`[cordisx] failed to mark CLIProxy startup configuration applied: ${String(error)}`)
    }
  }
}
