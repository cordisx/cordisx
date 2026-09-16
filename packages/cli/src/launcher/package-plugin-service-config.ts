import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HomeConfigPluginServiceProfile, JsonValue } from '../config/home-config.js'
import {
  ServiceConfigConflictError,
  type ServiceConfigScope,
  type StageServiceConfigInput,
} from '../config/service-config.js'
import type { HostServiceConfigPersistence } from './service-config.js'

interface StoredState {
  readonly version: 1
  readonly pluginId: string
  readonly serviceId: string
  readonly state: HomeConfigPluginServiceProfile
}

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OWNER_TOKEN = /^[a-f0-9]{64}$/
const queues = new Map<string, Promise<void>>()

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !permitted.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is not supported`)
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  if (value === null || typeof value !== 'object') throw new Error(`${label} is not JSON-compatible`)
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = jsonValue(item, `${label}.${key}`)
  }
  return output
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function serviceState(value: unknown, label: string): HomeConfigPluginServiceProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  const raw = value as Record<string, unknown>
  rejectUnknownKeys(raw, [
    'revision',
    'lastGoodRevision',
    'config',
    'lastGoodConfig',
    'restartRequired',
    'candidate',
  ], label)
  const record = raw as Partial<HomeConfigPluginServiceProfile>
  const revision = nonNegativeInteger(record.revision, `${label}.revision`)
  const lastGoodRevision = nonNegativeInteger(record.lastGoodRevision, `${label}.lastGoodRevision`)
  if (lastGoodRevision > revision) throw new Error(`${label}.lastGoodRevision is invalid`)
  const config = jsonValue(record.config, `${label}.config`)
  const candidate = record.candidate === undefined
    ? undefined
    : (() => {
      const item = record.candidate
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`${label}.candidate is invalid`)
      }
      rejectUnknownKeys(item as unknown as Record<string, unknown>, [
        'revision',
        'config',
        'applies',
        'ownerToken',
        'generation',
        'createdAt',
      ], `${label}.candidate`)
      if (item.applies !== 'service-restart' && item.applies !== 'app-restart') {
        throw new Error(`${label}.candidate.applies is invalid`)
      }
      if (
        !OWNER_TOKEN.test(item.ownerToken) || !GENERATION.test(item.generation)
        || Number.isNaN(Date.parse(item.createdAt))
      ) {
        throw new Error(`${label}.candidate ownership is invalid`)
      }
      const candidateRevision = nonNegativeInteger(item.revision, `${label}.candidate.revision`)
      if (candidateRevision !== revision + 1) throw new Error(`${label}.candidate.revision is invalid`)
      return {
        revision: candidateRevision,
        config: jsonValue(item.config, `${label}.candidate.config`),
        applies: item.applies,
        ownerToken: item.ownerToken,
        generation: item.generation,
        createdAt: item.createdAt,
      }
    })()
  const pendingRestart = lastGoodRevision < revision
  if (pendingRestart) {
    if (record.restartRequired !== true) throw new Error(`${label}.restartRequired is required`)
    if (record.lastGoodConfig === undefined) throw new Error(`${label}.lastGoodConfig is required`)
    return {
      revision,
      lastGoodRevision,
      config,
      lastGoodConfig: jsonValue(record.lastGoodConfig, `${label}.lastGoodConfig`),
      restartRequired: true,
      ...(candidate === undefined ? {} : { candidate }),
    }
  }
  if (record.restartRequired !== undefined || record.lastGoodConfig !== undefined) {
    throw new Error(`${label}.restart state is invalid`)
  }
  return { revision, lastGoodRevision, config, ...(candidate === undefined ? {} : { candidate }) }
}

async function publishAtomic(filePath: string, value: StoredState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
    published = true
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await unlink(temporary).catch(() => undefined)
  }
}

export class PackagePluginServiceConfigStore {
  readonly persistence: HostServiceConfigPersistence

  constructor(
    private readonly root: string,
    private readonly profileId: string,
    private readonly generation: string,
  ) {
    this.persistence = {
      read: async input => await this.read(input),
      stage: async input => await this.stage(input),
      commit: async input => await this.commit(input),
      abort: async input => await this.abort(input),
      markAppRestartApplied: async input => await this.markAppRestartApplied(input),
    }
  }

  private file(pluginId: string, serviceId: string): string {
    if (!LOCAL_ID.test(pluginId) || !LOCAL_ID.test(serviceId)) {
      throw new Error('package plugin service configuration identity is invalid')
    }
    return path.join(
      this.root,
      'state',
      'profiles',
      this.profileId,
      'plugins',
      'services',
      pluginId,
      `${serviceId}.json`,
    )
  }

  async read(input: {
    readonly profileId: string
    readonly pluginId: string
    readonly serviceId: string
    readonly initialConfig: JsonValue
  }): Promise<HomeConfigPluginServiceProfile> {
    this.assertProfile(input.profileId)
    const filePath = this.file(input.pluginId, input.serviceId)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { revision: 0, lastGoodRevision: 0, config: structuredClone(input.initialConfig) }
      }
      throw error
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('package plugin service configuration state is invalid')
    }
    const record = raw as Partial<StoredState>
    if (record.version !== 1 || record.pluginId !== input.pluginId || record.serviceId !== input.serviceId) {
      throw new Error('package plugin service configuration state is invalid')
    }
    const state = serviceState(record.state, 'package plugin service configuration')
    if (state.candidate !== undefined && state.candidate.generation !== this.generation) {
      const { candidate: _candidate, ...active } = state
      await publishAtomic(filePath, { version: 1, pluginId: input.pluginId, serviceId: input.serviceId, state: active })
      return structuredClone(active)
    }
    return structuredClone(state)
  }

  stage(input: StageServiceConfigInput): Promise<{ readonly candidateRevision: number }> {
    this.assertScope(input)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative safe integer')
    }
    return this.update(input, state => {
      if (state.revision !== input.expectedRevision || state.candidate !== undefined) {
        throw new ServiceConfigConflictError(state.revision)
      }
      const candidateRevision = input.expectedRevision + 1
      return {
        state: {
          ...state,
          candidate: {
            revision: candidateRevision,
            config: structuredClone(input.config),
            applies: input.applies,
            ownerToken: input.ownerToken,
            generation: input.generation,
            createdAt: (input.now ?? new Date()).toISOString(),
          },
        },
        result: { candidateRevision },
      }
    })
  }

  commit(
    input: ServiceConfigScope & {
      readonly candidateRevision: number
      readonly applies: 'service-restart' | 'app-restart'
      readonly initialConfig: JsonValue
    },
  ): Promise<HomeConfigPluginServiceProfile> {
    this.assertScope(input)
    return this.update(input, state => {
      const candidate = state.candidate
      if (
        candidate === undefined || candidate.revision !== input.candidateRevision
        || candidate.applies !== input.applies || candidate.ownerToken !== input.ownerToken
        || candidate.generation !== input.generation
      ) {
        throw new ServiceConfigConflictError(
          state.revision,
          'service configuration candidate is not owned by this generation',
        )
      }
      if (input.applies === 'service-restart' && state.restartRequired === true) {
        throw new ServiceConfigConflictError(state.revision, 'service configuration already requires an app restart')
      }
      const committed: HomeConfigPluginServiceProfile = input.applies === 'service-restart'
        ? { revision: candidate.revision, lastGoodRevision: candidate.revision, config: candidate.config }
        : {
          revision: candidate.revision,
          lastGoodRevision: state.lastGoodRevision,
          config: candidate.config,
          lastGoodConfig: state.lastGoodConfig ?? state.config,
          restartRequired: true,
        }
      return { state: committed, result: structuredClone(committed) }
    })
  }

  abort(
    input: ServiceConfigScope & {
      readonly candidateRevision: number
      readonly initialConfig: JsonValue
    },
  ): Promise<void> {
    this.assertScope(input)
    return this.update(input, state => {
      const candidate = state.candidate
      if (candidate === undefined) return { state, result: undefined }
      if (
        candidate.revision !== input.candidateRevision || candidate.ownerToken !== input.ownerToken
        || candidate.generation !== input.generation
      ) {
        throw new ServiceConfigConflictError(
          state.revision,
          'service configuration candidate is not owned by this generation',
        )
      }
      const { candidate: _candidate, ...active } = state
      return { state: active, result: undefined }
    })
  }

  markAppRestartApplied(input: {
    readonly profileId: string
    readonly pluginId: string
    readonly serviceId: string
    readonly expectedRevision: number
    readonly initialConfig: JsonValue
  }): Promise<HomeConfigPluginServiceProfile> {
    this.assertProfile(input.profileId)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative safe integer')
    }
    return this.update(input, state => {
      if (
        state.revision !== input.expectedRevision || state.restartRequired !== true || state.candidate !== undefined
      ) {
        throw new ServiceConfigConflictError(state.revision, 'service configuration app-restart state is stale')
      }
      const applied: HomeConfigPluginServiceProfile = {
        revision: state.revision,
        lastGoodRevision: state.revision,
        config: state.config,
      }
      return { state: applied, result: structuredClone(applied) }
    })
  }

  private assertProfile(profileId: string): void {
    if (profileId !== this.profileId) throw new Error('package plugin service configuration profile is stale')
  }

  private assertScope(scope: ServiceConfigScope): void {
    this.assertProfile(scope.profileId)
    if (scope.generation !== this.generation) {
      throw new Error('package plugin service configuration generation is stale')
    }
  }

  private async update<T>(
    input: Pick<StageServiceConfigInput, 'profileId' | 'pluginId' | 'serviceId' | 'initialConfig'>,
    operation: (
      state: HomeConfigPluginServiceProfile,
    ) => { readonly state: HomeConfigPluginServiceProfile; readonly result: T },
  ): Promise<T> {
    const filePath = this.file(input.pluginId, input.serviceId)
    const previous = queues.get(filePath) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    queues.set(filePath, tail)
    await previous.catch(() => undefined)
    try {
      const state = await this.read(input)
      const next = operation(state)
      await publishAtomic(filePath, {
        version: 1,
        pluginId: input.pluginId,
        serviceId: input.serviceId,
        state: next.state,
      })
      return next.result
    } finally {
      release()
      if (queues.get(filePath) === tail) queues.delete(filePath)
    }
  }
}
