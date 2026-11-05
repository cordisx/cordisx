const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined

export const optionsAuthority = 'cordisx.model_service_options'
const runtimeOptionKeys = [
  'http_headers',
  'env_http_headers',
  'supports_websockets',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
]
export function configuredOverrides(existing, overrides) {
  const merged = { ...existing, ...overrides }
  const authority = new Set(Array.isArray(overrides[optionsAuthority]) ? overrides[optionsAuthority] : [])
  delete merged[optionsAuthority]
  const names = new Set([
    ...Object.keys(overrides).filter(name => name.startsWith('model_providers.') && object(overrides[name])),
    ...Array.from(authority, id => `model_providers.${id}`),
  ])
  for (const name of names) {
    const id = name.slice('model_providers.'.length)
    const definition = object(overrides[name])
    const nested = object(object(existing?.model_providers)?.[id])
    const provider = { ...definition, ...nested, ...object(existing?.[name]) }
    if (definition) {
      provider.base_url = definition.base_url
      provider.wire_api = definition.wire_api
      if (Object.hasOwn(merged, `${name}.base_url`)) merged[`${name}.base_url`] = definition.base_url
    }
    if (authority.has(id)) {
      for (const key of runtimeOptionKeys) {
        delete provider[key]
        if (definition && Object.hasOwn(definition, key)) provider[key] = definition[key]
        for (const candidate of Object.keys(merged)) {
          if (candidate === `${name}.${key}` || candidate.startsWith(`${name}.${key}.`)) delete merged[candidate]
        }
      }
      if (nested) {
        merged.model_providers = { ...merged.model_providers }
        delete merged.model_providers[id]
        if (Object.keys(merged.model_providers).length === 0) delete merged.model_providers
      }
    }
    if (Object.keys(provider).length > 0) merged[name] = provider
    else delete merged[name]
  }
  return merged
}
