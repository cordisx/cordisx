import {
  type HomeConfig,
  type HomeConfigPlugin,
  type HomeConfigPluginService,
  type HomeConfigPluginServiceProfile,
  type HomeConfigServiceApplies,
  type HomeConfigWriteOptions,
  type JsonValue,
  loadHomeConfig,
  updateHomeConfigAtomic,
} from './home-config.js'

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OWNER_TOKEN = /^[a-f0-9]{64}$/

export class ServiceConfigConflictError extends Error {
  constructor(
    readonly actualRevision: number,
    message = `service configuration revision conflict; actual revision is ${actualRevision}`,
  ) {
    super(message)
    this.name = 'ServiceConfigConflictError'
  }
}

export interface ServiceConfigScope {
  readonly profileId: string
  readonly pluginId: string
  readonly serviceId: string
  readonly generation: string
  readonly ownerToken: string
}

export interface StageServiceConfigInput extends ServiceConfigScope {
  readonly expectedRevision: number
  readonly config: JsonValue
  readonly applies: HomeConfigServiceApplies
  readonly initialConfig: JsonValue
  readonly now?: Date
}

type ServiceConfigOwnerGuard = (plugin: HomeConfigPlugin) => void | Promise<void>
type ReadServiceConfigInput = Omit<ServiceConfigScope, 'generation' | 'ownerToken'> & {
  readonly initialConfig: JsonValue
}
type CommitServiceConfigInput = ServiceConfigScope & {
  readonly candidateRevision: number
  readonly applies: HomeConfigServiceApplies
  readonly initialConfig: JsonValue
}
type AbortServiceConfigInput = ServiceConfigScope & {
  readonly candidateRevision: number
  readonly initialConfig: JsonValue
}
type RestartServiceConfigInput = Pick<ServiceConfigScope, 'profileId' | 'pluginId' | 'serviceId'> & {
  readonly expectedRevision: number
  readonly initialConfig: JsonValue
}

function assertScope(scope: ServiceConfigScope): void {
  if (!PROFILE_ID.test(scope.profileId)) throw new Error('invalid service configuration profile id')
  if (!LOCAL_ID.test(scope.pluginId)) throw new Error('invalid service configuration plugin id')
  if (!LOCAL_ID.test(scope.serviceId)) throw new Error('invalid service configuration service id')
  if (!GENERATION.test(scope.generation)) throw new Error('invalid service configuration generation')
  if (!OWNER_TOKEN.test(scope.ownerToken)) throw new Error('invalid service configuration owner token')
}

function pluginIndex(config: HomeConfig, pluginId: string): number {
  const index = config.plugins.findIndex(plugin => plugin.id === pluginId)
  if (index < 0) throw new Error(`unknown configured plugin: ${pluginId}`)
  return index
}

function serviceState(
  plugin: HomeConfigPlugin,
  serviceId: string,
  profileId: string,
  initialConfig: JsonValue,
): HomeConfigPluginServiceProfile {
  const service = plugin.services !== undefined && Object.hasOwn(plugin.services, serviceId)
    ? plugin.services[serviceId]
    : undefined
  return service?.profiles !== undefined && Object.hasOwn(service.profiles, profileId)
    ? service.profiles[profileId]!
    : { revision: 0, lastGoodRevision: 0, config: initialConfig }
}

function replaceServiceState(
  config: HomeConfig,
  index: number,
  plugin: HomeConfigPlugin,
  serviceId: string,
  profileId: string,
  state: HomeConfigPluginServiceProfile,
): HomeConfig {
  const previous = plugin.services !== undefined && Object.hasOwn(plugin.services, serviceId)
    ? plugin.services[serviceId]
    : undefined
  const profiles = Object.assign(
    Object.create(null) as Record<string, HomeConfigPluginServiceProfile>,
    previous?.profiles,
    { [profileId]: state },
  )
  const services = Object.assign(
    Object.create(null) as Record<string, HomeConfigPluginService>,
    plugin.services,
    { [serviceId]: { profiles } },
  )
  const plugins = [...config.plugins]
  plugins[index] = { ...plugin, services }
  return { ...config, plugins }
}

export async function readServiceConfigState(
  input: ReadServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
): Promise<HomeConfigPluginServiceProfile> {
  return await readServiceConfigStateGuarded(input, options)
}

async function readServiceConfigStateGuarded(
  input: ReadServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
  guard?: ServiceConfigOwnerGuard,
): Promise<HomeConfigPluginServiceProfile> {
  if (!PROFILE_ID.test(input.profileId) || !LOCAL_ID.test(input.pluginId) || !LOCAL_ID.test(input.serviceId)) {
    throw new Error('invalid service configuration identity')
  }
  const config = await loadHomeConfig(options)
  const index = pluginIndex(config, input.pluginId)
  await guard?.(config.plugins[index]!)
  return structuredClone(serviceState(config.plugins[index]!, input.serviceId, input.profileId, input.initialConfig))
}

export async function stageServiceConfigCandidate(
  input: StageServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
): Promise<{ readonly candidateRevision: number }> {
  return await stageServiceConfigCandidateGuarded(input, options)
}

