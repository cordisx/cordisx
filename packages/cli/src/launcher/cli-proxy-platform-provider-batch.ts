import { readServiceConfigState } from '../config/service-config.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
  parseCliProxyProviderRuntimeConfig,
  parseCliProxyProviderStartupConfig,
  resolveCliProxyProviderConfigs,
} from '../plugins/cli-proxy-api/service-config.js'
import { CodexAppServerPlatformBrokerAuthority } from '../providers/codex-app-server-platform-broker.js'
import { startCodexAppServer } from '../providers/codex-app-server.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { loadStagedPluginPackage } from './plugin-package.js'
import { platformProviderRuntimeServiceAccess } from './packages/platform-provider-service-access.js'
import { HostPlatformProviderConfigurationRegistryV1 } from './platform-provider-authority.js'
import { PlatformProviderServiceBatchRuntime } from './platform-provider-service-batch.js'

export function createCliProxyPlatformProviderBatch(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly hostGeneration: string
  readonly configPath: string
  readonly rootDir: string
  readonly environment: NodeJS.ProcessEnv
  readonly activation: () => Promise<CordisXPluginActivationRecordV1>
}): PlatformProviderServiceBatchRuntime {
  const configurations = new HostPlatformProviderConfigurationRegistryV1()
  configurations.register({
    protocolVersion: 2,
    schema: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1,
    applicationMode: 'service-restart',
    project: value =>
      parseCliProxyProviderRuntimeConfig(value).providers.map((provider, index) => ({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v2',
        schemaVersion: 2,
        configurationRevision: index + 1,
        providerId: provider.id,
        displayName: provider.displayName,
        enabled: provider.enabled,
        requestTimeoutMs: provider.timeoutMs,
        mapping: { models: provider.models.mappings },
      })),
  })
  const brokers = new CodexAppServerPlatformBrokerAuthority({
    serviceSchemas: [CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1],
    open: async authority => {
      const startup = await readServiceConfigState({
        profileId: input.profileId,
        pluginId: authority.owner.pluginId,
        serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as never,
      }, input.configPath)
      const providers = resolveCliProxyProviderConfigs(
        parseCliProxyProviderRuntimeConfig(authority.rawConfiguration),
        parseCliProxyProviderStartupConfig(startup.config),
        { rootDir: input.rootDir },
      )
      const provider = providers.find(item => item.id === authority.configuration.providerId)
      if (provider === undefined) throw new Error(`Provider ${authority.configuration.providerId} is unavailable`)
      return await startCodexAppServer(provider, { environment: input.environment })
    },
  })
  return new PlatformProviderServiceBatchRuntime({
    configurations,
    brokers,
    candidates: async selectedActivation => {
      const activation = selectedActivation ?? await input.activation()
      const candidates = []
      for (const item of activation.plugins) {
        if (!item.enabled) continue
        const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
        for (const service of staged.serviceModules) {
          if (
            service.declaration.kind !== 'platform-provider'
            || service.declaration.schema !== CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1
          ) continue
          const state = await readServiceConfigState({
            profileId: input.profileId,
            pluginId: item.id,
            serviceId: service.declaration.id,
            initialConfig: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL as never,
          }, input.configPath)
          candidates.push({
            access: await platformProviderRuntimeServiceAccess(
              input.homeDir,
              item,
              service.declaration.id,
              input.hostGeneration,
            ),
            rawConfiguration: state.config,
          })
        }
      }
      return candidates
    },
  })
}
