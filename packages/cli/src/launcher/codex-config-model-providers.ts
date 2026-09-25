import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { parseConfigModelCatalogs } from '../config/home-config-model-catalogs.js'
import { inferProviderBrand, type ModelSelectorIconOverrides } from '../model-selector-branding.js'
import type { NativeProviderWireApi } from '../renderer/native-provider-submission-policy.js'

const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const MAX_CATALOG_BYTES = 32 * 1024 * 1024
const CONFIG_PLUGIN_ID = 'cordisx.codex-config'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value)
    ? value
    : undefined

async function boundedText(file: string, maximum: number): Promise<string> {
  const metadata = await stat(file)
  if (!metadata.isFile() || metadata.size > maximum) throw new Error('Codex model configuration file is invalid')
  const value = await readFile(file, 'utf8')
  if (Buffer.byteLength(value) > maximum) throw new Error('Codex model configuration file is invalid')
  return value
}

function catalogModels(value: unknown, strict = false): NativeModelProviderCatalogEntry['models'] {
  const models = record(value)?.models
  if (!Array.isArray(models)) {
    if (strict) throw new Error('Invalid model catalog')
    return []
  }
  const seen = new Set<string>()
  return Object.freeze(models.flatMap(item => {
    const model = record(item)
    const id = text(model?.slug, 512)
    if (
      strict && (id === undefined
        || (model?.display_name !== undefined && text(model.display_name, 256) === undefined)
        || (model?.aliases !== undefined && (!Array.isArray(model.aliases)
          || model.aliases.some(alias => text(alias, 256) === undefined))))
    ) throw new Error('Invalid model catalog')
    if (id === undefined || seen.has(id)) return []
    seen.add(id)
    const label = text(model?.display_name, 256) ?? id
    const aliases = Array.isArray(model?.aliases)
      ? model.aliases.flatMap(alias => text(alias, 256) ?? []).filter(alias => alias !== id)
      : []
    return [Object.freeze({ id, label, aliases: Object.freeze([...new Set(aliases)]) })]
  }))
}

export interface CodexConfigModelProviderProjection {
  readonly providers: readonly NativeModelProviderCatalogEntry[]
  readonly providerIds: ReadonlySet<string>
  /** Host-private route protocol used for model compatibility admission. */
  readonly providerWireApis: ReadonlyMap<string, NativeProviderWireApi>
  /** Private source identity, not an effective native endpoint/account attestation. */
  readonly sourceRevision?: string
  readonly sourceAvailable?: boolean
  readonly diagnostics: readonly {
    readonly providerId: string
    readonly code: 'catalog-unavailable' | 'catalog-empty' | 'provider-missing'
  }[]
}

/** Host-private discovery input. Callers must not serialize or expose this value outside launcher Node. */
export interface CodexConfigNativeProvider {
  readonly providerId: string
  readonly title: string
  readonly endpoint?: string
  readonly wireApi?: 'responses' | 'chat-completions'
  readonly credential:
    | { readonly kind: 'environment'; readonly reference: string }
    | { readonly kind: 'inline-private'; readonly token: string }
    | { readonly kind: 'none' | 'unknown' }
}

