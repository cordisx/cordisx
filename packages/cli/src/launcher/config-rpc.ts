import { pathToFileURL } from 'node:url'
import {
  abortPluginConfigCandidate,
  commitPluginConfigCandidate,
  PluginConfigConflictError,
  stagePluginConfigCandidate,
} from '../config/plugin-config.js'
import type { JsonValue } from '../config/home-config.js'
import type { CordisXConfig } from './config.js'
import { PluginActivationStore } from './plugin-activation.js'
import { loadStagedPluginPackage } from './plugin-package.js'
import { PackagePluginConfigStore } from './package-plugin-config.js'

export const CONFIG_BINDING = '__cordisxConfigRequestV1'
export const CONFIG_RECEIVER = '__cordisxConfigReceiveV1'
export const MAX_CONFIG_REQUEST_BYTES = 1_048_576

interface ConfigRequestBase {
  readonly requestId: string
  readonly operation: 'stage' | 'commit' | 'abort'
  readonly identity: { readonly source: string; readonly pluginId: string }
  readonly scope: { readonly profileId: string; readonly generation: string }
}

export type ConfigBindingRequest = ConfigRequestBase & {
  readonly expectedRevision?: number
  readonly candidateRevision?: number
  readonly config?: JsonValue
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is not supported`)
}

function jsonValue(value: unknown, label: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not be circular`)
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`, seen))
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = jsonValue(item, `${label}.${key}`, seen)
    return result
  } finally {
    seen.delete(value)
  }
}

export function parseConfigBindingRequest(value: unknown, token: string, profileId: string, generation: string): ConfigBindingRequest {
  const request = record(value, 'config request')
  exactKeys(request, ['version', 'operation', 'requestId', 'token', 'identity', 'scope', 'expectedRevision', 'candidateRevision', 'config'], 'config request')
  if (request.version !== 1) throw new Error('config request version must be 1')
  if (request.token !== token) throw new Error('config request token is invalid')
  if (request.operation !== 'stage' && request.operation !== 'commit' && request.operation !== 'abort') throw new Error('config request operation is invalid')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/.test(request.requestId)) throw new Error('config request id is invalid')
  const identity = record(request.identity, 'config request identity')
  exactKeys(identity, ['source', 'pluginId'], 'config request identity')
  if (typeof identity.source !== 'string' || !identity.source.startsWith('file:')) throw new Error('config request source is invalid')
  if (typeof identity.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(identity.pluginId)) throw new Error('config request plugin id is invalid')
  const scope = record(request.scope, 'config request scope')
  exactKeys(scope, ['profileId', 'generation'], 'config request scope')
  if (scope.profileId !== profileId) throw new Error('config request profile is stale or spoofed')
  if (typeof scope.generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.generation)) throw new Error('config request generation is invalid')
  if (scope.generation !== generation) throw new Error('config request generation is stale or spoofed')
  if (request.operation === 'stage') {
    if (!Number.isInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) throw new Error('config request expectedRevision is invalid')
    if (request.config === undefined) throw new Error('config stage request requires config')
    return {
      requestId: request.requestId,
      operation: 'stage',
      identity: { source: identity.source, pluginId: identity.pluginId },
      scope: { profileId, generation: scope.generation },
      expectedRevision: request.expectedRevision as number,
      config: jsonValue(request.config, 'config request config'),
    }
  }
  if (!Number.isInteger(request.candidateRevision) || (request.candidateRevision as number) < 1) throw new Error('config request candidateRevision is invalid')
  return {
    requestId: request.requestId,
    operation: request.operation,
    identity: { source: identity.source, pluginId: identity.pluginId },
    scope: { profileId, generation: scope.generation },
    candidateRevision: request.candidateRevision as number,
  }
}

export interface ConfigBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  handle(request: ConfigBindingRequest): Promise<unknown>
}

export function createConfigBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly composition: CordisXConfig
  readonly packagePlugins?: {
    readonly homeDir: string
    readonly runtimeGeneration: string
  }
}): ConfigBridgeHandler {
  const identities = new Map(input.composition.plugins
    .filter(plugin => plugin.package === undefined)
    .map(plugin => [plugin.id, plugin.source ?? pathToFileURL(plugin.entry).href]))
  const activationStore = input.packagePlugins === undefined
    ? undefined
    : new PluginActivationStore(input.packagePlugins.homeDir, input.profileId, input.packagePlugins.runtimeGeneration)
  const packageConfig = input.packagePlugins === undefined
    ? undefined
    : new PackagePluginConfigStore(input.packagePlugins.homeDir, input.profileId, input.packagePlugins.runtimeGeneration)
  return {
    token: input.token,
    profileId: input.profileId,
    generation: input.generation,
    async handle(request) {
      const configuredIdentity = identities.get(request.identity.pluginId)
      let packageOwned = false
      if (configuredIdentity !== request.identity.source) {
        const active = await activationStore?.loadActive()
        const item = active?.plugins.find(plugin => plugin.id === request.identity.pluginId)
        if (item === undefined) throw new Error('config request plugin identity is stale or spoofed')
        const staged = await loadStagedPluginPackage(activationStore!.homeDir, item.digest)
        if (staged.identitySource !== request.identity.source) throw new Error('config request plugin identity is stale or spoofed')
        packageOwned = true
      }
      const scope = {
        profileId: request.scope.profileId,
        pluginId: request.identity.pluginId,
        generation: request.scope.generation,
        ownerToken: input.token,
      }
      if (request.operation === 'stage') {
        if (packageOwned) return await packageConfig!.stage(request.identity.pluginId, request.expectedRevision!, request.config!, input.token)
        return stagePluginConfigCandidate({
          ...scope,
          expectedRevision: request.expectedRevision!,
          config: request.config!,
        }, input.configPath)
      }
      if (request.operation === 'commit') {
        if (packageOwned) return await packageConfig!.commit(request.identity.pluginId, request.candidateRevision!, input.token)
        return commitPluginConfigCandidate({ ...scope, candidateRevision: request.candidateRevision! }, input.configPath)
      }
      if (packageOwned) return await packageConfig!.abort(request.identity.pluginId, request.candidateRevision!, input.token)
      await abortPluginConfigCandidate({ ...scope, candidateRevision: request.candidateRevision! }, input.configPath)
      return undefined
    },
  }
}

export function configBridgeError(error: unknown): { readonly code: string; readonly error: string; readonly actualRevision?: number } {
  if (error instanceof PluginConfigConflictError) {
    return { code: 'conflict', error: error.message, actualRevision: error.actualRevision }
  }
  return { code: 'rejected', error: error instanceof Error ? error.message : String(error) }
}
