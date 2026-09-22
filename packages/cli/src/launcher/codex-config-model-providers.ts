import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { parseConfigModelCatalogs } from '../config/home-config-model-catalogs.js'

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
  readonly diagnostics: readonly {
    readonly providerId: string
    readonly code: 'catalog-unavailable' | 'catalog-empty' | 'provider-missing'
  }[]
}

/** Reads Codex configuration privately and returns only selector-safe provider/model metadata. */
export async function codexConfigModelProviders(
  codexHome: string,
  configModelCatalogs?: Readonly<Record<string, string>>,
): Promise<CodexConfigModelProviderProjection> {
  const mappings = parseConfigModelCatalogs(configModelCatalogs) ?? {}
  const diagnostics: Array<CodexConfigModelProviderProjection['diagnostics'][number]> = []
  let config: Record<string, unknown>
  try {
    config = record(parse(await boundedText(path.join(codexHome, 'config.toml'), MAX_CONFIG_BYTES))) ?? {}
  } catch {
    return Object.freeze({
      providers: Object.freeze([]),
      providerIds: new Set<string>(),
      diagnostics: Object.freeze(
        Object.keys(mappings).map(providerId => ({ providerId, code: 'provider-missing' as const })),
      ),
    })
  }
  const configured = record(config.model_providers) ?? {}
  const activeProvider = text(config.model_provider, 128)
  const activeModel = text(config.model, 512)
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
        models: Object.freeze([...(boundModels.get(id) ?? [])]),
        ...(activeProvider === id && activeModel !== undefined
            && boundModels.get(id)?.some(model => model.id === activeModel)
          ? { defaultModelId: activeModel }
          : {}),
      })]
    }),
  )
  return Object.freeze({
    providers,
    providerIds: new Set(providers.map(provider => provider.providerId)),
    diagnostics: Object.freeze(diagnostics),
  })
}
