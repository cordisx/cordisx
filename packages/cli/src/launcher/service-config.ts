import {
  abortServiceConfigCandidate,
  commitServiceConfigCandidate,
  readServiceConfigState,
  ServiceConfigConflictError,
  stageServiceConfigCandidate,
} from '../config/service-config.js'
import type { HomeConfigServiceApplies, JsonValue } from '../config/home-config.js'

export type HostSecretState = 'missing' | 'ready' | 'unavailable'
export type HostServiceConfigPermission = 'read' | 'write'

export interface HostServiceConfigIdentity {
  readonly source: string
  readonly pluginId: string
  readonly serviceId: string
}

export interface HostServiceConfigSchema {
  readonly id: string
  readonly projection:
    | { readonly kind: 'schemastery'; readonly envelope: Readonly<Record<string, JsonValue>> }
    | { readonly kind: 'standard'; readonly renderable: false }
}

export interface HostServiceConfigSecretSlot {
  readonly path: readonly string[]
  readonly set: boolean
}

export interface HostServiceConfigProjection {
  readonly configuration: JsonValue
  readonly secrets: readonly HostServiceConfigSecretSlot[]
}

export interface HostServiceConfigContract {
  readonly identity: HostServiceConfigIdentity
  readonly schema: HostServiceConfigSchema
  readonly configApplies: HomeConfigServiceApplies
  readonly initialConfiguration: JsonValue
  parseStored(value: unknown): JsonValue
  normalizeMutation(value: unknown, current: JsonValue): JsonValue
  project(value: JsonValue, secretState: (secretRef: string | undefined) => HostSecretState): HostServiceConfigProjection
}

export interface HostServiceConfigDescriptor {
  readonly contract: 'cordisx.service-config-descriptor/v1'
  readonly schemaVersion: 1
  readonly identity: HostServiceConfigIdentity
  readonly scope: { readonly profileId: string; readonly generation: string }
  readonly schema: HostServiceConfigSchema
  readonly revision: number
  readonly lastGoodRevision: number
  readonly configApplies: HomeConfigServiceApplies
  readonly writable: boolean
  readonly restartRequired: boolean
  readonly configuration: JsonValue
  readonly activeConfiguration?: JsonValue
  readonly secrets: readonly HostServiceConfigSecretSlot[]
}

export interface HostServiceConfigMutation {
  readonly contract: 'cordisx.service-config-mutation/v1'
  readonly schemaVersion: 1
  readonly identity: HostServiceConfigIdentity
  readonly scope: { readonly profileId: string; readonly generation: string }
  readonly expectedRevision: number
  readonly configuration: JsonValue
}

export type HostServiceConfigErrorCode =
  | 'stale-generation'
  | 'conflict'
  | 'permission-denied'
  | 'validation-failed'
  | 'persistence-failed'
  | 'service-restart-failed'
  | 'secret-ref-failed'
  | 'disposed'

export type HostServiceConfigMutationResult = {
  readonly contract: 'cordisx.service-config-result/v1'
  readonly schemaVersion: 1
  readonly identity: HostServiceConfigIdentity
  readonly scope: { readonly profileId: string; readonly generation: string }
  readonly revision: number
} & (
  | {
    readonly status: 'applied'
    readonly configApplies: 'service-restart'
    readonly serviceGeneration: string
  }
  | {
    readonly status: 'staged'
    readonly configApplies: 'app-restart'
  }
  | {
    readonly status: 'conflict' | 'rejected'
    readonly error: { readonly code: HostServiceConfigErrorCode; readonly message: string }
  }
)

export interface HostServiceConfigNarrowApiOptions {
  readonly contract: HostServiceConfigContract
  readonly profileId: string
  readonly generation: string
  readonly ownerToken: string
  readonly configPath: string
  readonly writable: boolean
  readonly authorize: (
    permission: HostServiceConfigPermission,
    identity: HostServiceConfigIdentity,
    scope: { readonly profileId: string; readonly generation: string },
  ) => boolean | Promise<boolean>
  readonly secretState?: (secretRef: string | undefined) => HostSecretState
  readonly restartService?: (candidate: JsonValue) => Promise<{
    readonly generation: string
    readonly rollback: () => Promise<void>
  }>
  readonly persistence?: HostServiceConfigPersistence
}

export interface HostServiceConfigPersistence {
  readonly read: typeof readServiceConfigState
  readonly stage: typeof stageServiceConfigCandidate
  readonly commit: typeof commitServiceConfigCandidate
  readonly abort: typeof abortServiceConfigCandidate
}

