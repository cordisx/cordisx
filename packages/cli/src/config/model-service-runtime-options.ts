import type {
  ModelServiceCodexOptions,
  ModelServiceRuntimeOptions,
  ModelServiceView,
} from '../model-service-contracts.js'

export const CODEX_RUNTIME_OPTION_KEYS = [
  'http_headers',
  'env_http_headers',
  'supports_websockets',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
] as const
export const MODEL_SERVICE_HEADER_ENV_PREFIX = 'CORDISX_MODEL_SERVICE_HEADER_'
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const unknownKeys = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains an invalid field`)
}

/** Does not echo header names or values, including rejected input, into errors. */
export function parseModelServiceHeaders(value: unknown, label: string, patch = false, environment = false) {
  const source = object(value, label)
  if (Object.keys(source).length > 64) throw new Error(`${label} must contain at most 64 headers`)
  const seen = new Set<string>()
  const result: Record<string, string | null> = Object.create(null)
  for (const [name, entry] of Object.entries(source)) {
    if (name.length > 256 || !HEADER_NAME.test(name) || seen.has(name.toLowerCase())) {
      throw new Error(`${label} contains an invalid or duplicate header name`)
    }
    seen.add(name.toLowerCase())
    if (patch && entry === null) result[name] = null
    else if (
      typeof entry !== 'string' || entry.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(entry)
      || environment && (!ENV_NAME.test(entry) || entry.startsWith(MODEL_SERVICE_HEADER_ENV_PREFIX))
    ) throw new Error(`${label} contains an invalid header value`)
    else result[name] = entry
  }
  return Object.freeze(result)
}

export function parseModelServiceRuntimeOptions(value: unknown, label = 'runtimeOptions'): ModelServiceRuntimeOptions {
  const source = object(value, label)
  unknownKeys(source, ['codex'], label)
  if (source.codex === undefined) return Object.freeze({})
  const codex = object(source.codex, `${label}.codex`)
  unknownKeys(codex, CODEX_RUNTIME_OPTION_KEYS, `${label}.codex`)
  const result: Record<string, unknown> = Object.create(null)
  for (const key of ['http_headers', 'env_http_headers'] as const) {
    if (codex[key] !== undefined) {
      result[key] = parseModelServiceHeaders(codex[key], `${label}.codex.${key}`, false, key === 'env_http_headers')
    }
  }
  if (codex.supports_websockets !== undefined) {
    if (typeof codex.supports_websockets !== 'boolean') {
      throw new Error(`${label}.codex.supports_websockets must be boolean`)
    }
    result.supports_websockets = codex.supports_websockets
  }
  for (const key of ['request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'] as const) {
    const entry = codex[key]
    if (entry === undefined) continue
    const maximum = key === 'stream_idle_timeout_ms' ? Number.MAX_SAFE_INTEGER : 4_294_967_295
    if (!Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) > maximum) {
      throw new Error(`${label}.codex.${key} must be an integer between 0 and ${maximum}`)
    }
    result[key] = entry
  }
  const fixed = result.http_headers as Record<string, string> | undefined
  const env = result.env_http_headers as Record<string, string> | undefined
  if (fixed && env) {
    const names = new Set(Object.keys(fixed).map(name => name.toLowerCase()))
    if (Object.keys(env).some(name => names.has(name.toLowerCase()))) {
      throw new Error(`${label}.codex contains a duplicate header name`)
    }
  }
  return Object.freeze({ codex: Object.freeze(result) as ModelServiceCodexOptions })
}

/** Fixed header names may be displayed, but values never leave private configuration reads. */
export function modelServiceRuntimeOptionsView(
  runtimeOptions: ModelServiceRuntimeOptions | null | undefined,
): Pick<ModelServiceView, 'runtimeOptions' | 'httpHeaderNames'> {
  if (runtimeOptions == null) return {}
  const { http_headers: fixed, ...codex } = runtimeOptions.codex ?? {}
  return { runtimeOptions: { codex }, ...(fixed === undefined ? {} : { httpHeaderNames: Object.keys(fixed) }) }
}
