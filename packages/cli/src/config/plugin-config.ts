import {
  type HomeConfig,
  type HomeConfigPlugin,
  type HomeConfigPluginProfile,
  type HomeConfigWriteOptions,
  type JsonValue,
  updateHomeConfigAtomic,
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

export interface PluginConfigCandidateStore {
  stage(input: StagePluginConfigInput): Promise<{ readonly candidateRevision: number }>
  commit(
    input: PluginConfigScope & { readonly candidateRevision: number },
  ): Promise<{ readonly revision: number; readonly config: JsonValue }>
  abort(input: PluginConfigScope & { readonly candidateRevision: number }): Promise<void>
}

export type PluginConfigDocument = Pick<HomeConfig, 'plugins'>
export type PluginConfigDocumentUpdater = (
  updater: (current: PluginConfigDocument) => PluginConfigDocument | Promise<PluginConfigDocument>,
) => Promise<PluginConfigDocument>

function pluginIndex(config: PluginConfigDocument, pluginId: string): number {
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

function replacePlugin<Document extends PluginConfigDocument>(
  config: Document,
  index: number,
  plugin: HomeConfigPlugin,
  profileId: string,
  state: HomeConfigPluginProfile,
): Document {
  const profiles = Object.assign(Object.create(null) as Record<string, HomeConfigPluginProfile>, plugin.profiles, {
    [profileId]: state,
  })
  const plugins = [...config.plugins]
  plugins[index] = { ...plugin, profiles }
  return { ...config, plugins } as Document
}

function assertScope(scope: PluginConfigScope): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(scope.profileId)) throw new Error('invalid plugin configuration profile id')
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(scope.pluginId)) throw new Error('invalid plugin configuration plugin id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.generation)) {
    throw new Error('invalid plugin configuration generation')
  }
  if (!/^[a-f0-9]{64}$/.test(scope.ownerToken)) throw new Error('invalid plugin configuration owner token')
}

export function createPluginConfigCandidateStore(
  updateDocument: PluginConfigDocumentUpdater,
): PluginConfigCandidateStore {
  return {
    async stage(input) {
      assertScope(input)
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error('expectedRevision must be a non-negative integer')
      }
      const candidateRevision = input.expectedRevision + 1
      await updateDocument((config) => {
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
      })
      return { candidateRevision }
    },
    async commit(input) {
      assertScope(input)
      let committed: JsonValue | undefined
      await updateDocument((config) => {
        const index = pluginIndex(config, input.pluginId)
        const plugin = config.plugins[index]!
        const state = scopedState(plugin, input.profileId)
        const candidate = state.candidate
        if (
          candidate === undefined
          || candidate.revision !== input.candidateRevision
          || candidate.ownerToken !== input.ownerToken
          || candidate.generation !== input.generation
        ) {
          throw new PluginConfigConflictError(
            state.revision,
            'plugin configuration candidate is not owned by this generation',
          )
        }
        committed = candidate.config
        return replacePlugin(config, index, plugin, input.profileId, {
          revision: candidate.revision,
          config: candidate.config,
        })
      })
      return { revision: input.candidateRevision, config: committed! }
    },
    async abort(input) {
      assertScope(input)
      await updateDocument((config) => {
        const index = pluginIndex(config, input.pluginId)
        const plugin = config.plugins[index]!
        const state = scopedState(plugin, input.profileId)
        const candidate = state.candidate
        if (candidate === undefined) return config
        if (
          candidate.revision !== input.candidateRevision
          || candidate.ownerToken !== input.ownerToken
          || candidate.generation !== input.generation
        ) {
          throw new PluginConfigConflictError(
            state.revision,
            'plugin configuration candidate is not owned by this generation',
          )
        }
        return replacePlugin(config, index, plugin, input.profileId, {
          revision: state.revision,
          config: state.config,
        })
      })
    },
  }
}

function homePluginConfigCandidateStore(options?: string | HomeConfigWriteOptions): PluginConfigCandidateStore {
  return createPluginConfigCandidateStore(updater =>
    updateHomeConfigAtomic(async current => {
      const updated = await updater(current)
      return { ...current, plugins: updated.plugins }
    }, options)
  )
}

export async function stagePluginConfigCandidate(
  input: StagePluginConfigInput,
  options?: string | HomeConfigWriteOptions,
) {
  return homePluginConfigCandidateStore(options).stage(input)
}

export async function commitPluginConfigCandidate(
  input: PluginConfigScope & { readonly candidateRevision: number },
  options?: string | HomeConfigWriteOptions,
) {
  return homePluginConfigCandidateStore(options).commit(input)
}

export async function abortPluginConfigCandidate(
  input: PluginConfigScope & { readonly candidateRevision: number },
  options?: string | HomeConfigWriteOptions,
): Promise<void> {
  return homePluginConfigCandidateStore(options).abort(input)
}
