export const OFFICIAL_MARKETPLACE_SOURCE = 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'
export const MARKETPLACE_SOURCE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-source.v1.schema.json'
export const MARKETPLACE_SOURCES_KEY = 'cordisx.manager.marketplaceSources.v1'
export const MARKETPLACE_SOURCE_RECORDS_KEY = 'cordisx.manager.marketplaceSources.v2'

export interface MarketplaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface MarketplaceSourceLocalOverrides {
  readonly name?: string
  readonly description?: string
  readonly note?: string
}

export interface MarketplaceSourceRecord {
  readonly url: string
  readonly enabled: boolean
  readonly local?: MarketplaceSourceLocalOverrides
}

export interface MarketplaceSourceImportV1 {
  readonly $schema: typeof MARKETPLACE_SOURCE_SCHEMA_V1
  readonly schemaVersion: 1
  readonly url: string
  readonly enabled: boolean
  readonly local?: MarketplaceSourceLocalOverrides
}

interface PersistedMarketplaceSourcesV2 {
  readonly schemaVersion: 2
  readonly sources: readonly MarketplaceSourceRecord[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON object`)
  }
  return value as Record<string, unknown>
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed)
  const unexpected = Object.keys(value).filter(key => !known.has(key))
  if (unexpected.length > 0) throw new Error(`${label} 包含不支持的字段: ${unexpected.join(', ')}`)
}

function localText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value
    || value.trim() === ''
  ) {
    throw new Error(`${label} 必须是已裁剪的 1-${maxLength} 字符文本`)
  }
  return value
}

function normalizeLocal(value: unknown, label = 'local'): MarketplaceSourceLocalOverrides | undefined {
  if (value === undefined) return undefined
  const raw = record(value, label)
  assertKeys(raw, ['name', 'description', 'note'], label)
  const name = localText(raw.name, `${label}.name`, 80)
  const description = localText(raw.description, `${label}.description`, 280)
  const note = localText(raw.note, `${label}.note`, 500)
  if (name === undefined && description === undefined && note === undefined) throw new Error(`${label} 不能为空`)
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(note === undefined ? {} : { note }),
  })
}

/** Canonical configured feed identity. Query parameters are allowed; credentials and fragments are not. */
export function normalizeMarketplaceSource(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('插件商店地址必须是无凭据、无 fragment 的 HTTPS URL')
  }
  return url.href
}

export function normalizeMarketplaceSourceRecord(value: MarketplaceSourceRecord): MarketplaceSourceRecord {
  if (typeof value.enabled !== 'boolean') throw new Error('source.enabled 必须是 boolean')
  const url = normalizeMarketplaceSource(value.url)
  const local = normalizeLocal(value.local)
  return Object.freeze({ url, enabled: value.enabled, ...(local === undefined ? {} : { local }) })
}

export function isOfficialMarketplaceSource(value: string): boolean {
  return normalizeMarketplaceSource(value) === OFFICIAL_MARKETPLACE_SOURCE
}

function dedupeSources(values: readonly MarketplaceSourceRecord[]): MarketplaceSourceRecord[] {
  const result: MarketplaceSourceRecord[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const source = normalizeMarketplaceSourceRecord(value)
    if (seen.has(source.url)) continue
    seen.add(source.url)
    result.push(source)
  }
  return result
}

function withOfficialSource(
  values: readonly MarketplaceSourceRecord[],
  previous: MarketplaceSourceRecord | undefined,
  enabledWhenMissing: boolean,
): MarketplaceSourceRecord[] {
  const sources = dedupeSources(values)
  if (sources.some(source => source.url === OFFICIAL_MARKETPLACE_SOURCE)) return sources
  const official = previous === undefined
    ? { url: OFFICIAL_MARKETPLACE_SOURCE, enabled: enabledWhenMissing }
    : { ...previous, enabled: false }
  return [Object.freeze(official), ...sources]
}

function legacySources(value: unknown): MarketplaceSourceRecord[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return dedupeSources(value.map(url => ({ url, enabled: true })))
}

function persistedSources(value: unknown): MarketplaceSourceRecord[] | undefined {
  const persisted = record(value, 'marketplace source store')
  assertKeys(persisted, ['schemaVersion', 'sources'], 'marketplace source store')
  if (persisted.schemaVersion !== 2 || !Array.isArray(persisted.sources)) return undefined
  return dedupeSources(persisted.sources.map((item, index) => {
    const source = record(item, `sources[${index}]`)
    assertKeys(source, ['url', 'enabled', 'local'], `sources[${index}]`)
    if (typeof source.url !== 'string' || typeof source.enabled !== 'boolean') throw new Error(`sources[${index}] 无效`)
    return {
      url: source.url,
      enabled: source.enabled,
      ...(source.local === undefined ? {} : { local: source.local as MarketplaceSourceLocalOverrides }),
    }
  }))
}

/** Parse either a bare feed URL or the formal marketplace-source.v1 clipboard payload. */
export function parseMarketplaceSourceImport(value: string): MarketplaceSourceRecord {
  const text = value.trim()
  if (text === '') throw new Error('剪贴板中没有插件商店地址')
  if (/^https:/iu.test(text)) return normalizeMarketplaceSourceRecord({ url: text, enabled: true })
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('剪贴板内容必须是 HTTPS 地址或 marketplace-source.v1 JSON')
  }
  const source = record(parsed, 'marketplace source import')
  assertKeys(source, ['$schema', 'schemaVersion', 'url', 'enabled', 'local'], 'marketplace source import')
  if (source.$schema !== MARKETPLACE_SOURCE_SCHEMA_V1 || source.schemaVersion !== 1) {
    throw new Error('剪贴板内容不是受支持的 marketplace-source.v1')
  }
  if (typeof source.url !== 'string' || typeof source.enabled !== 'boolean') {
    throw new Error('marketplace-source.v1 缺少 url 或 enabled')
  }
  const local = normalizeLocal(source.local)
  return normalizeMarketplaceSourceRecord({
    url: source.url,
    enabled: source.enabled,
    ...(local === undefined ? {} : { local }),
  })
}

export class BrowserMarketplaceSourceStore {
  private sources: MarketplaceSourceRecord[]

  constructor(private readonly storage: MarketplaceStorage | undefined) {
    this.sources = this.read()
    try {
      this.persist()
    } catch { /* normalized startup state remains usable even when profile storage is unavailable */ }
  }

  snapshot(): readonly MarketplaceSourceRecord[] {
    return this.sources.map(source =>
      Object.freeze({ ...source, ...(source.local === undefined ? {} : { local: Object.freeze({ ...source.local }) }) })
    )
  }

  replace(values: readonly MarketplaceSourceRecord[]): readonly MarketplaceSourceRecord[] {
    const previousOfficial = this.sources.find(source => source.url === OFFICIAL_MARKETPLACE_SOURCE)
    this.sources = withOfficialSource(values, previousOfficial, false)
    this.persist()
    return this.snapshot()
  }

  upsert(value: MarketplaceSourceRecord): readonly MarketplaceSourceRecord[] {
    const source = normalizeMarketplaceSourceRecord(value)
    const index = this.sources.findIndex(item => item.url === source.url)
    if (index < 0) this.sources.push(source)
    else this.sources[index] = source
    this.persist()
    return this.snapshot()
  }

  remove(value: string): readonly MarketplaceSourceRecord[] {
    const url = normalizeMarketplaceSource(value)
    if (url === OFFICIAL_MARKETPLACE_SOURCE) throw new Error('官方插件商店不能删除，只能停用')
    this.sources = this.sources.filter(source => source.url !== url)
    this.persist()
    return this.snapshot()
  }

  setEnabled(value: string, enabled: boolean): readonly MarketplaceSourceRecord[] {
    const url = normalizeMarketplaceSource(value)
    const index = this.sources.findIndex(source => source.url === url)
    if (index < 0) throw new Error('插件商店来源不存在')
    this.sources[index] = Object.freeze({ ...this.sources[index]!, enabled })
    this.persist()
    return this.snapshot()
  }

  move(value: string, targetIndex: number): readonly MarketplaceSourceRecord[] {
    const url = normalizeMarketplaceSource(value)
    const from = this.sources.findIndex(source => source.url === url)
    if (from < 0) throw new Error('插件商店来源不存在')
    const bounded = Math.max(0, Math.min(Math.trunc(targetIndex), this.sources.length - 1))
    const [source] = this.sources.splice(from, 1)
    if (source !== undefined) this.sources.splice(bounded, 0, source)
    this.persist()
    return this.snapshot()
  }

  private read(): MarketplaceSourceRecord[] {
    if (this.storage === undefined) return [{ url: OFFICIAL_MARKETPLACE_SOURCE, enabled: true }]
    try {
      const stored = this.storage.getItem(MARKETPLACE_SOURCE_RECORDS_KEY)
      if (stored !== null) {
        const sources = persistedSources(JSON.parse(stored) as unknown)
        if (sources !== undefined) return withOfficialSource(sources, undefined, false)
      }
      const legacy = this.storage.getItem(MARKETPLACE_SOURCES_KEY)
      if (legacy === null) return [{ url: OFFICIAL_MARKETPLACE_SOURCE, enabled: true }]
      const sources = legacySources(JSON.parse(legacy) as unknown)
      if (sources === undefined) return [{ url: OFFICIAL_MARKETPLACE_SOURCE, enabled: true }]
      return withOfficialSource(sources, undefined, false)
    } catch {
      return [{ url: OFFICIAL_MARKETPLACE_SOURCE, enabled: true }]
    }
  }

  private persist(): void {
    const value: PersistedMarketplaceSourcesV2 = { schemaVersion: 2, sources: this.sources }
    this.storage?.setItem(MARKETPLACE_SOURCE_RECORDS_KEY, JSON.stringify(value))
  }
}
