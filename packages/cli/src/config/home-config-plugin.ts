import {
  type JsonValue,
  jsonValue,
  nonEmptyString,
  PLUGIN_ID,
  portableId,
  record,
  rejectUnknownKeys,
} from './home-config-values.js'

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

export function parseHomeConfigPlugin(value: unknown, index: number): HomeConfigPlugin {
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
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
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
    'revision',
    'lastGoodRevision',
    'config',
    'lastGoodConfig',
    'restartRequired',
    'candidate',
  ], label)
  const revision = nonNegativeRevision(profile.revision, `${label}.revision`)
  const lastGoodRevision = nonNegativeRevision(profile.lastGoodRevision, `${label}.lastGoodRevision`)
  if (lastGoodRevision > revision) throw new Error(`${label}.lastGoodRevision must not exceed revision`)
  const pending = lastGoodRevision < revision
  if (pending) {
    if (profile.restartRequired !== true) {
      throw new Error(`${label}.restartRequired must be true while app restart is pending`)
    }
    if (profile.lastGoodConfig === undefined) {
      throw new Error(`${label}.lastGoodConfig is required while app restart is pending`)
    }
  } else if (profile.restartRequired !== undefined || profile.lastGoodConfig !== undefined) {
    throw new Error(`${label} must not retain app-restart state at last-good revision`)
  }
  return {
    revision,
    lastGoodRevision,
    config: jsonValue(profile.config, `${label}.config`),
    ...(pending
      ? {
        lastGoodConfig: jsonValue(profile.lastGoodConfig, `${label}.lastGoodConfig`),
        restartRequired: true as const,
      }
      : {}),
    ...(profile.candidate === undefined ? {} : {
      candidate: parsePluginServiceCandidate(profile.candidate, `${label}.candidate`, revision),
    }),
  }
}

function parsePluginService(value: unknown, label: string): HomeConfigPluginService {
  const service = record(value, label)
  rejectUnknownKeys(service, ['profiles'], label)
  const source = record(service.profiles, `${label}.profiles`)
  const profiles: Record<string, HomeConfigPluginServiceProfile> = Object.create(null) as Record<
    string,
    HomeConfigPluginServiceProfile
  >
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
