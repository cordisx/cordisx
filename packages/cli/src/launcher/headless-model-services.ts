import type { HomeConfig } from '../config/home-config.js'
import { modelsForApp, servicesForApp } from './model-service-projection.js'

/** Only saved variables referenced by enabled Codex services enter the native process. */
export function prepareHeadlessModelServices(
  config: Pick<HomeConfig, 'providers' | 'environmentVariables'>,
  base: NodeJS.ProcessEnv,
) {
  const services = servicesForApp(config.providers, 'codex')
    .filter(service => modelsForApp(service, 'codex').length > 0)
  const names = new Set(services.flatMap(service => [
    service.apiKeyEnv,
    ...Object.values(service.runtimeOptions?.codex?.env_http_headers ?? {}),
  ]))
  const environment = { ...base }
  for (const entry of config.environmentVariables) {
    if (names.has(entry.name)) environment[entry.name] = entry.enabled ? entry.value : undefined
  }
  return {
    environment,
    services,
  }
}

/** Availability uses this launch's environment after Channel credentials have been removed. */
export function availableHeadlessModelServices(
  prepared: ReturnType<typeof prepareHeadlessModelServices>,
  environment: NodeJS.ProcessEnv,
  report: (code: string) => void,
) {
  return prepared.services.filter(service => {
    const required = [service.apiKeyEnv, ...Object.values(service.runtimeOptions?.codex?.env_http_headers ?? {})]
    if (required.every(name => environment[name]?.trim())) return true
    report('HEADLESS_MODEL_SERVICE_CREDENTIAL_UNAVAILABLE:' + service.id)
    return false
  })
}
