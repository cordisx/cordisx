import { friendlyModelLabel, type NativeModelSelectionControl } from './native-model-provider-seat.js'

export type NativeModelOption = NativeModelSelectionControl['models'][number]

export interface NativeModelSourceSnapshot {
  readonly providerId: string
  readonly models: readonly NativeModelOption[]
}

export interface NativeModelSourceProjection {
  readonly nativeModels: readonly NativeModelOption[]
  readonly nativeModelsProviderId?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const text = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value)
    ? value
    : undefined

function supportsFastMode(model: Record<string, unknown>): boolean {
  const additional = Array.isArray(model.additionalSpeedTiers) ? model.additionalSpeedTiers : []
  const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : []
  return additional.includes('fast') || tiers.some(value => {
    const tier = record(value)
    return tier?.id === 'priority' || tier?.id === 'fast' || tier?.name === 'Fast'
  })
}

export function parseNativeModelListPage(value: unknown):
  | Readonly<{
    models: readonly NativeModelOption[]
    nextCursor?: string
  }>
  | undefined
{
  const page = record(value)
  if (!Array.isArray(page?.data)) return undefined
  const models: NativeModelOption[] = []
  for (const value of page.data) {
    const model = record(value)
    const id = text(model?.model, 512)
    const protocolId = text(model?.id, 512)
    const label = text(model?.displayName, 512)
    if (
      id === undefined || protocolId === undefined || label === undefined
      || typeof model?.hidden !== 'boolean'
    ) return undefined
    if (model.hidden) continue
    const displayLabel = friendlyModelLabel(label)
    models.push(Object.freeze({
      id,
      label: displayLabel === '' ? id : displayLabel,
      disabled: false,
      supportsFastMode: supportsFastMode(model),
    }))
  }
  const nextCursor = page.nextCursor === null || page.nextCursor === undefined
    ? undefined
    : text(page.nextCursor, 512)
  if (page.nextCursor !== null && page.nextCursor !== undefined && nextCursor === undefined) return undefined
  return Object.freeze({ models: Object.freeze(models), ...(nextCursor === undefined ? {} : { nextCursor }) })
}

export async function readNativeModelList(
  request: (params: Readonly<{ cursor?: string; limit: number; includeHidden: false }>) => Promise<unknown>,
): Promise<readonly NativeModelOption[] | undefined> {
  try {
    const models: NativeModelOption[] = []
    const seenModels = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = parseNativeModelListPage(
        await request({
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
          includeHidden: false,
        }),
      )
      if (page === undefined) return undefined
      for (const model of page.models) {
        if (seenModels.has(model.id)) continue
        seenModels.add(model.id)
        models.push(model)
      }
      if (page.nextCursor === undefined) return Object.freeze(models)
      if (seenCursors.has(page.nextCursor)) return undefined
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
  } catch {
    return undefined
  }
  return undefined
}

export class NativeModelSource {
  private current: NativeModelSourceSnapshot | undefined
  private revision = 0

  snapshot(): NativeModelSourceSnapshot | undefined {
    return this.current
  }

  clear(): void {
    this.revision += 1
    this.current = undefined
  }

  project(
    scope: 'active-provider' | 'global' | undefined,
    globalModels: readonly NativeModelOption[],
  ): NativeModelSourceProjection {
    if (scope !== 'active-provider') {
      return Object.freeze({ nativeModels: globalModels })
    }
    return Object.freeze({
      nativeModels: this.current?.models ?? [],
      ...(this.current === undefined ? {} : { nativeModelsProviderId: this.current.providerId }),
    })
  }

  async refresh(
    providerId: string,
    request: (params: Readonly<{ cursor?: string; limit: number; includeHidden: false }>) => Promise<unknown>,
  ): Promise<void> {
    if (this.current?.providerId === providerId) return
    const revision = ++this.revision
    this.current = undefined
    const models = await readNativeModelList(request)
    if (revision !== this.revision) return
    if (models !== undefined) this.current = Object.freeze({ providerId, models })
  }
}
