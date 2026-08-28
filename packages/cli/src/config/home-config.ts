import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
  type CordisXPersistedPermissionPolicyRecord,
} from '../permission-persistence.js'

export type HomeDataMode = 'shared' | 'host-isolated'

/** Host-owned, profile-scoped icon-theme preference. Opaque handles are never durable. */
export interface HomeConfigIconThemePreference {
  readonly revision: number
  readonly providerId: `builtin:${string}` | `plugin:${string}:${string}`
  readonly namespace: string
  readonly providerVersion: string
  readonly providerGeneration: string
}

export interface HomeConfigPlugin {
  readonly id: string
  readonly entry: string
  readonly enabled?: boolean
  readonly config?: JsonValue
  /** Profile-scoped config created lazily from the legacy `config` fallback. */
  readonly profiles?: Readonly<Record<string, HomeConfigPluginProfile>>
  /** Host-only Node service configuration, independently scoped from renderer Config. */
  readonly services?: Readonly<Record<string, HomeConfigPluginService>>
}

export interface HomeConfigPluginCandidate {
  readonly revision: number
  readonly config: JsonValue
  readonly ownerToken: string
  readonly generation: string
  readonly createdAt: string
}

export interface HomeConfigPluginProfile {
  readonly revision: number
  readonly config: JsonValue
  readonly candidate?: HomeConfigPluginCandidate
}

export type HomeConfigServiceApplies = 'service-restart' | 'app-restart'

export interface HomeConfigPluginServiceCandidate {
  readonly revision: number
  readonly config: JsonValue
  readonly applies: HomeConfigServiceApplies
  readonly ownerToken: string
  readonly generation: string
  readonly createdAt: string
}

export interface HomeConfigPluginServiceProfile {
  readonly revision: number
  readonly lastGoodRevision: number
  readonly config: JsonValue
  /** Required only while an app-restart candidate is durable but not yet active. */
  readonly lastGoodConfig?: JsonValue
  readonly restartRequired?: true
  readonly candidate?: HomeConfigPluginServiceCandidate
}

export interface HomeConfigPluginService {
  readonly profiles: Readonly<Record<string, HomeConfigPluginServiceProfile>>
}

export interface HomeConfigProvider {
  readonly id: string
  readonly kind: 'cli-proxy-api'
  readonly displayName: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly codexExecutable?: string
  readonly dataDir?: string
  readonly enabled?: boolean
  readonly timeoutMs?: number
}

export interface HomeConfigProfile {
  readonly displayName: string
  readonly dataMode: HomeDataMode
  readonly iconTheme?: HomeConfigIconThemePreference
}

export interface HomeConfigApp {
  readonly defaultProfile: string
  readonly profiles: Readonly<Record<string, HomeConfigProfile>>
}

/** Registered publisher verification keys are Host-local, never catalog metadata. */
export interface HomeConfigPublisherGrantIssuer {
  readonly id: string
  readonly keyId: string
  readonly environment: 'sandbox' | 'live'
  /** Ed25519 SubjectPublicKeyInfo DER, base64url encoded. */
  readonly publicKeySpki: string
}

export interface HomeConfig {
  readonly version: 1
  readonly defaultApp: string
  readonly providers: readonly HomeConfigProvider[]
  readonly plugins: readonly HomeConfigPlugin[]
  readonly permissions: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly publisherGrantIssuers: readonly HomeConfigPublisherGrantIssuer[]
  readonly apps: Readonly<Record<string, HomeConfigApp>>
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
  readonly [key: string]: JsonValue
}

export interface HomeConfigPathOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly homedir?: string
}

export interface HomeConfigWriteOptions extends HomeConfigPathOptions {
  /** Maximum time spent waiting for another writer before failing. */
  readonly lockTimeoutMs?: number
  /** Delay between attempts to acquire the writer lock. */
  readonly lockRetryMs?: number
  /** Age at which an unreleased writer lock is diagnosed as stale. */
  readonly lockStaleMs?: number
}