async function stageServiceConfigCandidateGuarded(
  input: StageServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
  guard?: ServiceConfigOwnerGuard,
): Promise<{ readonly candidateRevision: number }> {
  assertScope(input)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer')
  }
  const candidateRevision = input.expectedRevision + 1
  await updateHomeConfigAtomic(async (config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    await guard?.(plugin)
    const state = serviceState(plugin, input.serviceId, input.profileId, input.initialConfig)
    if (state.revision !== input.expectedRevision || state.candidate !== undefined) {
      throw new ServiceConfigConflictError(state.revision)
    }
    return replaceServiceState(config, index, plugin, input.serviceId, input.profileId, {
      ...state,
      candidate: {
        revision: candidateRevision,
        config: input.config,
        applies: input.applies,
        ownerToken: input.ownerToken,
        generation: input.generation,
        createdAt: (input.now ?? new Date()).toISOString(),
      },
    })
  }, options)
  return { candidateRevision }
}

export async function commitServiceConfigCandidate(
  input: CommitServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
): Promise<HomeConfigPluginServiceProfile> {
  return await commitServiceConfigCandidateGuarded(input, options)
}

async function commitServiceConfigCandidateGuarded(
  input: CommitServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
  guard?: ServiceConfigOwnerGuard,
): Promise<HomeConfigPluginServiceProfile> {
  assertScope(input)
  let committed: HomeConfigPluginServiceProfile | undefined
  await updateHomeConfigAtomic(async (config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    await guard?.(plugin)
    const state = serviceState(plugin, input.serviceId, input.profileId, input.initialConfig)
    const candidate = state.candidate
    if (
      candidate === undefined
      || candidate.revision !== input.candidateRevision
      || candidate.applies !== input.applies
      || candidate.ownerToken !== input.ownerToken
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
    committed = input.applies === 'service-restart'
      ? {
        revision: candidate.revision,
        lastGoodRevision: candidate.revision,
        config: candidate.config,
      }
      : {
        revision: candidate.revision,
        lastGoodRevision: state.lastGoodRevision,
        config: candidate.config,
        lastGoodConfig: state.lastGoodConfig ?? state.config,
        restartRequired: true,
      }
    return replaceServiceState(config, index, plugin, input.serviceId, input.profileId, committed)
  }, options)
  return structuredClone(committed!)
}

export async function abortServiceConfigCandidate(
  input: AbortServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
): Promise<void> {
  await abortServiceConfigCandidateGuarded(input, options)
}

async function abortServiceConfigCandidateGuarded(
  input: AbortServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
  guard?: ServiceConfigOwnerGuard,
): Promise<void> {
  assertScope(input)
  await updateHomeConfigAtomic(async (config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    await guard?.(plugin)
    const state = serviceState(plugin, input.serviceId, input.profileId, input.initialConfig)
    const candidate = state.candidate
    if (candidate === undefined) return config
    if (
      candidate.revision !== input.candidateRevision
      || candidate.ownerToken !== input.ownerToken
      || candidate.generation !== input.generation
    ) {
      throw new ServiceConfigConflictError(
        state.revision,
        'service configuration candidate is not owned by this generation',
      )
    }
    const { candidate: _candidate, ...active } = state
    return replaceServiceState(config, index, plugin, input.serviceId, input.profileId, active)
  }, options)
}

/** Mark the already-published app-restart configuration active after launcher readiness succeeds. */
export async function markServiceConfigAppRestartApplied(
  input: RestartServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
): Promise<HomeConfigPluginServiceProfile> {
  return await markServiceConfigAppRestartAppliedGuarded(input, options)
}

async function markServiceConfigAppRestartAppliedGuarded(
  input: RestartServiceConfigInput,
  options?: string | HomeConfigWriteOptions,
  guard?: ServiceConfigOwnerGuard,
): Promise<HomeConfigPluginServiceProfile> {
  if (!PROFILE_ID.test(input.profileId) || !LOCAL_ID.test(input.pluginId) || !LOCAL_ID.test(input.serviceId)) {
    throw new Error('invalid service configuration identity')
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer')
  }
  let applied: HomeConfigPluginServiceProfile | undefined
  await updateHomeConfigAtomic(async (config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    await guard?.(plugin)
    const state = serviceState(plugin, input.serviceId, input.profileId, input.initialConfig)
    if (state.revision !== input.expectedRevision || state.restartRequired !== true || state.candidate !== undefined) {
      throw new ServiceConfigConflictError(state.revision, 'service configuration app-restart state is stale')
    }
    applied = { revision: state.revision, lastGoodRevision: state.revision, config: state.config }
    return replaceServiceState(config, index, plugin, input.serviceId, input.profileId, applied)
  }, options)
  return structuredClone(applied!)
}

/** Check the exact configured owner while holding the existing Home config write lock. */
export function guardedHomeServiceConfigPersistence(guard: ServiceConfigOwnerGuard): Readonly<{
  read: typeof readServiceConfigState
  stage: typeof stageServiceConfigCandidate
  commit: typeof commitServiceConfigCandidate
  abort: typeof abortServiceConfigCandidate
  markAppRestartApplied: typeof markServiceConfigAppRestartApplied
}> {
  return Object.freeze({
    read: async (input, options) => await readServiceConfigStateGuarded(input, options, guard),
    stage: async (input, options) => await stageServiceConfigCandidateGuarded(input, options, guard),
    commit: async (input, options) => await commitServiceConfigCandidateGuarded(input, options, guard),
    abort: async (input, options) => await abortServiceConfigCandidateGuarded(input, options, guard),
    markAppRestartApplied: async (input, options) =>
      await markServiceConfigAppRestartAppliedGuarded(input, options, guard),
  })
}
