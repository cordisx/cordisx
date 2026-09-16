import type {
  PluginManifestManagedBackendRuntimeResourceV14,
  PluginManifestManagedBackendServiceV14,
} from '@cordisx/protocol/plugin-manifest/v14'
import type { CordisXPluginServiceDeclarationV9 } from '../permission-contracts.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { StagedPluginServiceModule } from './plugin-package-types.js'

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const ENTRY = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:cjs|mjs|js)$/
const DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json'

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function localId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOCAL_ID.test(value) || value === 'host' || value.startsWith('cordisx.')) {
    throw new Error(`${label} is invalid or reserved`)
  }
  return value
}

function storedServiceDeclaration(
  value: unknown,
  label: string,
): CordisXPluginServiceDeclarationV9 | PluginManifestManagedBackendServiceV14 {
  const service = object(value, label)
  const id = localId(service.id, `${label}.id`)
  if (typeof service.entry !== 'string' || !ENTRY.test(service.entry) || service.entry.includes('..')) {
    throw new Error(`${label}.entry is invalid`)
  }
  const entry = service.entry
  if (service.kind === 'platform-provider') {
    exactKeys(service, ['id', 'kind', 'owner', 'schema', 'applicationMode', 'entry'], label)
    if (
      service.owner !== 'host' || typeof service.schema !== 'string'
      || !/^https:\/\/raw\.githubusercontent\.com\/cordisx\/cordisx-protocol\/main\/schemas\/[a-z0-9][a-z0-9.-]*\.v[1-9][0-9]*\.schema\.json$/
        .test(service.schema)
      || (service.applicationMode !== 'service-restart' && service.applicationMode !== 'app-restart')
    ) throw new Error(`${label} is unsupported`)
    return Object.freeze({
      id,
      kind: 'platform-provider',
      owner: 'host',
      schema: service
        .schema as `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/${string}.v${number}.schema.json`,
      applicationMode: service.applicationMode,
      entry,
    })
  }
  if (service.kind === 'managed-backend') {
    exactKeys(
      service,
      ['id', 'kind', 'owner', 'entry', 'definitionSchema', 'runtimeResources', 'consumerGrants'],
      label,
    )
    if (
      service.owner !== 'host' || service.definitionSchema !== DEFINITION_SCHEMA
      || !Array.isArray(service.runtimeResources) || !Array.isArray(service.consumerGrants)
      || service.consumerGrants.length > 32
    ) throw new Error(`${label} is unsupported`)
    const runtimeResources = service.runtimeResources.map((resource, index) => {
      const value = object(resource, `${label}.runtimeResources[${index}]`)
      const byteLength = value.byteLength
      exactKeys(
        value,
        ['path', 'mode', 'byteLength', 'digest', 'platforms', 'architectures'],
        `${label}.runtimeResources[${index}]`,
      )
      if (
        typeof value.path !== 'string' || (value.mode !== 'executable' && value.mode !== 'data')
        || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || typeof value.digest !== 'string'
      ) throw new Error(`${label}.runtimeResources[${index}] is invalid`)
      const platforms = Array.isArray(value.platforms)
        ? Object.freeze([...value.platforms]) as readonly ('darwin' | 'linux' | 'win32')[]
        : undefined
      const architectures = Array.isArray(value.architectures)
        ? Object.freeze([...value.architectures]) as readonly ('arm64' | 'x64')[]
        : undefined
      return Object.freeze<PluginManifestManagedBackendRuntimeResourceV14>({
        path: value.path as `./${string}`,
        mode: value.mode,
        digest: value.digest as `sha256:${string}`,
        byteLength,
        ...(platforms === undefined ? {} : { platforms }),
        ...(architectures === undefined ? {} : { architectures }),
      })
    })
    const seen = new Set<string>()
    const consumerGrants = service.consumerGrants.map((value, index) => {
      const grant = object(value, `${label}.consumerGrants[${index}]`)
      exactKeys(grant, ['pluginId', 'operations'], `${label}.consumerGrants[${index}]`)
      const pluginId = localId(grant.pluginId, `${label}.consumerGrants[${index}].pluginId`)
      if (
        seen.has(pluginId) || !Array.isArray(grant.operations)
        || grant.operations.length < 1 || grant.operations.length > 32
      ) {
        throw new Error(`${label}.consumerGrants[${index}] is invalid`)
      }
      const operations = grant.operations.map((operation, operationIndex) =>
        localId(operation, `${label}.consumerGrants[${index}].operations[${operationIndex}]`)
      )
      if (new Set(operations).size !== operations.length) {
        throw new Error(`${label}.consumerGrants[${index}] is invalid`)
      }
      seen.add(pluginId)
      return Object.freeze({ pluginId, operations: Object.freeze(operations) })
    })
    return Object.freeze({
      id,
      kind: 'managed-backend',
      owner: 'host',
      entry,
      definitionSchema: DEFINITION_SCHEMA,
      runtimeResources: Object.freeze(runtimeResources),
      consumerGrants: Object.freeze(consumerGrants),
    })
  }
  exactKeys(service, ['id', 'kind', 'entry', 'configuration'], label)
  if (service.kind !== 'channel-adapter') throw new Error(`${label}.kind is unsupported`)
  const configuration = object(service.configuration, `${label}.configuration`)
  if (configuration.kind === 'none') {
    exactKeys(configuration, ['kind'], `${label}.configuration`)
    return Object.freeze({ id, kind: 'channel-adapter', entry, configuration: Object.freeze({ kind: 'none' }) })
  }
  exactKeys(configuration, ['kind', 'schema', 'configApplies'], `${label}.configuration`)
  const schema =
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json'
  if (configuration.kind !== 'host' || configuration.schema !== schema || configuration.configApplies !== 'restart') {
    throw new Error(`${label}.configuration is unsupported`)
  }
  return Object.freeze({
    id,
    kind: 'channel-adapter',
    entry,
    configuration: Object.freeze({ kind: 'host', schema, configApplies: 'restart' }),
  })
}

export async function readStoredServiceModules(directory: string): Promise<readonly StagedPluginServiceModule[]> {
  const declarations = await readFile(path.join(directory, 'services.json'), 'utf8')
    .then(text => JSON.parse(text) as unknown)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  if (!Array.isArray(declarations)) throw new Error('stored plugin service index is invalid')
  const seen = new Set<string>()
  return await Promise.all(declarations.map(async (value, index) => {
    const declaration = storedServiceDeclaration(value, `stored service[${index}]`)
    if (seen.has(declaration.id)) throw new Error(`duplicate stored service module: ${declaration.id}`)
    seen.add(declaration.id)
    const moduleSource = await readFile(path.join(directory, 'services', `${declaration.id}.mjs`), 'utf8')
    return Object.freeze({ declaration, moduleSource })
  }))
}
