const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/

/** A profile selects a top-level Marketplace definition and may override its enabled state. */
export interface HomeConfigMarketplaceSourceSelection {
  readonly url: string
  readonly enabled: boolean
}

export interface HomeConfigHiddenMarketplaceEntry {
  readonly sourceUrl: string
  readonly pluginId: string
}

export interface HomeConfigProfileManagementMigrations {
  readonly legacyBrowserSourcesV2?: true
}

export interface HomeConfigProfileManagement {
  readonly revision: number
  readonly sources: readonly HomeConfigMarketplaceSourceSelection[]
  readonly hiddenCatalogEntries: readonly HomeConfigHiddenMarketplaceEntry[]
  readonly migrations?: HomeConfigProfileManagementMigrations
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is not supported`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function canonicalMarketplaceDiscoveryUrl(value: unknown, label: string): string {
  const text = nonEmptyString(value, label)
  const url = new URL(text)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.href !== text
  ) throw new Error(`${label} must be a canonical HTTP or HTTPS URL without credentials or fragment`)
  return text
}

function parseMarketplaceSourceSelection(value: unknown, label: string): HomeConfigMarketplaceSourceSelection {
  const source = record(value, label)
  rejectUnknownKeys(source, ['url', 'enabled'], label)
  if (typeof source.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
  return {
    url: canonicalMarketplaceDiscoveryUrl(source.url, `${label}.url`),
    enabled: source.enabled,
  }
}

export function parseHomeConfigProfileManagement(value: unknown, label: string): HomeConfigProfileManagement {
  const management = record(value, label)
  rejectUnknownKeys(management, ['revision', 'sources', 'hiddenCatalogEntries', 'migrations'], label)
  if (!Number.isSafeInteger(management.revision) || (management.revision as number) < 0) {
    throw new Error(`${label}.revision must be a non-negative safe integer`)
  }
  if (!Array.isArray(management.sources)) throw new Error(`${label}.sources must be an array`)
  const sources = management.sources.map((source, index) =>
    parseMarketplaceSourceSelection(source, `${label}.sources[${index}]`)
  )
  const sourceUrls = new Set<string>()
  for (const source of sources) {
    if (sourceUrls.has(source.url)) throw new Error(`${label}.sources contains duplicate URL ${source.url}`)
    sourceUrls.add(source.url)
  }
  if (!Array.isArray(management.hiddenCatalogEntries)) throw new Error(`${label}.hiddenCatalogEntries must be an array`)
  const hiddenCatalogEntries = management.hiddenCatalogEntries.map((value, index) => {
    const entryLabel = `${label}.hiddenCatalogEntries[${index}]`
    const entry = record(value, entryLabel)
    rejectUnknownKeys(entry, ['sourceUrl', 'pluginId'], entryLabel)
    const pluginId = nonEmptyString(entry.pluginId, `${entryLabel}.pluginId`)
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`${entryLabel}.pluginId is invalid`)
    return {
      sourceUrl: canonicalMarketplaceDiscoveryUrl(entry.sourceUrl, `${entryLabel}.sourceUrl`),
      pluginId,
    }
  })
  const hiddenKeys = new Set<string>()
  for (const entry of hiddenCatalogEntries) {
    const key = `${entry.sourceUrl}\n${entry.pluginId}`
    if (hiddenKeys.has(key)) throw new Error(`${label}.hiddenCatalogEntries contains duplicate identity`)
    hiddenKeys.add(key)
  }
  let migrations: HomeConfigProfileManagementMigrations | undefined
  if (management.migrations !== undefined) {
    const raw = record(management.migrations, `${label}.migrations`)
    rejectUnknownKeys(raw, ['legacyBrowserSourcesV2'], `${label}.migrations`)
    if (raw.legacyBrowserSourcesV2 !== undefined && raw.legacyBrowserSourcesV2 !== true) {
      throw new Error(`${label}.migrations.legacyBrowserSourcesV2 must be true when present`)
    }
    if (raw.legacyBrowserSourcesV2 === true) migrations = { legacyBrowserSourcesV2: true }
  }
  return {
    revision: management.revision as number,
    sources,
    hiddenCatalogEntries,
    ...(migrations === undefined ? {} : { migrations }),
  }
}
