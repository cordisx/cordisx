import type { HomeConfigModelServiceProvider } from '../config/home-config.js'
import { modelServiceHeaderEnvironmentName } from './model-service-runtime.js'

/** Keep only the selected static provider's credential references in a native worker. */
export function headlessManagedWorkerEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  services: readonly HomeConfigModelServiceProvider[],
  providerId: string,
  privateEnvironmentNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const names = (service: HomeConfigModelServiceProvider) => [
    service.apiKeyEnv,
    ...Object.values(service.runtimeOptions?.codex?.env_http_headers ?? {}),
    ...Object.entries(service.runtimeOptions?.codex?.http_headers ?? {})
      .filter(([, value]) => value !== '')
      .map(([header]) => modelServiceHeaderEnvironmentName(service.id, header)),
  ]
  const allowed = new Set(services.filter(service => service.id === providerId).flatMap(names))
  const result = { ...environment }
  for (const name of privateEnvironmentNames) if (!allowed.has(name)) delete result[name]
  for (const service of services) {
    for (const name of names(service)) if (!allowed.has(name)) delete result[name]
  }
  return result
}