const APP_OR_PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const ICON_PROVIDER_ID = /^(?:builtin:[a-z0-9][a-z0-9._-]{0,63}|plugin:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63})$/
const ICON_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ICON_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const DEFAULT_LOCK_RETRY_MS = 25
const DEFAULT_LOCK_STALE_MS = 30_000

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

function portableId(value: unknown, label: string): string {
  const id = nonEmptyString(value, label)
  if (!APP_OR_PROFILE_ID.test(id)) {
    throw new Error(`${label} must match ${APP_OR_PROFILE_ID.source}`)
  }
  return id
}

function jsonValue(value: unknown, label: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`)
    return value
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, seen))
    }
    const source = value as Record<string, unknown>
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, entry] of Object.entries(source)) {
      result[key] = jsonValue(entry, `${label}.${key}`, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function parsePlugin(value: unknown, index: number): HomeConfigPlugin {
  const label = `config.plugins[${index}]`
  const plugin = record(value, label)
  rejectUnknownKeys(plugin, ['id', 'entry', 'enabled', 'config', 'profiles', 'services'], label)
  const id = nonEmptyString(plugin.id, `${label}.id`)
  if (!PLUGIN_ID.test(id)) throw new Error(`${label}.id is invalid: ${id}`)
  if (id === 'host' || id.startsWith('cordisx.')) throw new Error(`${label}.id is reserved: ${id}`)
  const entry = nonEmptyString(plugin.entry, `${label}.entry`)
  if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`)
  }
  let profiles: Record<string, HomeConfigPluginProfile> | undefined
  if (plugin.profiles !== undefined) {
    const source = record(plugin.profiles, `${label}.profiles`)
    profiles = Object.create(null) as Record<string, HomeConfigPluginProfile>
    for (const [profileId, rawProfile] of Object.entries(source)) {
      portableId(profileId, `${label}.profiles profile id`)
      profiles[profileId] = parsePluginProfile(rawProfile, `${label}.profiles.${profileId}`)
    }
  }
  let services: Record<string, HomeConfigPluginService> | undefined
  if (plugin.services !== undefined) {
    const source = record(plugin.services, `${label}.services`)
    services = Object.create(null) as Record<string, HomeConfigPluginService>
    for (const [serviceId, rawService] of Object.entries(source)) {
      if (!PLUGIN_ID.test(serviceId)) throw new Error(`${label}.services service id is invalid: ${serviceId}`)
      services[serviceId] = parsePluginService(rawService, `${label}.services.${serviceId}`)
    }
  }
  return {
    id,
    entry,
    ...(plugin.enabled === undefined ? {} : { enabled: plugin.enabled }),
    ...(plugin.config === undefined ? {} : { config: jsonValue(plugin.config, `${label}.config`) }),
    ...(profiles === undefined ? {} : { profiles }),
    ...(services === undefined ? {} : { services }),
  }
}

function nonNegativeRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value as number
}

function parsePluginServiceCandidate(
  value: unknown,
  label: string,
  revision: number,
): HomeConfigPluginServiceCandidate {
  const candidate = record(value, label)
  rejectUnknownKeys(candidate, ['revision', 'config', 'applies', 'ownerToken', 'generation', 'createdAt'], label)
  if (candidate.revision !== revision + 1) throw new Error(`${label}.revision must equal revision + 1`)
  if (candidate.applies !== 'service-restart' && candidate.applies !== 'app-restart') {
    throw new Error(`${label}.applies must be service-restart or app-restart`)
  }
  if (typeof candidate.ownerToken !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.ownerToken)) {
    throw new Error(`${label}.ownerToken must be a 64-character lowercase hex token`)
  }
  if (typeof candidate.generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.generation)) {
    throw new Error(`${label}.generation is invalid`)
  }
  if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) {
    throw new Error(`${label}.createdAt must be an ISO timestamp`)
  }
  return {
    revision: candidate.revision,
    config: jsonValue(candidate.config, `${label}.config`),
    applies: candidate.applies,
    ownerToken: candidate.ownerToken,
    generation: candidate.generation,
    createdAt: candidate.createdAt,
  }
}

