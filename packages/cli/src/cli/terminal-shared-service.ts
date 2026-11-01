import type { HomeConfig } from '../config/home-config.js'
import { mergeHomeEnvironment } from '../config/home-config-environment.js'
import { modelsForApp, servicesForApp } from '../launcher/model-service-projection.js'

export function sharedTerminalServices(config: HomeConfig, client: 'codex' | 'claude-code') {
  const app = client === 'codex' ? 'codex' : 'claude'
  return servicesForApp(config.providers, app).map(service => ({
    providerId: service.id,
    title: service.displayName,
    managed: false,
    source: 'model-service' as const,
    models: modelsForApp(service, app).map(id => ({ id, label: id })),
  }))
}

/** Reuses declarations without persisting an app's default or any provider table. */
export function prepareSharedTerminalService(
  config: HomeConfig,
  client: 'codex' | 'claude-code',
  id: string,
  model: string,
  base: NodeJS.ProcessEnv,
) {
  const app = client === 'codex' ? 'codex' : 'claude'
  const declared = config.providers.find(provider => provider.id === id && provider.kind === 'model-service')
  if (!declared) return undefined
  const service = servicesForApp(config.providers, app).find(provider => provider.id === id)
  if (!service) {
    throw new Error(
      `Service ${id} is disabled or does not support ${client === 'codex' ? 'openai-responses' : 'anthropic-messages'}`,
    )
  }
  if (!modelsForApp(service, app).includes(model)) {
    throw new Error('Model is not in the selected service catalog; use --list')
  }
  const merged = mergeHomeEnvironment(base, config.environmentVariables)
  const key = merged[service.apiKeyEnv]
  if (!key) throw new Error(`Service ${id} requires configured environment variable ${service.apiKeyEnv}`)
  const environment = { ...base, [service.apiKeyEnv]: key }
  if (client === 'claude-code') {
    environment.ANTHROPIC_BASE_URL = service.baseUrl
    environment.ANTHROPIC_AUTH_TOKEN = key
    delete environment.ANTHROPIC_API_KEY
  }
  return {
    environment,
    providerId: id,
    model,
    provider: {
      name: service.displayName,
      base_url: service.baseUrl,
      wire_api: 'responses',
      env_key: service.apiKeyEnv,
      requires_openai_auth: false,
    },
  }
}
