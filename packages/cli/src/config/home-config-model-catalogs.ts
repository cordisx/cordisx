import {
  MODEL_BRAND_KEYS,
  type ModelBrandChoice,
  type ModelSelectorIconOverrides,
  PROVIDER_BRAND_KEYS,
  type ProviderBrandChoice,
} from '../model-selector-branding.js'

const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u
const MODEL_ID = /^[^\0\r\n]{1,512}$/u

export const PROFILE_MODEL_OPTION_KEYS = [
  'defaultModelProvider',
  'configModelCatalogs',
  'dynamicModelCatalog',
  'selectorIcons',
  'providerBindings',
] as const

const SYNC_CONNECTION_ID = /^cx-connection-[A-Za-z0-9_-]{16,96}$/u
const SYNC_BINDING_ID = /^cx-binding-[A-Za-z0-9_-]{16,96}$/u

export interface HomeConfigProviderBinding {
  readonly bindingId: string
  readonly connectionId: string
  readonly localProviderId: string
  readonly enabled: boolean
  readonly credentialDelivery: 'process-env'
  readonly overlay?: {
    readonly title?: string
    readonly iconRef?: string
  }
}

export function parseProviderBindings(value: unknown): readonly HomeConfigProviderBinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) throw new Error('providerBindings must be a bounded array')
  const bindingIds = new Set<string>()
  const localProviderIds = new Set<string>()
  return Object.freeze(value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`providerBindings[${index}] must be an object`)
    }
    const source = item as Record<string, unknown>
    if (
      Object.keys(source).some(key =>
        !['bindingId', 'connectionId', 'localProviderId', 'enabled', 'credentialDelivery', 'overlay'].includes(key)
      )
      || typeof source.bindingId !== 'string' || !SYNC_BINDING_ID.test(source.bindingId)
      || typeof source.connectionId !== 'string' || !SYNC_CONNECTION_ID.test(source.connectionId)
      || typeof source.localProviderId !== 'string' || !PROVIDER_ID.test(source.localProviderId)
      || source.localProviderId === 'openai' || typeof source.enabled !== 'boolean'
      || source.credentialDelivery !== 'process-env'
    ) throw new Error(`providerBindings[${index}] is invalid`)
    if (bindingIds.has(source.bindingId) || localProviderIds.has(source.localProviderId)) {
      throw new Error('providerBindings contains duplicate identity or target ownership')
    }
    bindingIds.add(source.bindingId)
    localProviderIds.add(source.localProviderId)
    let overlay: HomeConfigProviderBinding['overlay']
    if (source.overlay !== undefined) {
      if (source.overlay === null || typeof source.overlay !== 'object' || Array.isArray(source.overlay)) {
        throw new Error(`providerBindings[${index}].overlay is invalid`)
      }
      const candidate = source.overlay as Record<string, unknown>
      if (
        Object.keys(candidate).some(key => key !== 'title' && key !== 'iconRef')
        || candidate.title !== undefined
          && (typeof candidate.title !== 'string' || !candidate.title.trim() || candidate.title.length > 256)
        || candidate.iconRef !== undefined
          && (typeof candidate.iconRef !== 'string' || !candidate.iconRef.trim() || candidate.iconRef.length > 256)
      ) throw new Error(`providerBindings[${index}].overlay is invalid`)
      overlay = Object.freeze({
        ...(candidate.title === undefined ? {} : { title: candidate.title as string }),
        ...(candidate.iconRef === undefined ? {} : { iconRef: candidate.iconRef as string }),
      })
    }
    return Object.freeze({
      bindingId: source.bindingId,
      connectionId: source.connectionId,
      localProviderId: source.localProviderId,
      enabled: source.enabled,
      credentialDelivery: 'process-env' as const,
      ...(overlay === undefined ? {} : { overlay }),
    })
  }))
}

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
  if (profile.dynamicModelCatalog !== undefined && typeof profile.dynamicModelCatalog !== 'boolean') {
    throw new Error(`${label}.dynamicModelCatalog must be a boolean`)
  }
  const defaultModelProvider = parseDefaultModelProvider(profile.defaultModelProvider, label)
  const configModelCatalogs = parseConfigModelCatalogs(profile.configModelCatalogs)
  const selectorIcons = parseModelSelectorIcons(profile.selectorIcons)
  const providerBindings = parseProviderBindings(profile.providerBindings)
  return {
    ...(profile.dynamicModelCatalog === undefined ? {} : { dynamicModelCatalog: profile.dynamicModelCatalog }),
    ...(defaultModelProvider === undefined ? {} : { defaultModelProvider }),
    ...(configModelCatalogs === undefined ? {} : { configModelCatalogs }),
    ...(selectorIcons === undefined ? {} : { selectorIcons }),
    ...(providerBindings === undefined ? {} : { providerBindings }),
  }
}