const DEFAULT_PERSISTENCE: HostServiceConfigPersistence = Object.freeze({
  read: readServiceConfigState,
  stage: stageServiceConfigCandidate,
  commit: commitServiceConfigCandidate,
  abort: abortServiceConfigCandidate,
})

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OWNER_TOKEN = /^[a-f0-9]{64}$/

function canonicalSource(value: string): string {
  let source: URL
  try {
    source = new URL(value)
  } catch {
    throw new Error('service configuration source must be a canonical file or HTTPS URL')
  }
  if ((source.protocol !== 'file:' && source.protocol !== 'https:') || source.search !== '' || source.hash !== '') {
    throw new Error('service configuration source must be a canonical file or HTTPS URL')
  }
  return source.href
}

function freeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen)
  return Object.freeze(value)
}

function immutable<T>(value: T): T {
  return freeze(structuredClone(value))
}

function boundedMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.slice(0, 1_000) || 'service configuration request failed'
}

function errorCode(error: unknown): HostServiceConfigErrorCode {
  if (!(error instanceof Error)) return 'validation-failed'
  if (error.message.includes('generation') || error.message.includes('scope is stale')) return 'stale-generation'
  if (error.message.startsWith('service restart failed:')) return 'service-restart-failed'
  if (error.message.startsWith('secret reference failed:')) return 'secret-ref-failed'
  if (error.message.startsWith('failed to persist service configuration:')) return 'persistence-failed'
  return 'validation-failed'
}

export class HostServiceConfigNarrowApi {
  private readonly identity: HostServiceConfigIdentity
  private readonly schema: HostServiceConfigSchema
  private readonly initialConfiguration: JsonValue
  private readonly scope: { readonly profileId: string; readonly generation: string }
  private readonly persistence: HostServiceConfigPersistence
  private disposed = false

  constructor(private readonly options: HostServiceConfigNarrowApiOptions) {
    if (!PROFILE_ID.test(options.profileId)) throw new Error('invalid service configuration profile id')
    if (!GENERATION.test(options.generation)) throw new Error('invalid service configuration generation')
    if (!OWNER_TOKEN.test(options.ownerToken)) throw new Error('invalid service configuration owner token')
    if (!LOCAL_ID.test(options.contract.identity.pluginId) || !LOCAL_ID.test(options.contract.identity.serviceId)) {
      throw new Error('invalid service configuration identity')
    }
    if (options.contract.configApplies === 'service-restart' && options.restartService === undefined) {
      throw new Error('service-restart configuration requires an owning service restart callback')
    }
    this.identity = immutable({
      source: canonicalSource(options.contract.identity.source),
      pluginId: options.contract.identity.pluginId,
      serviceId: options.contract.identity.serviceId,
    })
    this.schema = immutable({
      id: canonicalSource(options.contract.schema.id),
      projection: options.contract.schema.projection,
    })
    this.scope = immutable({ profileId: options.profileId, generation: options.generation })
    this.initialConfiguration = options.contract.parseStored(options.contract.initialConfiguration)
    this.persistence = options.persistence ?? DEFAULT_PERSISTENCE
  }

  async descriptor(): Promise<HostServiceConfigDescriptor> {
    this.assertActive()
    if (!await this.authorized('read')) throw new Error('service configuration read permission was denied')
    const state = await this.persistence.read({
      profileId: this.options.profileId,
      pluginId: this.identity.pluginId,
      serviceId: this.identity.serviceId,
      initialConfig: this.initialConfiguration,
    }, this.options.configPath)
    const desired = this.project(this.options.contract.parseStored(state.config))
    const active = state.restartRequired === true && state.lastGoodConfig !== undefined
      ? this.project(this.options.contract.parseStored(state.lastGoodConfig))
      : undefined
    return immutable({
      contract: 'cordisx.service-config-descriptor/v1',
      schemaVersion: 1,
      identity: this.identity,
      scope: this.scope,
      schema: this.schema,
      revision: state.revision,
      lastGoodRevision: state.lastGoodRevision,
      configApplies: this.options.contract.configApplies,
      writable: this.options.writable && await this.authorized('write'),
      restartRequired: state.restartRequired === true,
      configuration: desired.configuration,
      ...(active === undefined ? {} : { activeConfiguration: active.configuration }),
      secrets: desired.secrets,
    })
  }

