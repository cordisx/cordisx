import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

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

function catalogModels(value: unknown): NativeModelProviderCatalogEntry['models'] {
  const models = record(value)?.models
  if (!Array.isArray(models)) return []
  const seen = new Set<string>()
  return Object.freeze(models.flatMap(item => {
    const model = record(item)
    const id = text(model?.slug, 512)
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
}

/** Reads Codex configuration privately and returns only selector-safe provider/model metadata. */
export async function codexConfigModelProviders(codexHome: string): Promise<CodexConfigModelProviderProjection> {
  let config: Record<string, unknown>
  try {
    config = record(parse(await boundedText(path.join(codexHome, 'config.toml'), MAX_CONFIG_BYTES))) ?? {}
  } catch {
    return Object.freeze({ providers: Object.freeze([]), providerIds: new Set<string>() })
  }
  const configured = record(config.model_providers) ?? {}
  const configuredIds = Object.entries(configured).flatMap(([providerId, value]) => {
    const id = text(providerId, 128)
    return id === undefined || id === 'openai' || record(value) === undefined ? [] : [id]
  })
  const activeProvider = text(config.model_provider, 128)
  const activeModel = text(config.model, 512)
  let models: NativeModelProviderCatalogEntry['models'] = []
  const catalog = text(config.model_catalog_json, 4_096)
  if (catalog !== undefined) {
    try {
      const catalogPath = path.isAbsolute(catalog) ? catalog : path.resolve(codexHome, catalog)
      models = catalogModels(JSON.parse(await boundedText(catalogPath, MAX_CATALOG_BYTES)))
    } catch { /* The active model remains a safe fallback when the optional catalog is unavailable. */ }
  }
  const fallbackProvider = activeProvider ?? (configuredIds.length === 1 ? configuredIds[0] : undefined)
  const fallbackModel = activeModel === undefined || models.some(model => model.id === activeModel)
    ? undefined
    : Object.freeze({ id: activeModel, label: activeModel, aliases: Object.freeze([]) })
  const providers = Object.freeze(
    Object.entries(configured).flatMap(([providerId, value]) => {
      const id = text(providerId, 128)
      if (id === undefined || id === 'openai' || record(value) === undefined) return []
      return [Object.freeze({
        providerId: id,
        pluginId: CONFIG_PLUGIN_ID,
        title: text(record(value)?.name, 256) ?? id,
        models: fallbackModel === undefined || fallbackProvider !== id
          ? models
          : Object.freeze([fallbackModel, ...models]),
        ...(activeProvider === id && activeModel !== undefined ? { defaultModelId: activeModel } : {}),
      })]
    }),
  )
  return Object.freeze({ providers, providerIds: new Set(providers.map(provider => provider.providerId)) })
}
