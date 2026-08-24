import {
  updateHomeConfigAtomic,
  type HomeConfig,
  type HomeConfigPlugin,
  type HomeConfigPluginProfile,
  type HomeConfigWriteOptions,
  type JsonValue,
} from './home-config.js'

export class PluginConfigConflictError extends Error {
  constructor(
    readonly actualRevision: number,
    message = `plugin configuration revision conflict; actual revision is ${actualRevision}`,
  ) {
    super(message)
    this.name = 'PluginConfigConflictError'
  }
}

export interface PluginConfigScope {
  readonly profileId: string
  readonly pluginId: string
  readonly generation: string
  readonly ownerToken: string
}

export interface StagePluginConfigInput extends PluginConfigScope {
  readonly expectedRevision: number
  readonly config: JsonValue
  readonly now?: Date
}

function pluginIndex(config: HomeConfig, pluginId: string): number {
  const index = config.plugins.findIndex(plugin => plugin.id === pluginId)
  if (index < 0) throw new Error(`unknown configured plugin: ${pluginId}`)
  return index
}

function scopedState(plugin: HomeConfigPlugin, profileId: string): HomeConfigPluginProfile {
  return plugin.profiles !== undefined && Object.hasOwn(plugin.profiles, profileId) ? plugin.profiles[profileId]! : {
    revision: 0,
    config: plugin.config ?? {},
  }
}

function replacePlugin(
  config: HomeConfig,
  index: number,
  plugin: HomeConfigPlugin,
  profileId: string,
  state: HomeConfigPluginProfile,
): HomeConfig {
  const profiles = Object.assign(Object.create(null) as Record<string, HomeConfigPluginProfile>, plugin.profiles, {
    [profileId]: state,
  })
  const plugins = [...config.plugins]
  plugins[index] = { ...plugin, profiles }
  return { ...config, plugins }
}

function assertScope(scope: PluginConfigScope): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(scope.profileId)) throw new Error('invalid plugin configuration profile id')
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(scope.pluginId)) throw new Error('invalid plugin configuration plugin id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.generation)) throw new Error('invalid plugin configuration generation')
  if (!/^[a-f0-9]{64}$/.test(scope.ownerToken)) throw new Error('invalid plugin configuration owner token')
}

export async function stagePluginConfigCandidate(
  input: StagePluginConfigInput,
  options?: string | HomeConfigWriteOptions,
): Promise<{ readonly candidateRevision: number }> {
  assertScope(input)
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('expectedRevision must be a non-negative integer')
  const candidateRevision = input.expectedRevision + 1
  await updateHomeConfigAtomic((config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    const state = scopedState(plugin, input.profileId)
    if (state.revision !== input.expectedRevision || state.candidate !== undefined) {
      throw new PluginConfigConflictError(state.revision)
    }
    return replacePlugin(config, index, plugin, input.profileId, {
      revision: state.revision,
      config: state.config,
      candidate: {
        revision: candidateRevision,
        config: input.config,
        ownerToken: input.ownerToken,
        generation: input.generation,
        createdAt: (input.now ?? new Date()).toISOString(),
      },
    })
  }, options)
  return { candidateRevision }
}

export async function commitPluginConfigCandidate(
  input: PluginConfigScope & { readonly candidateRevision: number },
  options?: string | HomeConfigWriteOptions,
): Promise<{ readonly revision: number; readonly config: JsonValue }> {
  assertScope(input)
  let committed: JsonValue | undefined
  await updateHomeConfigAtomic((config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    const state = scopedState(plugin, input.profileId)
    const candidate = state.candidate
    if (candidate === undefined
      || candidate.revision !== input.candidateRevision
      || candidate.ownerToken !== input.ownerToken
      || candidate.generation !== input.generation) {
      throw new PluginConfigConflictError(state.revision, 'plugin configuration candidate is not owned by this generation')
    }
    committed = candidate.config
    return replacePlugin(config, index, plugin, input.profileId, {
      revision: candidate.revision,
      config: candidate.config,
    })
  }, options)
  return { revision: input.candidateRevision, config: committed! }
}

export async function abortPluginConfigCandidate(
  input: PluginConfigScope & { readonly candidateRevision: number },
  options?: string | HomeConfigWriteOptions,
): Promise<void> {
  assertScope(input)
  await updateHomeConfigAtomic((config) => {
    const index = pluginIndex(config, input.pluginId)
    const plugin = config.plugins[index]!
    const state = scopedState(plugin, input.profileId)
    const candidate = state.candidate
    if (candidate === undefined) return config
    if (candidate.revision !== input.candidateRevision
      || candidate.ownerToken !== input.ownerToken
      || candidate.generation !== input.generation) {
      throw new PluginConfigConflictError(state.revision, 'plugin configuration candidate is not owned by this generation')
    }
    return replacePlugin(config, index, plugin, input.profileId, {
      revision: state.revision,
      config: state.config,
    })
  }, options)
}
