import { parseNativeModelListPage } from '../renderer/adapter/native-model-list.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

/** Retain the native default and Fast capabilities while parsing the same audited model-list shape. */
export async function nativeCodexModelCatalog(
  request: (params: Record<string, unknown>) => Promise<unknown>,
): Promise<NativeModelProviderCatalogEntry | undefined> {
  const models: NativeModelProviderCatalogEntry['models'][number][] = [],
    defaults = new Set<string>(),
    cursors = new Set<string>(),
    seen = new Set<string>()
  let cursor: string | undefined
  try {
    for (let index = 0; index < 20; index++) {
      const raw = await request({ limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      const page = parseNativeModelListPage(raw)
      if (!page) return undefined
      for (const model of page.models) {
        if (seen.has(model.id)) return undefined
        seen.add(model.id)
        models.push({ ...model, aliases: [] })
      }
      const data = (raw as { data: Record<string, unknown>[] }).data
      for (const row of data) {
        if (row.isDefault === true && row.hidden === false && typeof row.model === 'string') defaults.add(row.model)
      }
      if (!page.nextCursor) {
        return {
          providerId: 'openai',
          pluginId: 'codex',
          models,
          ...(defaults.size === 1 ? { defaultModelId: [...defaults][0]! } : {}),
        }
      }
      if (cursors.has(page.nextCursor)) return undefined
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
  } catch { /* unavailable is not a fabricated model list */ }
  return undefined
}
