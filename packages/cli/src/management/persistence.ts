import {
  createDefaultHomeConfig,
  type HomeConfigMarketplaceSource,
  type HomeConfigProfileManagement,
  loadHomeConfig,
  updateHomeConfigAtomic,
} from '../config/home-config.js'
import {
  OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE,
  type PluginManagementCatalogIdentity,
  type PluginManagementConfigRequest,
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

export function normalizePluginManagementSource(source: PluginManagementSourceInput): HomeConfigMarketplaceSource {
  if (typeof source.enabled !== 'boolean') throw new Error('Marketplace source enabled must be boolean.')
  const name = localText(source.local?.name, 80, 'Marketplace source name')
  const description = localText(source.local?.description, 280, 'Marketplace source description')
  const note = localText(source.local?.note, 500, 'Marketplace source note')
  const local = name === undefined && description === undefined && note === undefined
    ? undefined
    : {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(note === undefined ? {} : { note }),
    }
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

export function defaultPluginManagementConfig(): HomeConfigProfileManagement {
  return {
    revision: 0,
    sources: [{ url: OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE, enabled: true }],
    hiddenCatalogEntries: [],
  }
}

function sourceProjection(source: HomeConfigMarketplaceSource): PluginManagementSource {
  const official = source.url === OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE
  return { ...source, official, removable: !official }
}

export function projectPluginManagementSources(
  management: HomeConfigProfileManagement,
): readonly PluginManagementSource[] {
  return management.sources.map(sourceProjection)
}

function currentManagement(
  config: Awaited<ReturnType<typeof loadHomeConfig>>,
  options: PluginManagementPersistenceOptions,
): HomeConfigProfileManagement {
  const appId = options.appId ?? 'codex'
  const app = config.apps[appId]
  if (app === undefined) throw new Error(`Unknown CordisX app: ${appId}`)
  const profile = app.profiles[options.profileId]
  if (profile === undefined) throw new Error(`Unknown CordisX profile: ${options.profileId}`)
  return profile.management ?? defaultPluginManagementConfig()
}

export async function loadPluginManagementConfig(
  options: PluginManagementPersistenceOptions,
): Promise<HomeConfigProfileManagement> {
  try {
    return currentManagement(await loadHomeConfig(options.configPath), options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return currentManagement(createDefaultHomeConfig(), options)
  }
}

function replaceManagement(
  config: Awaited<ReturnType<typeof loadHomeConfig>>,
  options: PluginManagementPersistenceOptions,
  management: HomeConfigProfileManagement,
): Awaited<ReturnType<typeof loadHomeConfig>> {
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
        profiles: {
          ...app.profiles,
          [options.profileId]: { ...profile, management },
        },
      },
    },
  }
}

export function planPluginManagementConfig(
  current: HomeConfigProfileManagement,
  request: PluginManagementConfigRequest,
): HomeConfigProfileManagement {
  let sources = [...current.sources]
  let hiddenCatalogEntries = [...current.hiddenCatalogEntries]
  if (request.kind === 'source-add') {
    const source = normalizePluginManagementSource(request.source)
    if (sources.some(item => item.url === source.url)) throw new Error('Marketplace source already exists.')
    sources.push(source)
  } else if (request.kind === 'source-edit') {
    const url = canonicalUrl(request.url)
    const index = sources.findIndex(item => item.url === url)
    if (index < 0) throw new Error('Marketplace source does not exist.')
    const previous = sources[index]!
    const source = normalizePluginManagementSource(request.source)
    if (previous.url === OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE && source.url !== previous.url) {
      throw new Error('The Official Marketplace source URL cannot be changed.')
    }
    if (source.url !== previous.url && sources.some(item => item.url === source.url)) {
      throw new Error('Marketplace source already exists.')
    }
    sources[index] = source
    hiddenCatalogEntries = hiddenCatalogEntries.map(identity =>
      identity.sourceUrl === previous.url ? { ...identity, sourceUrl: source.url } : identity
    )
  } else if (request.kind === 'source-set-enabled') {
    const url = canonicalUrl(request.url)
    const index = sources.findIndex(item => item.url === url)
    if (index < 0) throw new Error('Marketplace source does not exist.')
    sources[index] = { ...sources[index]!, enabled: request.enabled }
  } else if (request.kind === 'source-remove') {
    const url = canonicalUrl(request.url)
    const source = sources.find(item => item.url === url)
    if (source === undefined) throw new Error('Marketplace source does not exist.')
    if (source.url === OFFICIAL_MARKETPLACE_DISCOVERY_SOURCE) {
      throw new Error('The Official Marketplace source cannot be removed.')
    }
    sources = sources.filter(item => item.url !== url)
    hiddenCatalogEntries = hiddenCatalogEntries.filter(identity => identity.sourceUrl !== source.url)
  } else {
    const identity = normalizePluginManagementIdentity(request.identity)
    const key = (value: PluginManagementCatalogIdentity) => `${value.sourceUrl}\n${value.pluginId}`
    if (request.kind === 'catalog-hide') {
      if (!hiddenCatalogEntries.some(item => key(item) === key(identity))) hiddenCatalogEntries.push(identity)
    } else {
      hiddenCatalogEntries = hiddenCatalogEntries.filter(item => key(item) !== key(identity))
    }
  }
  return {
    ...current,
    revision: current.revision + 1,
    sources,
    hiddenCatalogEntries,
  }
}

export async function updatePluginManagementConfig(
  options: PluginManagementPersistenceOptions,
  request: PluginManagementConfigRequest,
): Promise<HomeConfigProfileManagement> {
  const updated = await updateHomeConfigAtomic(config => {
    const management = planPluginManagementConfig(currentManagement(config, options), request)
    return replaceManagement(config, options, management)
  }, options.configPath)
  return currentManagement(updated, options)
}

export async function migrateLegacyPluginManagementSources(
  options: PluginManagementPersistenceOptions,
  migration: PluginManagementLegacySourceMigration,
): Promise<{ readonly migrated: boolean; readonly management: HomeConfigProfileManagement }> {
  let migrated = false
  const updated = await updateHomeConfigAtomic(config => {
    const appId = options.appId ?? 'codex'
    const explicitManagement = config.apps[appId]?.profiles[options.profileId]?.management !== undefined
    const current = currentManagement(config, options)
    if (current.migrations?.legacyBrowserSourcesV2 === true) return config
    const sources = [...current.sources]
    const indexes = new Map(sources.map((source, index) => [source.url, index]))
    for (const input of migration.sources) {
      const source = normalizePluginManagementSource(input)
      const index = indexes.get(source.url)
      if (index === undefined) {
        indexes.set(source.url, sources.length)
        sources.push(source)
        continue
      }
      const currentSource = sources[index]!
      const mergedLocal = currentSource.local === undefined && source.local === undefined
        ? undefined
        : {
          ...source.local,
          ...currentSource.local,
        }
      sources[index] = {
        ...currentSource,
        ...(!explicitManagement ? { enabled: source.enabled } : {}),
        ...(mergedLocal === undefined ? {} : { local: mergedLocal }),
      }
    }
    migrated = true
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
