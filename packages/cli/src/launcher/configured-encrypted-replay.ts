import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { HomeConfigProvider } from '../config/home-config.js'
import { modelServiceRuntimeOwnership } from './model-service-codex-options-projection.js'
import { servicesForApp } from './model-service-projection.js'
import type { ResponsesReplayRouteOptions } from './responses-encrypted-replay.js'
import {
  CODEX_RUNTIME_OPTION_KEYS,
  MODEL_SERVICE_OPTIONS_AUTHORITY,
  modelServiceCodexProvider,
} from './model-service-runtime.js'

export function configuredEncryptedReplay(
  codexHome: string,
  route: (url: string, options?: ResponsesReplayRouteOptions) => string,
  declarations: readonly HomeConfigProvider[] = [],
) {
  const applicable = servicesForApp(declarations, 'codex')
  return async (providerId?: string): Promise<Readonly<Record<string, unknown>>> => {
    const filename = path.join(codexHome, 'config.toml')
    let raw = ''
    try {
      if ((await stat(filename)).size > 4 * 1024 * 1024) throw new Error('Provider configuration unavailable')
      raw = await readFile(filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const config = parse(raw)
    const selected = providerId ?? config.model_provider
    if (typeof selected !== 'string' || selected === 'openai') return {}
    const declared = applicable.find(item => item.id === selected)
    const ownership = modelServiceRuntimeOwnership(raw).get(selected)
    const authoritative = declared?.runtimeOptions !== undefined || ownership !== undefined
    const providers = config.model_providers
    const provider =
      providers && typeof providers === 'object' && !Array.isArray(providers) && Object.hasOwn(providers, selected)
        ? (providers as Record<string, unknown>)[selected]
        : undefined
    const native = provider && typeof provider === 'object' && !Array.isArray(provider)
      ? provider as Record<string, unknown>
      : undefined
    const mapped = declared?.runtimeOptions === undefined ? undefined : modelServiceCodexProvider(declared)
    const projected: Record<string, unknown> = { ...native }
    // A cleared provider uses its current native file, so an intentional later
    // native edit survives. The caller's old options cannot override that file.
    if (mapped !== undefined || ownership === 'source') {
      for (const key of CODEX_RUNTIME_OPTION_KEYS) delete projected[key]
      Object.assign(projected, mapped)
    }
    const authority = authoritative ? { [MODEL_SERVICE_OPTIONS_AUTHORITY]: [selected] } : {}
    if (projected.wire_api !== undefined && projected.wire_api !== 'responses') return authority
    if (typeof projected.base_url !== 'string') return authority
    const websocket = projected.supports_websockets === true
    const nativeStreamIdlePolicy = typeof projected.stream_idle_timeout_ms === 'number'
    const baseUrl = websocket || nativeStreamIdlePolicy
      ? route(projected.base_url, { websocket, nativeStreamIdlePolicy })
      : route(projected.base_url)
    return {
      ...authority,
      [`model_providers.${selected}`]: {
        ...projected,
        wire_api: 'responses',
        base_url: baseUrl,
      },
    }
  }
}
