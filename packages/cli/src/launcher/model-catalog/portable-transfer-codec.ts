import { randomUUID } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { CatalogProtocolCapabilities } from '../../model-catalog-management.js'
import { type ModelReasoningCapabilities, parseModelReasoningCapabilities } from '../../model-reasoning-capabilities.js'
import { boundedString, object } from './contracts.js'

const PREFIX_V1 = 'cordisx-models-v1.'
const PREFIX_V2 = 'cordisx-models-v2.'
const PREFIX_V3 = 'cordisx-models-v3.'
const MAX_TEXT = 48_000
const MAX_COMPRESSED = 36_000
const MAX_JSON = 256_000
const MAX_CONNECTIONS = 24
const MAX_MODELS = 512
const MAX_ENVIRONMENT = 128
const transferIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const portableApiPaths = new Set(['/', '/v1', '/api/v1', '/zen/go/v1'])

/** Unknown path segments may contain credentials; refuse rather than strip or encode them. */
export function portableEndpoint(value: unknown): value is string {
  if (!boundedString(value, 2048)) return false
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return false
  }
  const path = endpoint.pathname.replace(/\/$/u, '') || '/'
  return endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password
    && !endpoint.search && !endpoint.hash && !/[\\?#]/u.test(value)
    && (endpoint.href === value || endpoint.href === `${value}/`)
    && portableApiPaths.has(path)
}

export interface PortableModel {
  readonly id: string
  readonly label: string
  readonly protocolCapabilities?: CatalogProtocolCapabilities
  readonly reasoningCapabilities?: ModelReasoningCapabilities
}

export interface PortableConnection {
  /** Random per exported bundle. It is not a local binding identity. */
  readonly transferId: string
  readonly title: string
  readonly endpoint: string
  readonly protocol: 'responses' | 'chat-completions'
  readonly auth: 'bearer'
  readonly environment?: string
  readonly models: readonly PortableModel[]
}

export interface PortableEnvironmentVariable {
  readonly name: string
  readonly value?: string
  readonly description?: string
  readonly generator?: { readonly kind: 'shell'; readonly script: string }
}

export interface PortableBundleV1 {
  readonly version: 1
  readonly connections: readonly PortableConnection[]
}

export interface PortableBundleV2 {
  readonly version: 2
  readonly environment: readonly PortableEnvironmentVariable[]
  readonly connections: readonly PortableConnection[]
}

export interface PortableBundleV3 {
  readonly version: 3
  readonly environment: readonly PortableEnvironmentVariable[]
  readonly connections: readonly PortableConnection[]
}

export type PortableBundle = PortableBundleV1 | PortableBundleV2 | PortableBundleV3

export class PortableTransferError extends Error {
  constructor(readonly code: 'invalid' | 'too-large') {
    super(code)
  }
}

const invalid = (): never => {
  throw new PortableTransferError('invalid')
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key))

function model(value: unknown): PortableModel {
  const input = object(value)
  if (
    !input || !exact(input, ['id', 'label', 'protocolCapabilities', 'reasoningCapabilities'])
    || !boundedString(input.id, 512) || !boundedString(input.label, 256)
  ) return invalid()
  const protocol = input.protocolCapabilities === undefined ? undefined : object(input.protocolCapabilities)
  if (
    input.protocolCapabilities !== undefined
    && (!protocol || !exact(protocol, ['responses']) || Object.keys(protocol).length !== 1
      || typeof protocol.responses !== 'boolean')
  ) return invalid()
  const reasoning = input.reasoningCapabilities === undefined
    ? undefined
    : parseModelReasoningCapabilities(input.reasoningCapabilities)
  if (input.reasoningCapabilities !== undefined && reasoning === undefined) return invalid()
  const rawEfforts = object(input.reasoningCapabilities)?.efforts
  if (reasoning && JSON.stringify(rawEfforts) !== JSON.stringify(reasoning.efforts)) return invalid()
  return Object.freeze({
    id: input.id,
    label: input.label,
    ...(protocol ? { protocolCapabilities: Object.freeze({ responses: protocol.responses as boolean }) } : {}),
    ...(reasoning ? { reasoningCapabilities: reasoning } : {}),
  })
}

function environmentName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
}

function connection(value: unknown, version: 1 | 2 | 3): PortableConnection {
  const input = object(value)
  if (
    !input || !exact(input, [
      'transferId',
      'title',
      'endpoint',
      'protocol',
      'auth',
      'models',
      ...(version >= 2 ? ['environment'] : []),
    ])
    || typeof input.transferId !== 'string' || !transferIdPattern.test(input.transferId)
    || !boundedString(input.title, 128) || !portableEndpoint(input.endpoint)
    || !['responses', 'chat-completions'].includes(String(input.protocol))
    || input.auth !== 'bearer' || !Array.isArray(input.models)
    || input.environment !== undefined && (version < 2 || !environmentName(input.environment))
    || input.models.length === 0 || input.models.length > MAX_MODELS
  ) return invalid()
  const models = input.models.map(model)
  if (new Set(models.map(item => item.id)).size !== models.length) return invalid()
  return Object.freeze({
    transferId: input.transferId,
    title: input.title,
    endpoint: input.endpoint,
    protocol: input.protocol as PortableConnection['protocol'],
    auth: 'bearer',
    ...(input.environment === undefined ? {} : { environment: input.environment as string }),
    models: Object.freeze(models),
  })
}

