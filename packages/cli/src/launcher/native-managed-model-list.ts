import { createHash } from 'node:crypto'
import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

export interface NativeManagedModelListRequest {
  readonly providerId: string
  readonly limit?: number | null
  readonly cursor?: string | null
  readonly includeHidden?: boolean | null
}

/**
 * Recover only a Host-owned provider whose native server cannot resolve it.
 * An incomplete catalog is not a model list: preserve the native error instead
 * of inventing reasoning capabilities or silently dropping selectable models.
 */
export function nativeManagedModelList(options: {
  readonly owns: (providerId: string) => boolean
  readonly catalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>
}) {
  return async (request: NativeManagedModelListRequest): Promise<unknown | undefined> => {
    if (!options.owns(request.providerId)) return undefined
    const provider = (await options.catalog()).find(item => item.providerId === request.providerId)
    if (!provider || provider.models.length === 0 || provider.models.length > 20_000) return undefined
    const rows = []
    const ids = new Set<string>()
    for (const model of provider.models) {
      if (
        typeof model.id !== 'string' || model.id.length === 0 || model.id.length > 512 || /[\0\r\n]/u.test(model.id)
        || typeof model.label !== 'string' || model.label.length === 0 || model.label.length > 512
        || /[\0\r\n]/u.test(model.label) || ids.has(model.id)
      ) return undefined
      ids.add(model.id)
      const capabilities = parseModelReasoningCapabilities(model.reasoningCapabilities)
      const defaultEffort = capabilities?.defaultEffort
        ?? (capabilities?.efforts.length === 1 ? capabilities.efforts[0] : undefined)
      if (!capabilities || !defaultEffort || !capabilities.efforts.includes(defaultEffort)) return undefined
      rows.push({
        id: model.id,
        model: model.id,
        displayName: model.label,
        description: '',
        hidden: false,
        isDefault: model.id === provider.defaultModelId,
        defaultReasoningEffort: defaultEffort,
        supportedReasoningEfforts: capabilities.efforts.map(reasoningEffort => ({
          reasoningEffort,
          description: '',
        })),
        // Managed catalogs do not yet carry audited image/audio capability.
        // Do not widen the native attachment controls based on a schema default.
        inputModalities: ['text'],
        serviceTiers: model.supportsFastMode === true ? [{ id: 'priority', name: 'Fast', description: '' }] : [],
      })
    }
    const revision = createHash('sha256').update(JSON.stringify([request.providerId, rows])).digest('hex').slice(0, 24)
    let start = 0
    if (request.cursor != null) {
      const match = /^cx-model-v1:([a-f0-9]{24}):([1-9][0-9]{0,5})$/u.exec(request.cursor)
      if (!match || match[1] !== revision) return undefined
      start = Number(match[2])
      if (!Number.isSafeInteger(start) || start >= rows.length) return undefined
    }
    if (request.limit != null && (!Number.isSafeInteger(request.limit) || request.limit < 1)) return undefined
    const limit = Math.min(request.limit ?? 100, 100)
    const end = Math.min(start + limit, rows.length)
    return {
      data: rows.slice(start, end),
      nextCursor: end < rows.length ? `cx-model-v1:${revision}:${end}` : null,
    }
  }
}
