export interface HomeConfigMarketplaceSourceLocal {
  readonly name?: string
  readonly description?: string
  readonly note?: string
}

/** Host-owned Marketplace definition shared by discovery, Manager, CLI, and certification. */
export interface HomeConfigMarketplaceSource {
  readonly url: string
  readonly enabled: boolean
  readonly trusted: boolean
  readonly local?: HomeConfigMarketplaceSourceLocal
}

export const DEFAULT_MARKETPLACE_TRUST_SOURCE =
  'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'

const MAX_MARKETPLACE_SOURCES = 32

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !allowedKeys.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is not supported`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalMarketplaceText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be trimmed text with at most ${maxLength} characters`)
  }
  return value
}

function canonicalMarketplaceUrl(value: unknown, label: string): string {
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

export function supportsTrustedMarketplaceSource(url: string): boolean {
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && parsed.search === ''
}

function parseMarketplaceSource(value: unknown, index: number): HomeConfigMarketplaceSource {
  const label = `config.marketplaceSources[${index}]`
  const source = record(value, label)
  rejectUnknownKeys(source, ['url', 'enabled', 'trusted', 'local'], label)
  const url = canonicalMarketplaceUrl(source.url, `${label}.url`)
  if (typeof source.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
  if (typeof source.trusted !== 'boolean') throw new Error(`${label}.trusted must be a boolean`)
  if (source.trusted && !supportsTrustedMarketplaceSource(url)) {
    throw new Error(`${label}.url must be HTTPS without a query when trusted`)
  }
  let local: HomeConfigMarketplaceSourceLocal | undefined
  if (source.local !== undefined) {
    const raw = record(source.local, `${label}.local`)
    rejectUnknownKeys(raw, ['name', 'description', 'note'], `${label}.local`)
    const name = optionalMarketplaceText(raw.name, `${label}.local.name`, 80)
    const description = optionalMarketplaceText(raw.description, `${label}.local.description`, 280)
    const note = optionalMarketplaceText(raw.note, `${label}.local.note`, 500)
    if (name === undefined && description === undefined && note === undefined) {
      throw new Error(`${label}.local must not be empty`)
    }
    local = {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(note === undefined ? {} : { note }),
    }
  }
  return { url, enabled: source.enabled, trusted: source.trusted, ...(local === undefined ? {} : { local }) }
}

function legacyMarketplaceSource(value: unknown, label: string): HomeConfigMarketplaceSource {
  const source = record(value, label)
  const url = canonicalMarketplaceUrl(source.url, `${label}.url`)
  if (typeof source.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
  const rawLocal = source.local === undefined ? undefined : record(source.local, `${label}.local`)
  const name = optionalMarketplaceText(rawLocal?.name, `${label}.local.name`, 80)
  const description = optionalMarketplaceText(rawLocal?.description, `${label}.local.description`, 280)
  const note = optionalMarketplaceText(rawLocal?.note, `${label}.local.note`, 500)
  const local = name === undefined && description === undefined && note === undefined
    ? undefined
    : {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(note === undefined ? {} : { note }),
    }
  return { url, enabled: source.enabled, trusted: true, ...(local === undefined ? {} : { local }) }
}

function legacyTrustSource(value: unknown, index: number): { readonly url: string; readonly enabled: boolean } {
  const label = `config.marketplaceTrustSources[${index}]`
  const source = record(value, label)
  rejectUnknownKeys(source, ['url', 'enabled'], label)
  const url = canonicalMarketplaceUrl(source.url, `${label}.url`)
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.search !== '') {
    throw new Error(`${label}.url must be an HTTPS URL without credentials, query, or fragment`)
  }
  if (typeof source.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
  return { url, enabled: source.enabled }
}

export function migrateMarketplaceConfigDocument(value: Record<string, unknown>): {
  readonly document: Record<string, unknown>
  readonly migrated: boolean
} {
  if (value.marketplaceSources !== undefined) return { document: value, migrated: false }
  if (value.marketplaceTrustSources !== undefined && !Array.isArray(value.marketplaceTrustSources)) {
    throw new Error('config.marketplaceTrustSources must be an array')
  }
  const explicitlyTrustsNoSources = Array.isArray(value.marketplaceTrustSources)
    && value.marketplaceTrustSources.length === 0
  const trustSources = (value.marketplaceTrustSources ?? [{
    url: DEFAULT_MARKETPLACE_TRUST_SOURCE,
    enabled: true,
  }]).map(legacyTrustSource)
  const trust = new Map(trustSources.map(source => [source.url, source.enabled]))
  const definitions = new Map<string, HomeConfigMarketplaceSource>()
  const mergeDefinition = (source: HomeConfigMarketplaceSource): void => {
    const current = definitions.get(source.url)
    definitions.set(
      source.url,
      current === undefined
        ? source
        : {
          ...current,
          enabled: current.enabled || source.enabled,
          trusted: current.trusted || source.trusted,
          ...(current.local === undefined && source.local !== undefined ? { local: source.local } : {}),
        },
    )
  }
  for (const source of trustSources) {
    mergeDefinition({ url: source.url, enabled: source.enabled, trusted: source.enabled })
  }
  const rawApps = record(value.apps, 'config.apps')
  const apps: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [appId, rawApp] of Object.entries(rawApps)) {
    const app = record(rawApp, `config.apps.${appId}`)
    const rawProfiles = record(app.profiles, `config.apps.${appId}.profiles`)
    const profiles: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [profileId, rawProfile] of Object.entries(rawProfiles)) {
      const profile = record(rawProfile, `config.apps.${appId}.profiles.${profileId}`)
      const rawManagement = profile.management === undefined
        ? undefined
        : record(profile.management, `config.apps.${appId}.profiles.${profileId}.management`)
      if (rawManagement?.sources !== undefined && !Array.isArray(rawManagement.sources)) {
        throw new Error(`config.apps.${appId}.profiles.${profileId}.management.sources must be an array`)
      }
      const legacySources = (rawManagement?.sources ?? []).map((source, index) =>
        legacyMarketplaceSource(source, `config.apps.${appId}.profiles.${profileId}.management.sources[${index}]`)
      )
      for (const source of legacySources) {
        mergeDefinition({
          ...source,
          trusted: trust.has(source.url)
            ? trust.get(source.url) === true
            : !explicitlyTrustsNoSources && supportsTrustedMarketplaceSource(source.url),
        })
      }
      const selected = new Map(legacySources.map(source => [source.url, source.enabled]))
      for (const source of trustSources) if (!selected.has(source.url)) selected.set(source.url, source.enabled)
      profiles[profileId] = {
        ...profile,
        management: {
          ...(rawManagement ?? { revision: 0, hiddenCatalogEntries: [] }),
          sources: [...selected].map(([url, enabled]) => ({ url, enabled })),
        },
      }
    }
    apps[appId] = { ...app, profiles }
  }
  const document: Record<string, unknown> = { ...value, marketplaceSources: [...definitions.values()], apps }
  delete document.marketplaceTrustSources
  return { document, migrated: true }
}

export function parseHomeConfigMarketplaceSources(value: unknown): readonly HomeConfigMarketplaceSource[] {
  if (!Array.isArray(value)) throw new Error('config.marketplaceSources must be an array')
  const sources = value.map(parseMarketplaceSource)
  if (sources.length > MAX_MARKETPLACE_SOURCES) {
    throw new Error(`config.marketplaceSources must contain at most ${MAX_MARKETPLACE_SOURCES} sources`)
  }
  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.url)) throw new Error(`duplicate Marketplace source: ${source.url}`)
    seen.add(source.url)
  }
  return sources
}