function environmentVariable(value: unknown, version: 2 | 3): PortableEnvironmentVariable {
  const input = object(value)
  if (
    !input || !exact(input, ['name', 'value', 'description', ...(version === 3 ? ['generator'] : [])])
    || !environmentName(input.name)
    || input.value !== undefined
      && (typeof input.value !== 'string' || input.value.length > 16_384 || input.value.includes('\0'))
    || input.description !== undefined && (!boundedString(input.description, 512) || input.description.includes('\0'))
  ) return invalid()
  const generator = input.generator === undefined ? undefined : object(input.generator)
  if (
    input.generator !== undefined
    && (version !== 3 || !generator || !exact(generator, ['kind', 'script'])
      || generator.kind !== 'shell' || typeof generator.script !== 'string'
      || generator.script.length > 16_384 || generator.script.includes('\0'))
  ) return invalid()
  return Object.freeze({
    name: input.name,
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(generator === undefined
      ? {}
      : { generator: Object.freeze({ kind: 'shell' as const, script: generator.script as string }) }),
  })
}

export function validatePortableBundle(value: unknown): PortableBundle {
  const input = object(value)
  if (
    !input || ![1, 2, 3].includes(Number(input.version))
    || !exact(input, input.version === 1 ? ['version', 'connections'] : ['version', 'environment', 'connections'])
    || !Array.isArray(input.connections) || input.connections.length === 0
    || input.connections.length > MAX_CONNECTIONS
  ) return invalid()
  const version = input.version as 1 | 2 | 3
  const connections = input.connections.map(value => connection(value, version))
  if (
    new Set(connections.map(item => item.transferId)).size !== connections.length
    || connections.reduce((count, item) => count + item.models.length, 0) > MAX_MODELS
  ) return invalid()
  if (version === 1) return Object.freeze({ version: 1, connections: Object.freeze(connections) })
  if (!Array.isArray(input.environment) || input.environment.length > MAX_ENVIRONMENT) return invalid()
  const environment = input.environment.map(value => environmentVariable(value, version))
  const names = new Set(environment.map(entry => entry.name))
  const referenced = new Set(connections.flatMap(item => item.environment === undefined ? [] : [item.environment]))
  if (
    names.size !== environment.length || connections.some(item => item.environment && !names.has(item.environment))
    || environment.some(item => !referenced.has(item.name))
  ) {
    return invalid()
  }
  return Object.freeze({ version, environment: Object.freeze(environment), connections: Object.freeze(connections) })
}

export function portableConnection(input: Omit<PortableConnection, 'transferId'>): PortableConnection {
  return connection({ ...input, transferId: randomUUID() }, input.environment === undefined ? 1 : 2)
}

export function encodePortableBundle(value: PortableBundle): string {
  const bundle = validatePortableBundle(value)
  const json = Buffer.from(JSON.stringify(bundle))
  if (json.length > MAX_JSON) throw new PortableTransferError('too-large')
  const compressed = deflateRawSync(json)
  if (compressed.length > MAX_COMPRESSED) throw new PortableTransferError('too-large')
  const prefix = bundle.version === 1 ? PREFIX_V1 : bundle.version === 2 ? PREFIX_V2 : PREFIX_V3
  const text = `${prefix}${compressed.toString('base64url')}`
  if (text.length > MAX_TEXT) throw new PortableTransferError('too-large')
  return text
}

export function decodePortableBundle(text: unknown): PortableBundle {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return invalid()
  const prefix = text.startsWith(PREFIX_V1)
    ? PREFIX_V1
    : text.startsWith(PREFIX_V2)
    ? PREFIX_V2
    : text.startsWith(PREFIX_V3)
    ? PREFIX_V3
    : undefined
  if (prefix === undefined) return invalid()
  const encoded = text.slice(prefix.length)
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return invalid()
  const compressed = Buffer.from(encoded, 'base64url')
  if (compressed.length > MAX_COMPRESSED || compressed.toString('base64url') !== encoded) return invalid()
  let json: Buffer
  try {
    json = inflateRawSync(compressed, { maxOutputLength: MAX_JSON })
  } catch {
    return invalid()
  }
  let value: unknown
  try {
    value = JSON.parse(json.toString('utf8'))
  } catch {
    return invalid()
  }
  const bundle = validatePortableBundle(value)
  const version = prefix === PREFIX_V1 ? 1 : prefix === PREFIX_V2 ? 2 : 3
  if (bundle.version !== version) return invalid()
  return bundle
}
