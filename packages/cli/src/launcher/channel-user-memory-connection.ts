import type { HomeConfig } from '../config/home-config.js'
import type { ChannelMemoryModelConnection } from './channel-user-memory-model.js'
import { modelsForApp, servicesForApp } from './model-service-projection.js'
import type { NativeManagedGatewayConnection } from './managed-service-native-connection.js'

/** The provider is supported, but its managed connection could not be prepared. */
export class ChannelManagedConnectionUnavailable extends Error {
  constructor() {
    super('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
  }
}

/** Use enabled shared model services and their existing Host-private credential environment. */
export function channelMemoryServiceConnection(
  config: Pick<HomeConfig, 'providers' | 'environmentVariables'>,
  environment: NodeJS.ProcessEnv,
): ChannelMemoryModelConnection {
  return async (providerId, model, signal) => {
    signal.throwIfAborted()
    const service = servicesForApp(config.providers, 'codex').find(service =>
      service.id === providerId
      && modelsForApp(service, 'codex').includes(model)
    )
    if (!service) throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
    const variable = (name: string) => {
      const saved = config.environmentVariables.find(item => item.name === name)
      return saved ? saved.enabled ? saved.value : undefined : environment[name]
    }
    const key = variable(service.apiKeyEnv)
    if (!key?.trim()) throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      ...service.runtimeOptions?.codex?.http_headers,
    }
    for (const [name, reference] of Object.entries(service.runtimeOptions?.codex?.env_http_headers ?? {})) {
      const value = variable(reference)
      if (!value?.trim()) throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
      headers[name] = value
    }
    return {
      baseUrl: service.baseUrl,
      headers,
      protocols: service.protocols,
      ...(service.responseModelAliases?.[model] ? { responseModelAliases: service.responseModelAliases[model] } : {}),
      dispose() {},
    }
  }
}

export function channelMemoryRuntimeConnection(input: {
  active(): boolean
  managed(providerId: string): boolean
  prepare(
    providerId: string,
  ):
    | { value: NativeManagedGatewayConnection; dispose(): void }
    | Promise<{ value: NativeManagedGatewayConnection; dispose(): void }>
  config(): Promise<Pick<HomeConfig, 'providers' | 'environmentVariables'>>
  environment: NodeJS.ProcessEnv
}): ChannelMemoryModelConnection {
  return async (providerId, model, signal) => {
    signal.throwIfAborted()
    if (!input.active()) throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
    if (!input.managed(providerId)) {
      return channelMemoryServiceConnection(await input.config(), input.environment)(providerId, model, signal)
    }
    const lease = await Promise.resolve().then(() => input.prepare(providerId)).catch(() => {
      throw new ChannelManagedConnectionUnavailable()
    })
    if (!input.active() || signal.aborted || !lease.value.models.aliases.some(item => item.gatewayModelId === model)) {
      lease.dispose()
      throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
    }
    const endpoint = lease.value.endpoint
    return {
      baseUrl: `${endpoint.origin}${endpoint.apiPath}`,
      headers: endpoint.auth.scheme === 'bearer' ? { authorization: `Bearer ${endpoint.auth.token}` } : {},
      dispose: () => lease.dispose(),
    }
  }
}