function parsePluginServiceProfile(value: unknown, label: string): HomeConfigPluginServiceProfile {
  const profile = record(value, label)
  rejectUnknownKeys(profile, [
    'revision', 'lastGoodRevision', 'config', 'lastGoodConfig', 'restartRequired', 'candidate',
  ], label)
  const revision = nonNegativeRevision(profile.revision, `${label}.revision`)
  const lastGoodRevision = nonNegativeRevision(profile.lastGoodRevision, `${label}.lastGoodRevision`)
  if (lastGoodRevision > revision) throw new Error(`${label}.lastGoodRevision must not exceed revision`)
  const pending = lastGoodRevision < revision
  if (pending) {
    if (profile.restartRequired !== true) throw new Error(`${label}.restartRequired must be true while app restart is pending`)
    if (profile.lastGoodConfig === undefined) throw new Error(`${label}.lastGoodConfig is required while app restart is pending`)
  } else if (profile.restartRequired !== undefined || profile.lastGoodConfig !== undefined) {
    throw new Error(`${label} must not retain app-restart state at last-good revision`)
  }
  return {
    revision,
    lastGoodRevision,
    config: jsonValue(profile.config, `${label}.config`),
    ...(pending ? {
      lastGoodConfig: jsonValue(profile.lastGoodConfig, `${label}.lastGoodConfig`),
      restartRequired: true as const,
    } : {}),
    ...(profile.candidate === undefined ? {} : {
      candidate: parsePluginServiceCandidate(profile.candidate, `${label}.candidate`, revision),
    }),
  }
}

function parsePluginService(value: unknown, label: string): HomeConfigPluginService {
  const service = record(value, label)
  rejectUnknownKeys(service, ['profiles'], label)
  const source = record(service.profiles, `${label}.profiles`)
  const profiles: Record<string, HomeConfigPluginServiceProfile> = Object.create(null) as Record<string, HomeConfigPluginServiceProfile>
  for (const [profileId, rawProfile] of Object.entries(source)) {
    portableId(profileId, `${label}.profiles profile id`)
    profiles[profileId] = parsePluginServiceProfile(rawProfile, `${label}.profiles.${profileId}`)
  }
  return { profiles }
}

function parsePluginProfile(value: unknown, label: string): HomeConfigPluginProfile {
  const profile = record(value, label)
  rejectUnknownKeys(profile, ['revision', 'config', 'candidate'], label)
  if (!Number.isInteger(profile.revision) || (profile.revision as number) < 0) {
    throw new Error(`${label}.revision must be a non-negative integer`)
  }
  if (profile.config === undefined) throw new Error(`${label}.config is required`)
  const revision = profile.revision as number
  let candidate: HomeConfigPluginCandidate | undefined
  if (profile.candidate !== undefined) {
    const raw = record(profile.candidate, `${label}.candidate`)
    rejectUnknownKeys(raw, ['revision', 'config', 'ownerToken', 'generation', 'createdAt'], `${label}.candidate`)
    if (raw.revision !== revision + 1) throw new Error(`${label}.candidate.revision must equal revision + 1`)
    if (typeof raw.ownerToken !== 'string' || !/^[a-f0-9]{64}$/.test(raw.ownerToken)) {
      throw new Error(`${label}.candidate.ownerToken must be a 64-character lowercase hex token`)
    }
    if (typeof raw.generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.generation)) {
      throw new Error(`${label}.candidate.generation is invalid`)
    }
    if (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt))) {
      throw new Error(`${label}.candidate.createdAt must be an ISO timestamp`)
    }
    candidate = {
      revision: raw.revision,
      config: jsonValue(raw.config, `${label}.candidate.config`),
      ownerToken: raw.ownerToken,
      generation: raw.generation,
      createdAt: raw.createdAt,
    }
  }
  return {
    revision,
    config: jsonValue(profile.config, `${label}.config`),
    ...(candidate === undefined ? {} : { candidate }),
  }
}

