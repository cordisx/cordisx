import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  type CordisXPluginManifestV12,
  type CordisXPluginManifestV13,
  normalizePluginManifestV12,
  normalizePluginManifestV13,
} from '../runtime-exact-request-permissions.js'
import type { CordisXPluginManifestV11 } from '../usage-permissions.js'
import type {
  PluginManifestManagedBackendRuntimeResourceV14,
  PluginManifestManagedBackendServiceV14,
  PluginRuntimeManifestV14,
} from '@cordisx/protocol/plugin-manifest/v14'
import { managedServiceResourceMatchesTarget } from './managed-service-package-resources.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v14.schema.json'
const MANAGED_SERVICE_DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json'
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const ENTRY = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:cjs|mjs|js)$/
const RUNTIME_RESOURCE_PATH = /^\.\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

function managedBackendRuntimeResource(
  value: unknown,
  label: string,
): PluginManifestManagedBackendRuntimeResourceV14 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const resource = value as Record<string, unknown>
  const byteLength = resource.byteLength
  const allowed = new Set(['path', 'mode', 'digest', 'byteLength', 'platforms', 'architectures'])
  const unknown = Object.keys(resource).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
  if (
    typeof resource.path !== 'string' || !RUNTIME_RESOURCE_PATH.test(resource.path)
    || resource.path.includes('..') || resource.path.includes('//')
    || (resource.mode !== 'executable' && resource.mode !== 'data')
    || typeof resource.digest !== 'string' || !DIGEST.test(resource.digest)
    || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength)
    || byteLength < 0 || byteLength > 64 * 1024 * 1024
  ) throw new Error(`${label} is invalid`)
  const platforms = resource.platforms === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(resource.platforms) || resource.platforms.length === 0 || resource.platforms.length > 3) {
        throw new Error(`${label}.platforms is invalid`)
      }
      const values = resource.platforms.map((platform, index) => {
        if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
          throw new Error(`${label}.platforms[${index}] is invalid`)
        }
        return platform
      })
      if (new Set(values).size !== values.length) throw new Error(`${label}.platforms is invalid`)
      return Object.freeze(values)
    })()
  const architectures = resource.architectures === undefined
    ? undefined
    : (() => {
      if (
        !Array.isArray(resource.architectures) || resource.architectures.length === 0
        || resource.architectures.length > 2
      ) throw new Error(`${label}.architectures is invalid`)
      const values = resource.architectures.map((architecture, index) => {
        if (architecture !== 'arm64' && architecture !== 'x64') {
          throw new Error(`${label}.architectures[${index}] is invalid`)
        }
        return architecture
      })
      if (new Set(values).size !== values.length) throw new Error(`${label}.architectures is invalid`)
      return Object.freeze(values)
    })()
  return Object.freeze({
    path: resource.path as `./${string}`,
    mode: resource.mode,
    digest: resource.digest as `sha256:${string}`,
    byteLength,
    ...(platforms === undefined ? {} : { platforms }),
    ...(architectures === undefined ? {} : { architectures }),
  })
}