/** Reads Codex configuration privately and returns only selector-safe provider/model metadata. */
export async function codexConfigModelProviders(
  codexHome: string,
  configModelCatalogs?: Readonly<Record<string, string>>,
  selectorIcons?: ModelSelectorIconOverrides,
  inspectNativeProviders?: (providers: readonly CodexConfigNativeProvider[]) => void,
): Promise<CodexConfigModelProviderProjection> {
  const mappings = parseConfigModelCatalogs(configModelCatalogs) ?? {}
  const diagnostics: Array<CodexConfigModelProviderProjection['diagnostics'][number]> = []
  let config: Record<string, unknown>
  let sourceRevision: string
  try {
    const raw = await boundedText(path.join(codexHome, 'config.toml'), MAX_CONFIG_BYTES)
    config = record(parse(raw)) ?? {}
    sourceRevision = createHash('sha256').update(raw).digest('hex')
  } catch {
    inspectNativeProviders?.(Object.freeze([]))
    return Object.freeze({
      providers: Object.freeze([]),
      sourceAvailable: false,
      providerIds: new Set<string>(),
      providerWireApis: new Map<string, NativeProviderWireApi>(),
      diagnostics: Object.freeze(
        Object.keys(mappings).map(providerId => ({ providerId, code: 'provider-missing' as const })),
      ),
    })
  }
  const configured = record(config.model_providers) ?? {}
  const providerWireApis = new Map<string, NativeProviderWireApi>()
  const activeProvider = text(config.model_provider, 128)
  const activeModel = text(config.model, 512)
  const nativeProviders = Object.freeze(
    Object.entries(configured).flatMap(([providerId, value]) => {
      const id = text(providerId, 128)
      const provider = record(value)
      if (id === undefined || id === 'openai' || provider === undefined) return []
      const endpoint = text(provider.base_url, 4_096)
      const wireApi = provider.wire_api === undefined
        ? 'responses'
        : provider.wire_api === 'responses' || provider.wire_api === 'chat-completions'
        ? provider.wire_api
        : undefined
      if (wireApi !== undefined) providerWireApis.set(id, wireApi)
      const envKey = text(provider.env_key, 512)
      const inlineToken = text(provider.experimental_bearer_token, 16_384)
      const credential: CodexConfigNativeProvider['credential'] = envKey !== undefined
        ? Object.freeze({ kind: 'environment', reference: envKey })
        : inlineToken !== undefined
        ? Object.freeze({ kind: 'inline-private', token: inlineToken })
        : provider.requires_openai_auth === false
        ? Object.freeze({ kind: 'none' })
        : Object.freeze({ kind: 'unknown' })
      return [Object.freeze({
        providerId: id,
        title: text(provider.name, 256) ?? id,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(wireApi === undefined ? {} : { wireApi }),
        credential,
      })]
    }),
  )
  inspectNativeProviders?.(nativeProviders)
  const readCatalog = async (
    value: unknown,
    providerId?: string,
  ): Promise<NativeModelProviderCatalogEntry['models']> => {
    const catalog = text(value, 4_096)
    if (catalog === undefined) return []
    try {
      const catalogPath = path.isAbsolute(catalog) ? catalog : path.resolve(codexHome, catalog)
      const models = catalogModels(
        JSON.parse(await boundedText(catalogPath, MAX_CATALOG_BYTES)),
        providerId !== undefined,
      )
      if (providerId !== undefined && models.length === 0) diagnostics.push({ providerId, code: 'catalog-empty' })
      return models
    } catch {
      if (providerId !== undefined) diagnostics.push({ providerId, code: 'catalog-unavailable' })
      return []
    }
  }
  const globalModels = await readCatalog(config.model_catalog_json)
  const boundModels = new Map<string, NativeModelProviderCatalogEntry['models']>()
  // A global catalog describes capabilities, not endpoint ownership. Never scan
  // unrelated native profiles or infer membership from a model/provider name.
  for (const [providerId, file] of Object.entries(mappings)) {
    if (record(configured[providerId]) === undefined) {
      diagnostics.push({ providerId, code: 'provider-missing' })
      continue
    }
    boundModels.set(providerId, await readCatalog(file, providerId))
  }
  if (activeProvider !== undefined && activeModel !== undefined && !Object.hasOwn(mappings, activeProvider)) {
    boundModels.set(activeProvider, [
      globalModels.find(model => model.id === activeModel)
        ?? Object.freeze({ id: activeModel, label: activeModel, aliases: Object.freeze([]) }),
    ])
  }
  const providers = Object.freeze(
    Object.entries(configured).flatMap(([providerId, value]) => {
      const id = text(providerId, 128)
      if (id === undefined || id === 'openai' || record(value) === undefined) return []
      return [Object.freeze({
        providerId: id,
        pluginId: CONFIG_PLUGIN_ID,
        title: text(record(value)?.name, 256) ?? id,
        ...(() => {
          const override = selectorIcons?.providers[id]
          const baseUrl = text(record(value)?.base_url, 4_096)
          const title = text(record(value)?.name, 256)
          const inferred = inferProviderBrand({
            providerId: id,
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...(title === undefined ? {} : { title }),
          })
          return override !== undefined
            ? { selectorBrand: Object.freeze({ brand: override, source: 'override' as const }) }
            : inferred === undefined
            ? {}
            : { selectorBrand: Object.freeze({ brand: inferred, source: 'inferred' as const }) }
        })(),
        models: Object.freeze([...(boundModels.get(id) ?? [])].map(model => {
          const selectorBrand = selectorIcons?.models[id]?.[model.id]
          return selectorBrand === undefined ? model : Object.freeze({ ...model, selectorBrand })
        })),
        ...(activeProvider === id && activeModel !== undefined
            && boundModels.get(id)?.some(model => model.id === activeModel)
          ? { defaultModelId: activeModel }
          : {}),
      })]
    }),
  )
  return Object.freeze({
    providers,
    sourceAvailable: true,
    sourceRevision,
    providerIds: new Set(providers.map(provider => provider.providerId)),
    providerWireApis,
    diagnostics: Object.freeze(diagnostics),
  })
}