function parseProvider(value: unknown, index: number): HomeConfigProvider {
  const label = `config.providers[${index}]`
  const provider = record(value, label)
  rejectUnknownKeys(provider, [
    'id', 'kind', 'displayName', 'baseUrl', 'apiKeyEnv', 'codexExecutable', 'dataDir', 'enabled', 'timeoutMs',
  ], label)
  const id = nonEmptyString(provider.id, `${label}.id`)
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) throw new Error(`${label}.id is invalid: ${id}`)
  if (provider.kind !== 'cli-proxy-api') throw new Error(`${label}.kind must be cli-proxy-api`)
  const displayName = nonEmptyString(provider.displayName, `${label}.displayName`)
  const baseUrl = nonEmptyString(provider.baseUrl, `${label}.baseUrl`)
  const apiKeyEnv = nonEmptyString(provider.apiKeyEnv, `${label}.apiKeyEnv`)
  if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
  if (provider.timeoutMs !== undefined && !Number.isInteger(provider.timeoutMs)) throw new Error(`${label}.timeoutMs must be an integer`)
  return {
    id,
    kind: 'cli-proxy-api',
    displayName,
    baseUrl,
    apiKeyEnv,
    ...(provider.codexExecutable === undefined ? {} : { codexExecutable: nonEmptyString(provider.codexExecutable, `${label}.codexExecutable`) }),
    ...(provider.dataDir === undefined ? {} : { dataDir: nonEmptyString(provider.dataDir, `${label}.dataDir`) }),
    ...(provider.enabled === undefined ? {} : { enabled: provider.enabled }),
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs as number }),
  }
}

function parseIconThemePreference(value: unknown): HomeConfigIconThemePreference | undefined {
  // A corrupted optional preference must not make the whole Host profile
  // unavailable. Discard it atomically and let the pinned Reicon default win.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const preference = value as Record<string, unknown>
  if (Object.keys(preference).sort().join(',') !== 'namespace,providerGeneration,providerId,providerVersion,revision'
    || !Number.isSafeInteger(preference.revision) || (preference.revision as number) < 1
    || typeof preference.providerId !== 'string' || !ICON_PROVIDER_ID.test(preference.providerId)
    || typeof preference.namespace !== 'string' || !ICON_NAMESPACE.test(preference.namespace)
    || typeof preference.providerVersion !== 'string' || !SEMVER.test(preference.providerVersion)
    || typeof preference.providerGeneration !== 'string' || !ICON_GENERATION.test(preference.providerGeneration)) return undefined
  return {
    revision: preference.revision as number,
    providerId: preference.providerId as HomeConfigIconThemePreference['providerId'],
    namespace: preference.namespace,
    providerVersion: preference.providerVersion,
    providerGeneration: preference.providerGeneration,
  }
}

function parseProfile(value: unknown, label: string): HomeConfigProfile {
  const profile = record(value, label)
  rejectUnknownKeys(profile, ['displayName', 'dataMode', 'iconTheme'], label)
  const displayName = nonEmptyString(profile.displayName, `${label}.displayName`)
  if (profile.dataMode !== 'shared' && profile.dataMode !== 'host-isolated' && profile.dataMode !== 'isolated') {
    throw new Error(`${label}.dataMode must be shared or host-isolated`)
  }
  // `isolated` was the v1 spelling for an opt-in private Host root. Reading it
  // does not rewrite the file; later writes use the explicit current spelling.
  const iconTheme = parseIconThemePreference(profile.iconTheme)
  return {
    displayName,
    dataMode: profile.dataMode === 'isolated' ? 'host-isolated' : profile.dataMode,
    ...(iconTheme === undefined ? {} : { iconTheme }),
  }
}

