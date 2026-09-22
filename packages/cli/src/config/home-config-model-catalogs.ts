import {
  MODEL_BRAND_KEYS,
  type ModelBrandChoice,
  type ModelSelectorIconOverrides,
  PROVIDER_BRAND_KEYS,
  type ProviderBrandChoice,
} from '../model-selector-branding.js'

const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u
const MODEL_ID = /^[^\0\r\n]{1,512}$/u

/** Host-only model membership; never an endpoint, authentication or native-profile override. */
export function parseDefaultModelProvider(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label}.defaultModelProvider is invalid`)
  }
  return value.trim()
}

export function parseConfigModelCatalogs(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('configModelCatalogs must be a provider-to-local-path object')
  }
  const entries = Object.entries(value)
  if (entries.length > 128) throw new Error('configModelCatalogs has too many providers')
  const result: Record<string, string> = Object.create(null)
  for (const [id, file] of entries) {
    if (!PROVIDER_ID.test(id) || id === 'openai') {
      throw new Error('configModelCatalogs has an invalid or reserved provider ID')
    }
    if (
      typeof file !== 'string' || !file.trim() || file.length > 4096 || /[\0\r\n]/u.test(file)
      || /^[a-z][a-z0-9+.-]*:\/\//iu.test(file)
    ) {
      throw new Error('configModelCatalogs requires bounded local file paths')
    }
    result[id] = file
  }
  return Object.freeze(result)
}

function brandChoice<T extends string>(value: unknown, keys: readonly T[], label: string): T | 'generic' {
  if (typeof value !== 'string' || (value !== 'generic' && !keys.includes(value as T))) {
    throw new Error(`${label} has an unsupported brand key`)
  }
  return value as T | 'generic'
}

export function parseModelSelectorIcons(value: unknown): ModelSelectorIconOverrides | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('selectorIcons must be an object')
  }
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => key !== 'providers' && key !== 'models')) {
    throw new Error('selectorIcons has an unsupported field')
  }
  const providerSource = source.providers ?? {}
  const modelSource = source.models ?? {}
  if (
    providerSource === null || typeof providerSource !== 'object' || Array.isArray(providerSource)
    || modelSource === null || typeof modelSource !== 'object' || Array.isArray(modelSource)
  ) throw new Error('selectorIcons providers and models must be objects')
  if (Object.keys(providerSource).length > 128 || Object.keys(modelSource).length > 128) {
    throw new Error('selectorIcons has too many providers')
  }
  const providers: Record<string, ProviderBrandChoice> = Object.create(null)
  for (const [providerId, choice] of Object.entries(providerSource as Record<string, unknown>)) {
    if (!PROVIDER_ID.test(providerId) || providerId === 'openai') {
      throw new Error('selectorIcons providers has an invalid or reserved provider ID')
    }
    providers[providerId] = brandChoice(choice, PROVIDER_BRAND_KEYS, `selectorIcons.providers.${providerId}`)
  }
  const models: Record<string, Readonly<Record<string, ModelBrandChoice>>> = Object.create(null)
  for (const [providerId, entries] of Object.entries(modelSource as Record<string, unknown>)) {
    if (!PROVIDER_ID.test(providerId) || providerId === 'openai') {
      throw new Error('selectorIcons models has an invalid or reserved provider ID')
    }
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error(`selectorIcons.models.${providerId} must be an object`)
    }
    const pairs = Object.entries(entries as Record<string, unknown>)
    if (pairs.length > 512) throw new Error(`selectorIcons.models.${providerId} has too many models`)
    const exact: Record<string, ModelBrandChoice> = Object.create(null)
    for (const [modelId, choice] of pairs) {
      if (!MODEL_ID.test(modelId)) throw new Error(`selectorIcons.models.${providerId} has an invalid model ID`)
      exact[modelId] = brandChoice(choice, MODEL_BRAND_KEYS, `selectorIcons.models.${providerId}.${modelId}`)
    }
    models[providerId] = Object.freeze(exact)
  }
  return Object.freeze({ providers: Object.freeze(providers), models: Object.freeze(models) })
}

export function parseProfileModelOptions(profile: Record<string, unknown>, label: string) {
  const defaultModelProvider = parseDefaultModelProvider(profile.defaultModelProvider, label)
  const configModelCatalogs = parseConfigModelCatalogs(profile.configModelCatalogs)
  const selectorIcons = parseModelSelectorIcons(profile.selectorIcons)
  return {
    ...(defaultModelProvider === undefined ? {} : { defaultModelProvider }),
    ...(configModelCatalogs === undefined ? {} : { configModelCatalogs }),
    ...(selectorIcons === undefined ? {} : { selectorIcons }),
  }
}