  async mutate(request: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult> {
    const base = {
      contract: 'cordisx.service-config-result/v1' as const,
      schemaVersion: 1 as const,
      identity: this.identity,
      scope: this.scope,
    }
    let actualRevision = 0
    try {
      this.assertActive()
      this.assertRequest(request)
      if (!this.options.writable || !await this.authorized('write')) {
        return immutable({
          ...base,
          status: 'rejected',
          revision: 0,
          error: { code: 'permission-denied', message: 'Service configuration write permission was denied.' },
        })
      }
      const state = await this.persistence.read({
        profileId: this.options.profileId,
        pluginId: this.identity.pluginId,
        serviceId: this.identity.serviceId,
        initialConfig: this.initialConfiguration,
      }, this.options.configPath)
      actualRevision = state.revision
      if (state.revision !== request.expectedRevision || state.candidate !== undefined) {
        throw new ServiceConfigConflictError(state.revision)
      }
      const current = this.options.contract.parseStored(state.config)
      const candidate = this.options.contract.normalizeMutation(request.configuration, current)
      const applies = this.options.contract.configApplies
      const staged = await this.persist(async () => await this.persistence.stage({
          profileId: this.options.profileId,
          pluginId: this.identity.pluginId,
          serviceId: this.identity.serviceId,
          generation: this.options.generation,
          ownerToken: this.options.ownerToken,
          expectedRevision: request.expectedRevision,
          config: candidate,
          applies,
          initialConfig: this.initialConfiguration,
        }, this.options.configPath))
      const candidateScope = {
        profileId: this.options.profileId,
        pluginId: this.identity.pluginId,
        serviceId: this.identity.serviceId,
        generation: this.options.generation,
        ownerToken: this.options.ownerToken,
        candidateRevision: staged.candidateRevision,
        initialConfig: this.initialConfiguration,
      }
      if (applies === 'app-restart') {
        let committed: Awaited<ReturnType<typeof commitServiceConfigCandidate>>
        try {
          committed = await this.persist(async () => await this.persistence.commit(
            { ...candidateScope, applies },
            this.options.configPath,
          ))
        } catch (error) {
          await this.persistence.abort(candidateScope, this.options.configPath).catch(() => undefined)
          throw error
        }
        return immutable({ ...base, status: 'staged', revision: committed.revision, configApplies: applies })
      }
      let restarted: Awaited<ReturnType<NonNullable<HostServiceConfigNarrowApiOptions['restartService']>>>
      try {
        restarted = await this.options.restartService!(candidate)
        if (!GENERATION.test(restarted.generation)) throw new Error('service restart returned an invalid generation')
      } catch (error) {
        await this.persist(async () => await this.persistence.abort(candidateScope, this.options.configPath))
        throw new Error(`service restart failed: ${boundedMessage(error)}`)
      }
      let committed: Awaited<ReturnType<typeof commitServiceConfigCandidate>>
      try {
        committed = await this.persist(async () => await this.persistence.commit(
          { ...candidateScope, applies },
          this.options.configPath,
        ))
      } catch (error) {
        await restarted.rollback().catch(rollbackError => {
          throw new Error(`failed to persist service configuration; rollback failed: ${boundedMessage(rollbackError)}`)
        })
        await this.persistence.abort(candidateScope, this.options.configPath).catch(() => undefined)
        throw error
      }
      return immutable({
        ...base,
        status: 'applied',
        revision: committed.revision,
        configApplies: applies,
        serviceGeneration: restarted.generation,
      })
    } catch (error) {
      if (error instanceof ServiceConfigConflictError) {
        return immutable({
          ...base,
          status: 'conflict',
          revision: error.actualRevision,
          error: { code: 'conflict', message: boundedMessage(error) },
        })
      }
      return immutable({
        ...base,
        status: 'rejected',
        revision: actualRevision,
        error: { code: this.disposed ? 'disposed' : errorCode(error), message: boundedMessage(error) },
      })
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private project(value: JsonValue): HostServiceConfigProjection {
    return this.options.contract.project(value, this.options.secretState ?? (() => 'unavailable'))
  }

  private async authorized(permission: HostServiceConfigPermission): Promise<boolean> {
    return await this.options.authorize(permission, this.identity, this.scope)
  }

  private async persist<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ServiceConfigConflictError) throw error
      throw new Error(`failed to persist service configuration: ${boundedMessage(error)}`)
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('service configuration API is disposed')
  }

  private assertRequest(request: HostServiceConfigMutation): void {
    if (request.contract !== 'cordisx.service-config-mutation/v1' || request.schemaVersion !== 1) {
      throw new Error('service configuration mutation contract is unsupported')
    }
    if (request.identity.source !== this.identity.source
      || request.identity.pluginId !== this.identity.pluginId
      || request.identity.serviceId !== this.identity.serviceId) {
      throw new Error('service configuration identity is stale or spoofed')
    }
    if (request.scope.profileId !== this.options.profileId || request.scope.generation !== this.options.generation) {
      throw new Error('service configuration scope is stale or spoofed')
    }
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new Error('service configuration expectedRevision is invalid')
    }
  }
}