function parseApp(value: unknown, label: string): HomeConfigApp {
  const app = record(value, label)
  rejectUnknownKeys(app, ['defaultProfile', 'profiles'], label)
  const defaultProfile = portableId(app.defaultProfile, `${label}.defaultProfile`)
  const rawProfiles = record(app.profiles, `${label}.profiles`)
  const profiles: Record<string, HomeConfigProfile> = Object.create(null) as Record<string, HomeConfigProfile>
  for (const [profileId, rawProfile] of Object.entries(rawProfiles)) {
    portableId(profileId, `${label}.profiles profile id`)
    profiles[profileId] = parseProfile(rawProfile, `${label}.profiles.${profileId}`)
  }
  if (!Object.hasOwn(profiles, defaultProfile)) {
    throw new Error(`${label}.defaultProfile references missing profile: ${defaultProfile}`)
  }
  return { defaultProfile, profiles }
}

function parsePublisherGrantIssuer(value: unknown, index: number): HomeConfigPublisherGrantIssuer {
  const label = `config.publisherGrantIssuers[${index}]`
  const issuer = record(value, label)
  rejectUnknownKeys(issuer, ['id', 'keyId', 'environment', 'publicKeySpki'], label)
  const id = nonEmptyString(issuer.id, `${label}.id`)
  const keyId = nonEmptyString(issuer.keyId, `${label}.keyId`)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label}.id is invalid`)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new Error(`${label}.keyId is invalid`)
  if (issuer.environment !== 'sandbox' && issuer.environment !== 'live') throw new Error(`${label}.environment is invalid`)
  const publicKeySpki = nonEmptyString(issuer.publicKeySpki, `${label}.publicKeySpki`)
  if (!/^[A-Za-z0-9_-]+$/.test(publicKeySpki)) throw new Error(`${label}.publicKeySpki must be base64url`)
  return { id, keyId, environment: issuer.environment, publicKeySpki }
}

/** Strictly validate and normalize a version-1 CordisX home configuration. */
export function parseHomeConfig(value: unknown): HomeConfig {
  const config = record(value, 'config')
  rejectUnknownKeys(config, ['version', 'defaultApp', 'providers', 'plugins', 'permissions', 'publisherGrantIssuers', 'apps'], 'config')
  if (config.version !== 1) throw new Error('config.version must be 1')
  const defaultApp = portableId(config.defaultApp, 'config.defaultApp')
  if (config.providers !== undefined && !Array.isArray(config.providers)) throw new Error('config.providers must be an array')
  const seenProviders = new Set<string>()
  const providers = (config.providers ?? []).map((value, index) => {
    const provider = parseProvider(value, index)
    if (seenProviders.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`)
    seenProviders.add(provider.id)
    return provider
  })
  if (!Array.isArray(config.plugins)) throw new Error('config.plugins must be an array')
  const seenPlugins = new Set<string>()
  const plugins = config.plugins.map((value, index) => {
    const plugin = parsePlugin(value, index)
    if (seenPlugins.has(plugin.id)) throw new Error(`duplicate plugin id: ${plugin.id}`)
    seenPlugins.add(plugin.id)
    return plugin
  })
  if (config.permissions !== undefined && !Array.isArray(config.permissions)) throw new Error('config.permissions must be an array')
  const seenPermissions = new Set<string>()
  const permissions = (config.permissions ?? []).map((value, index) => {
    const policy = normalizePersistedPermissionPolicyRecord(value, `config.permissions[${index}]`)
    const key = persistedPermissionRecordKey(policy)
    if (seenPermissions.has(key)) throw new Error(`duplicate permission policy key at config.permissions[${index}]`)
    seenPermissions.add(key)
    return policy
  })
  if (config.publisherGrantIssuers !== undefined && !Array.isArray(config.publisherGrantIssuers)) throw new Error('config.publisherGrantIssuers must be an array')
  const publisherGrantIssuers = (config.publisherGrantIssuers ?? []).map(parsePublisherGrantIssuer)
  const seenIssuerKeys = new Set<string>()
  for (const issuer of publisherGrantIssuers) {
    const key = `${issuer.environment}:${issuer.id}:${issuer.keyId}`
    if (seenIssuerKeys.has(key)) throw new Error(`duplicate PublisherGrant issuer key: ${key}`)
    seenIssuerKeys.add(key)
  }
  const rawApps = record(config.apps, 'config.apps')
  const apps: Record<string, HomeConfigApp> = Object.create(null) as Record<string, HomeConfigApp>
  for (const [appId, rawApp] of Object.entries(rawApps)) {
    portableId(appId, 'config.apps app id')
    apps[appId] = parseApp(rawApp, `config.apps.${appId}`)
  }
  if (!Object.hasOwn(apps, defaultApp)) throw new Error(`config.defaultApp references missing app: ${defaultApp}`)
  return { version: 1, defaultApp, providers, plugins, permissions, publisherGrantIssuers, apps }
}

