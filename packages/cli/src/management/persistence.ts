import {
  createDefaultHomeConfig,
  type HomeConfig,
  type HomeConfigMarketplaceSource,
  type HomeConfigProfileManagement,
  loadHomeConfig,
  resolveHomeConfigMarketplaceSources,
  updateHomeConfigAtomic,
} from '../config/home-config.js'
import {
  OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE,
  type PluginManagementCatalogIdentity,
  type PluginManagementConfigRequest,
  type PluginManagementLegacySourceInput,
  type PluginManagementLegacySourceMigration,
  type PluginManagementSource,
  type PluginManagementSourceInput,
} from './contracts.js'

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/

export interface PluginManagementPersistenceOptions {
  readonly configPath: string
  readonly appId?: string
  readonly profileId: string
}

export interface LoadedPluginManagementConfig extends Omit<HomeConfigProfileManagement, 'sources'> {
  readonly sources: readonly HomeConfigMarketplaceSource[]
}

function canonicalUrl(value: string): string {
  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) throw new Error('Marketplace source must be an HTTP or HTTPS URL without credentials or fragment.')
  return url.href
}

function localText(value: string | undefined, maximum: number, label: string): string | undefined {
  if (value === undefined) return undefined
  if (value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be trimmed text with at most ${maximum} characters.`)
  }
  return value
}

function normalizeLocal(source: Pick<PluginManagementSourceInput, 'local'>): HomeConfigMarketplaceSource['local'] {
  const name = localText(source.local?.name, 80, 'Marketplace source name')
  const description = localText(source.local?.description, 280, 'Marketplace source description')
  const note = localText(source.local?.note, 500, 'Marketplace source note')
  return name === undefined && description === undefined && note === undefined
    ? undefined
    : {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(note === undefined ? {} : { note }),
    }
}

export function normalizePluginManagementSource(source: PluginManagementSourceInput): HomeConfigMarketplaceSource {
  if (typeof source.enabled !== 'boolean') throw new Error('Marketplace source enabled must be boolean.')
  if (source.trusted !== undefined && typeof source.trusted !== 'boolean') {
    throw new Error('Marketplace source trusted must be boolean.')
  }
  const url = canonicalUrl(source.url)
  const parsed = new URL(url)
  if (source.trusted === true && (parsed.protocol !== 'https:' || parsed.search !== '')) {
    throw new Error('A trusted Marketplace source must be HTTPS without a query.')
  }
  const local = normalizeLocal(source)
  return {
    url,
    enabled: source.enabled,
    trusted: source.trusted ?? false,
    ...(local === undefined ? {} : { local }),
  }
}

function normalizeLegacySource(
  source: PluginManagementLegacySourceInput,
): Omit<HomeConfigMarketplaceSource, 'trusted'> {
  if (typeof source.enabled !== 'boolean') throw new Error('Marketplace source enabled must be boolean.')
  const local = normalizeLocal(source)
  return {
    url: canonicalUrl(source.url),
    enabled: source.enabled,
    ...(local === undefined ? {} : { local }),
  }
}

export function normalizePluginManagementIdentity(
  identity: PluginManagementCatalogIdentity,
): PluginManagementCatalogIdentity {
  if (!PLUGIN_ID.test(identity.pluginId)) throw new Error('Marketplace plugin id is invalid.')
  return { sourceUrl: canonicalUrl(identity.sourceUrl), pluginId: identity.pluginId }
}

function storedManagement(
  config: HomeConfig,
  options: PluginManagementPersistenceOptions,
): HomeConfigProfileManagement {
  const appId = options.appId ?? 'codex'
  const app = config.apps[appId]
  if (app === undefined) throw new Error(`Unknown CordisX app: ${appId}`)
  const profile = app.profiles[options.profileId]
  if (profile === undefined) throw new Error(`Unknown CordisX profile: ${options.profileId}`)
  return profile.management ?? {
    revision: 0,
    sources: config.marketplaceSources.map(source => ({ url: source.url, enabled: source.enabled })),
    hiddenCatalogEntries: [],
  }
}

function currentManagement(
  config: HomeConfig,
  options: PluginManagementPersistenceOptions,
): LoadedPluginManagementConfig {
  const management = storedManagement(config, options)
  return {
    ...management,
    sources: resolveHomeConfigMarketplaceSources(config, options.profileId, options.appId ?? 'codex'),
  }
}

export function defaultPluginManagementConfig(): LoadedPluginManagementConfig {
  const config = createDefaultHomeConfig()
  return currentManagement(config, { configPath: '', profileId: 'default' })
}

function sourceProjection(source: HomeConfigMarketplaceSource): PluginManagementSource {
  const official = source.url === OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE
  return { ...source, official, removable: !official }
}

export function projectPluginManagementSources(
  management: LoadedPluginManagementConfig,
): readonly PluginManagementSource[] {
  return management.sources.map(sourceProjection)
}

export async function loadPluginManagementConfig(
  options: PluginManagementPersistenceOptions,
): Promise<LoadedPluginManagementConfig> {
  try {
    return currentManagement(await loadHomeConfig(options.configPath), options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return currentManagement(createDefaultHomeConfig(), options)
  }
}

function replaceManagement(
  config: HomeConfig,
  options: PluginManagementPersistenceOptions,
  management: HomeConfigProfileManagement,
): HomeConfig {
  const appId = options.appId ?? 'codex'
  const app = config.apps[appId]
  if (app === undefined) throw new Error(`Unknown CordisX app: ${appId}`)
  const profile = app.profiles[options.profileId]
  if (profile === undefined) throw new Error(`Unknown CordisX profile: ${options.profileId}`)
  return {
    ...config,
    apps: {
      ...config.apps,
      [appId]: {
        ...app,
        profiles: { ...app.profiles, [options.profileId]: { ...profile, management } },
      },
    },
  }
}

function materializeProfileSelections(config: HomeConfig): HomeConfig {
  const apps = Object.fromEntries(
    Object.entries(config.apps).map(([appId, app]) => [
      appId,
      {
        ...app,
        profiles: Object.fromEntries(
          Object.entries(app.profiles).map(([profileId, profile]) => [
            profileId,
            profile.management === undefined
              ? {
                ...profile,
                management: {
                  revision: 0,
                  sources: config.marketplaceSources.map(source => ({ url: source.url, enabled: source.enabled })),
                  hiddenCatalogEntries: [],
                },
              }
              : profile,
          ]),
        ),
      },
    ]),
  ) as HomeConfig['apps']
  return { ...config, apps }
}

function replaceSourceAcrossProfiles(
  config: HomeConfig,
  previousUrl: string,
  nextUrl?: string,
): HomeConfig {
  const apps = Object.fromEntries(
    Object.entries(config.apps).map(([appId, app]) => [
      appId,
      {
        ...app,
        profiles: Object.fromEntries(
          Object.entries(app.profiles).map(([profileId, profile]) => {
            const management = profile.management
            if (management === undefined) return [profileId, profile]
            const sources = nextUrl === undefined
              ? management.sources.filter(source => source.url !== previousUrl)
              : management.sources.map(source => source.url === previousUrl ? { ...source, url: nextUrl } : source)
            const hiddenCatalogEntries = nextUrl === undefined
              ? management.hiddenCatalogEntries.filter(entry => entry.sourceUrl !== previousUrl)
              : management.hiddenCatalogEntries.map(entry =>
                entry.sourceUrl === previousUrl ? { ...entry, sourceUrl: nextUrl } : entry
              )
            return [profileId, {
              ...profile,
              management: { ...management, revision: management.revision + 1, sources, hiddenCatalogEntries },
            }]
          }),
        ),
      },
    ]),
  ) as HomeConfig['apps']
  return { ...config, apps }
}

export function planPluginManagementConfig(
  input: HomeConfig,
  options: PluginManagementPersistenceOptions,
  request: PluginManagementConfigRequest,
): HomeConfig {
  let config = materializeProfileSelections(input)
  let management = storedManagement(config, options)
  if (request.kind === 'source-add') {
    const source = normalizePluginManagementSource(request.source)
    if (config.marketplaceSources.some(item => item.url === source.url)) {
      throw new Error('Marketplace source already exists.')
    }
    config = { ...config, marketplaceSources: [...config.marketplaceSources, source] }
    management = {
      ...management,
      revision: management.revision + 1,
      sources: [...management.sources, { url: source.url, enabled: source.enabled }],
    }
    return replaceManagement(config, options, management)
  }
  if (request.kind === 'source-edit') {
    const url = canonicalUrl(request.url)
    const index = config.marketplaceSources.findIndex(item => item.url === url)
    if (index < 0) throw new Error('Marketplace source does not exist.')
    const previous = config.marketplaceSources[index]!
    const source = normalizePluginManagementSource(request.source)
    if (previous.url === OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE && source.url !== previous.url) {
      throw new Error('The Official Marketplace source URL cannot be changed.')
    }
    if (source.url !== previous.url && config.marketplaceSources.some(item => item.url === source.url)) {
      throw new Error('Marketplace source already exists.')
    }
    const marketplaceSources = [...config.marketplaceSources]
    marketplaceSources[index] = { ...source, enabled: previous.enabled }
    config = replaceSourceAcrossProfiles({ ...config, marketplaceSources }, previous.url, source.url)
    management = storedManagement(config, options)
    const selected = management.sources.findIndex(item => item.url === source.url)
    if (selected >= 0) {
      const sources = [...management.sources]
      sources[selected] = { url: source.url, enabled: source.enabled }
      config = replaceManagement(config, options, { ...management, sources })
    }
    return config
  }
  if (request.kind === 'source-set-enabled') {
    const url = canonicalUrl(request.url)
    const index = management.sources.findIndex(item => item.url === url)
    if (index < 0) throw new Error('Marketplace source does not exist.')
    const sources = [...management.sources]
    sources[index] = { ...sources[index]!, enabled: request.enabled }
    return replaceManagement(config, options, { ...management, revision: management.revision + 1, sources })
  }
  if (request.kind === 'source-remove') {
    const url = canonicalUrl(request.url)
    const source = config.marketplaceSources.find(item => item.url === url)
    if (source === undefined) throw new Error('Marketplace source does not exist.')
    if (source.url === OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE) {
      throw new Error('The Official Marketplace source cannot be removed.')
    }
    return replaceSourceAcrossProfiles({
      ...config,
      marketplaceSources: config.marketplaceSources.filter(item => item.url !== url),
    }, url)
  }
  const identity = normalizePluginManagementIdentity(request.identity)
  const key = (value: PluginManagementCatalogIdentity) => `${value.sourceUrl}\n${value.pluginId}`
  const hiddenCatalogEntries = request.kind === 'catalog-hide'
    ? management.hiddenCatalogEntries.some(item => key(item) === key(identity))
      ? management.hiddenCatalogEntries
      : [...management.hiddenCatalogEntries, identity]
    : management.hiddenCatalogEntries.filter(item => key(item) !== key(identity))
  return replaceManagement(config, options, {
    ...management,
    revision: management.revision + 1,
    hiddenCatalogEntries,
  })
}

export async function updatePluginManagementConfig(
  options: PluginManagementPersistenceOptions,
  request: PluginManagementConfigRequest,
): Promise<LoadedPluginManagementConfig> {
  const updated = await updateHomeConfigAtomic(
    config => planPluginManagementConfig(config, options, request),
    options.configPath,
  )
  return currentManagement(updated, options)
}

export async function migrateLegacyPluginManagementSources(
  options: PluginManagementPersistenceOptions,
  migration: PluginManagementLegacySourceMigration,
): Promise<{ readonly migrated: boolean; readonly management: LoadedPluginManagementConfig }> {
  let migrated = false
  const updated = await updateHomeConfigAtomic(input => {
    const explicitManagement =
      input.apps[options.appId ?? 'codex']?.profiles[options.profileId]?.management !== undefined
    let config = materializeProfileSelections(input)
    const current = storedManagement(config, options)
    if (current.migrations?.legacyBrowserSourcesV2 === true) return config
    const definitions = [...config.marketplaceSources]
    const sources = [...current.sources]
    const sourceIndexes = new Map(sources.map((source, index) => [source.url, index]))
    const definitionIndexes = new Map(definitions.map((source, index) => [source.url, index]))
    for (const inputSource of migration.sources) {
      const source = normalizeLegacySource(inputSource)
      const definitionIndex = definitionIndexes.get(source.url)
      if (definitionIndex === undefined) {
        definitionIndexes.set(source.url, definitions.length)
        definitions.push({ ...source, trusted: false })
      } else {
        const existing = definitions[definitionIndex]!
        const local = existing.local === undefined && source.local === undefined
          ? undefined
          : { ...source.local, ...existing.local }
        definitions[definitionIndex] = { ...existing, ...(local === undefined ? {} : { local }) }
      }
      const sourceIndex = sourceIndexes.get(source.url)
      if (sourceIndex === undefined) {
        sourceIndexes.set(source.url, sources.length)
        sources.push({ url: source.url, enabled: source.enabled })
      } else if (!explicitManagement) {
        sources[sourceIndex] = { ...sources[sourceIndex]!, enabled: source.enabled }
      }
    }
    migrated = true
    config = { ...config, marketplaceSources: definitions }
    return replaceManagement(config, options, {
      ...current,
      revision: current.revision + 1,
      sources,
      migrations: { ...current.migrations, legacyBrowserSourcesV2: true },
    })
  }, options.configPath)
  const management = currentManagement(updated, options)
  if (management.migrations?.legacyBrowserSourcesV2 !== true) {
    throw new Error('Legacy Marketplace source migration did not persist.')
  }
  return { migrated, management }
}