function managedBackendService(value: unknown, label: string): PluginManifestManagedBackendServiceV14 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const service = value as Record<string, unknown>
  const allowed = new Set(['id', 'kind', 'owner', 'entry', 'definitionSchema', 'runtimeResources', 'consumerGrants'])
  const unknown = Object.keys(service).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
  if (
    typeof service.id !== 'string' || !LOCAL_ID.test(service.id)
    || service.kind !== 'managed-backend' || service.owner !== 'host'
    || typeof service.entry !== 'string' || !ENTRY.test(service.entry) || service.entry.includes('..')
    || service.definitionSchema !== MANAGED_SERVICE_DEFINITION_SCHEMA
    || !Array.isArray(service.runtimeResources) || service.runtimeResources.length > 128
    || !Array.isArray(service.consumerGrants) || service.consumerGrants.length > 32
  ) throw new Error(`${label} is invalid`)
  const seenResources = new Set<string>()
  const runtimeResources = service.runtimeResources.map((value, index) => {
    const resource = managedBackendRuntimeResource(value, `${label}.runtimeResources[${index}]`)
    if (seenResources.has(resource.path)) throw new Error(`${label}.runtimeResources[${index}] is invalid`)
    seenResources.add(resource.path)
    return resource
  })
  const totalBytes = runtimeResources
    .filter(resource => managedServiceResourceMatchesTarget(resource))
    .reduce((sum, resource) => sum + resource.byteLength, 0)
  if (totalBytes > 256 * 1024 * 1024) throw new Error(`${label}.runtimeResources is invalid`)
  const seen = new Set<string>()
  const consumerGrants = service.consumerGrants.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label}.consumerGrants[${index}] must be an object`)
    }
    const grant = value as Record<string, unknown>
    if (
      Object.keys(grant).some(key => key !== 'pluginId' && key !== 'operations')
      || typeof grant.pluginId !== 'string' || !LOCAL_ID.test(grant.pluginId) || seen.has(grant.pluginId)
      || !Array.isArray(grant.operations) || grant.operations.length < 1 || grant.operations.length > 32
      || grant.operations.some(operation => typeof operation !== 'string' || !LOCAL_ID.test(operation))
      || new Set(grant.operations).size !== grant.operations.length
    ) throw new Error(`${label}.consumerGrants[${index}] is invalid`)
    seen.add(grant.pluginId)
    return Object.freeze({ pluginId: grant.pluginId, operations: Object.freeze([...grant.operations] as string[]) })
  })
  return Object.freeze({
    id: service.id,
    kind: 'managed-backend',
    owner: 'host',
    entry: service.entry,
    definitionSchema: MANAGED_SERVICE_DEFINITION_SCHEMA,
    runtimeResources: Object.freeze(runtimeResources),
    consumerGrants: Object.freeze(consumerGrants),
  })
}

export function normalizePluginManifestV14(value: unknown, expectedId: string): PluginRuntimeManifestV14 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest must be an object')
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.services)) throw new Error('manifest.services must be an array')
  const existing = candidate.services.filter(service =>
    service === null || typeof service !== 'object' || Array.isArray(service)
    || (service as { kind?: unknown }).kind !== 'managed-backend'
  )
  const normalizedBase = normalizePluginManifestV13({
    ...candidate,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
    schemaVersion: 13,
    services: existing,
  }, expectedId)
  const managed = candidate.services.flatMap((service, index) =>
    service !== null && typeof service === 'object' && !Array.isArray(service)
      && (service as { kind?: unknown }).kind === 'managed-backend'
      ? [managedBackendService(service, `manifest.services[${index}]`)]
      : []
  )
  const services = [...normalizedBase.services, ...managed]
  if (services.length !== candidate.services.length) {
    throw new Error('manifest.services contains an unsupported service')
  }
  return Object.freeze({
    ...normalizedBase,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
    schemaVersion: 14,
    services: Object.freeze(services),
  }) as PluginRuntimeManifestV14
}

export function normalizeLatestRuntimeManifest(
  value: unknown,
  expectedId: string,
): CordisXPluginManifestV12 | CordisXPluginManifestV13 | PluginRuntimeManifestV14 | undefined {
  const candidate = value as { readonly $schema?: unknown; readonly schemaVersion?: unknown }
  return candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 && candidate.schemaVersion === 12
    ? normalizePluginManifestV12(value, expectedId)
    : candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 && candidate.schemaVersion === 13
    ? normalizePluginManifestV13(value, expectedId)
    : candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 && candidate.schemaVersion === 14
    ? normalizePluginManifestV14(value, expectedId)
    : undefined
}

export function runtimeManifestHasServices<T extends { readonly schemaVersion: number }>(
  manifest: T,
): manifest is T & {
  readonly services: CordisXPluginManifestV11['services'] | PluginRuntimeManifestV14['services']
} {
  return manifest.schemaVersion >= 4
}