/** Return a new deterministic configuration for first launch or non-interactive setup. */
export function createDefaultHomeConfig(): HomeConfig {
  return {
    version: 1,
    defaultApp: 'codex',
    providers: [],
    plugins: [],
    permissions: [],
    publisherGrantIssuers: [],
    apps: {
      codex: {
        defaultProfile: 'default',
        profiles: {
          default: {
            displayName: 'Default',
            dataMode: 'shared',
          },
        },
      },
    },
  }
}

/** Resolve `${CORDISX_HOME || ~/.cordisx}/config.json` without consulting the cwd. */
export function resolveHomeConfigPath(options: HomeConfigPathOptions = {}): string {
  if (options.configPath !== undefined) return path.resolve(options.configPath)
  const env = options.env ?? process.env
  const configuredHome = env.CORDISX_HOME?.trim()
  if (configuredHome !== undefined && configuredHome !== '' && !path.isAbsolute(configuredHome)) {
    throw new Error('CORDISX_HOME must be an absolute path')
  }
  const root = configuredHome === undefined || configuredHome === ''
    ? path.join(options.homedir ?? os.homedir(), '.cordisx')
    : configuredHome
  return path.resolve(root, 'config.json')
}

function normalizeOptions(options: string | HomeConfigWriteOptions | undefined): HomeConfigWriteOptions {
  return typeof options === 'string' ? { configPath: options } : (options ?? {})
}

async function readValidated(configPath: string): Promise<HomeConfig> {
  let text: string
  try {
    const pathStat = await lstat(configPath)
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error(`home config target must be a regular file, not a symbolic link or directory: ${configPath}`)
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(configPath, constants.O_RDONLY | noFollow)
    try {
      const openedStat = await handle.stat()
      if (!openedStat.isFile()) {
        throw new Error(`home config target must be a regular file: ${configPath}`)
      }
      if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
        throw new Error(`home config target changed while being opened: ${configPath}`)
      }
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    if (error instanceof Error && error.message.startsWith('home config target ')) throw error
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`home config target must not be a symbolic link: ${configPath}`, { cause: error })
    }
    throw new Error(`failed to read home config at ${configPath}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`invalid JSON in home config at ${configPath}`, { cause: error })
  }
  try {
    return parseHomeConfig(parsed)
  } catch (error) {
    throw new Error(`invalid home config at ${configPath}: ${(error as Error).message}`, { cause: error })
  }
}

/** Load an existing home configuration without creating or mutating it. */
export async function loadHomeConfig(options?: string | HomeConfigPathOptions): Promise<HomeConfig> {
  const normalized = typeof options === 'string' ? { configPath: options } : (options ?? {})
  return readValidated(resolveHomeConfigPath(normalized))
}

interface PrivateDirectoryPolicy {
  readonly allowTightenExisting: boolean
  /** Explicit CORDISX_HOME must be owned before CordisX changes its mode. */
  readonly requireCurrentUserOwnership: boolean
}

async function ensurePrivateDirectory(directory: string, policy: PrivateDirectoryPolicy): Promise<void> {
  let created: string | undefined
  try {
    created = await mkdir(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(`failed to create CordisX home directory: ${directory}`, { cause: error })
  }
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`CordisX home must be a real directory, not a symbolic link: ${directory}`)
  }
  if (created !== undefined) {
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    return
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    if (policy.allowTightenExisting) {
      if (policy.requireCurrentUserOwnership) {
        const uid = process.getuid?.()
        if (uid === undefined || metadata.uid !== uid) {
          throw new Error(`CordisX home must be owned by the current user before CordisX can make it private: ${directory}`)
        }
      }
      await chmod(directory, 0o700)
      return
    }
    throw new Error(`CordisX home must already be private (0700): ${directory}`)
  }
}

/** Validate or create the selected CordisX home without creating config.json. */
export async function ensureCordisXHomeDirectory(options: HomeConfigPathOptions = {}): Promise<string> {
  const directory = path.dirname(resolveHomeConfigPath(options))
  await ensurePrivateDirectory(directory, privateDirectoryPolicy(options))
  return directory
}

function privateDirectoryPolicy(options: HomeConfigWriteOptions): PrivateDirectoryPolicy {
  if (options.configPath !== undefined) {
    return { allowTightenExisting: false, requireCurrentUserOwnership: false }
  }
  const env = options.env ?? process.env
  const override = env.CORDISX_HOME?.trim()
  if (override === undefined || override === '') {
    return { allowTightenExisting: true, requireCurrentUserOwnership: false }
  }
  return { allowTightenExisting: true, requireCurrentUserOwnership: true }
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`)
  return value
}

