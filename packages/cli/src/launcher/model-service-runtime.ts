import { createHash } from 'node:crypto'
import type { HomeConfigModelServiceProvider, HomeConfigProvider } from '../config/home-config.js'
import { CODEX_RUNTIME_OPTION_KEYS, MODEL_SERVICE_HEADER_ENV_PREFIX } from '../config/model-service-runtime-options.js'

export { CODEX_RUNTIME_OPTION_KEYS }
export const MODEL_SERVICE_OPTIONS_AUTHORITY = 'cordisx.model_service_options'

/** Nonempty fixed values stay in the environment; their references are deterministic and opaque. */
export function modelServiceHeaderEnvironmentName(providerId: string, header: string): string {
  const digest = createHash('sha256').update(JSON.stringify([providerId, header.toLowerCase()])).digest('hex')
    .toUpperCase()
  return `${MODEL_SERVICE_HEADER_ENV_PREFIX}${digest}`
}

/** One normalized provider mapper for native TOML, admitted request tables and terminal Codex. */
export function modelServiceCodexProvider(provider: HomeConfigModelServiceProvider) {
  const options = provider.runtimeOptions?.codex
  const envHeaders: Record<string, string> = Object.assign(Object.create(null), options?.env_http_headers)
  const emptyHeaders: Array<readonly [string, '']> = []
  for (const [name, value] of Object.entries(options?.http_headers ?? {})) {
    // Codex discards blank environment values. A literal empty string carries
    // no secret and preserves the distinction between an empty and absent header.
    if (value === '') emptyHeaders.push([name, ''])
    else envHeaders[name] = modelServiceHeaderEnvironmentName(provider.id, name)
  }
  const runtime = { ...options }
  delete runtime.http_headers
  delete runtime.env_http_headers
  return Object.freeze({
    name: provider.displayName,
    base_url: provider.baseUrl,
    wire_api: 'responses' as const,
    env_key: provider.apiKeyEnv,
    requires_openai_auth: false,
    ...runtime,
    ...(emptyHeaders.length === 0 ? {} : { http_headers: Object.freeze(Object.fromEntries(emptyHeaders)) }),
    ...(Object.keys(envHeaders).length === 0
      ? {}
      : { env_http_headers: Object.freeze(Object.fromEntries(Object.entries(envHeaders))) }),
  })
}

export function modelServiceRuntimeEnvironment(
  providers: readonly HomeConfigProvider[],
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const result = { ...environment }
  for (const provider of providers) {
    if (
      provider.kind !== 'model-service' || provider.enabled === false
      || !provider.protocols.includes('openai-responses') || provider.appliesTo && !provider.appliesTo.includes('codex')
    ) continue
    for (const [header, value] of Object.entries(provider.runtimeOptions?.codex?.http_headers ?? {})) {
      if (value === '') continue
      const name = modelServiceHeaderEnvironmentName(provider.id, header)
      if (Object.hasOwn(result, name)) {
        throw new Error('Model service header environment conflicts with an existing entry')
      }
      result[name] = value
    }
  }
  return Object.freeze(result)
}