async function acquireLock(configPath: string, options: HomeConfigWriteOptions): Promise<{
  readonly release: () => Promise<void>
}> {
  const lockPath = `${configPath}.lock`
  const timeoutMs = positiveDuration(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs')
  const retryMs = positiveDuration(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, 'lockRetryMs')
  const staleMs = positiveDuration(options.lockStaleMs, DEFAULT_LOCK_STALE_MS, 'lockStaleMs')
  const startedAt = Date.now()
  for (;;) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
        throw error
      }
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          await handle.close()
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        },
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException
      if (fsError.code !== 'EEXIST') throw error
      try {
        const lockStat = await stat(lockPath)
        const ageMs = Math.max(0, Date.now() - lockStat.mtimeMs)
        if (ageMs >= staleMs) {
          throw new Error(`home config lock appears stale (${Math.round(ageMs)}ms old): ${lockPath}`)
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for home config lock: ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function publishAtomic(configPath: string, config: HomeConfig): Promise<void> {
  const directory = path.dirname(configPath)
  const temporaryPath = path.join(directory, `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    try {
      const targetStat = await lstat(configPath)
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error(`refusing to replace non-regular home config target: ${configPath}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(temporaryPath, configPath)
    published = true
    await chmod(configPath, 0o600)
    await syncDirectory(directory)
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await unlink(temporaryPath).catch(() => undefined)
  }
}

/**
 * Load the validated home configuration, creating deterministic defaults once
 * when it is absent. Existing invalid content is never replaced.
 */
export async function ensureHomeConfig(options?: string | HomeConfigWriteOptions): Promise<HomeConfig> {
  const normalized = normalizeOptions(options)
  const configPath = resolveHomeConfigPath(normalized)
  await ensureCordisXHomeDirectory(normalized)
  const lock = await acquireLock(configPath, normalized)
  try {
    try {
      const existing = await readValidated(configPath)
      await chmod(configPath, 0o600)
      return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const initial = createDefaultHomeConfig()
    await publishAtomic(configPath, initial)
    return initial
  } finally {
    await lock.release()
  }
}

/**
 * Serialize a read-modify-write operation across CordisX processes. The
 * updater may be asynchronous; its result is strictly revalidated before the
 * original file is atomically replaced.
 */
export async function updateHomeConfigAtomic(
  updater: (current: HomeConfig) => HomeConfig | Promise<HomeConfig>,
  options?: string | HomeConfigWriteOptions,
): Promise<HomeConfig> {
  const normalized = normalizeOptions(options)
  const configPath = resolveHomeConfigPath(normalized)
  await ensureCordisXHomeDirectory(normalized)
  const lock = await acquireLock(configPath, normalized)
  try {
    let current: HomeConfig
    try {
      current = await readValidated(configPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      current = createDefaultHomeConfig()
    }
    const updated = parseHomeConfig(await updater(current))
    await publishAtomic(configPath, updated)
    return updated
  } finally {
    await lock.release()
  }
}
