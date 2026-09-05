import type { ChannelAdapterKind, ChannelTenantRef } from './types.js'
import Schema from '@deepseek-ai/schemastery'

export const CHANNEL_SERVICE_CONFIG_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json'
export const CHANNEL_SERVICE_CONFIG_DESCRIPTOR_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config-descriptor.v1.schema.json'
export const CHANNEL_PLUGIN_MANIFEST_SCHEMA_V4 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v4.schema.json'
/** Legacy schema reference retained for persisted descriptor compatibility. */
export const CHANNEL_PLUGIN_MANIFEST_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v3.schema.json'

export type ChannelTransportMode = 'simulator' | 'websocket' | 'webhook' | 'outbound-webhook'
export type ChannelSecretState = 'missing' | 'ready' | 'unavailable'

export interface ChannelServiceTransportConfig {
  readonly mode: ChannelTransportMode
  readonly callbackAlias?: string
}

export interface ChannelServiceConnectionConfig {
  readonly ref: ChannelTenantRef
  readonly adapterKind: ChannelAdapterKind
  readonly enabled: boolean
  readonly transport: ChannelServiceTransportConfig
  /** Opaque launcher credential-store handle. Never project this to renderer. */
  readonly secretRef?: string
}

export interface ChannelServiceConfigV1 {
  readonly contract: 'cordisx.channel-service-config/v1'
  readonly schemaVersion: 1
  readonly connections: readonly ChannelServiceConnectionConfig[]
}

export type ChannelServiceConfigurationDeclaration =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'host'
    readonly schema: typeof CHANNEL_SERVICE_CONFIG_SCHEMA_V1
    readonly configApplies: 'restart'
  }

export interface ChannelServiceConfigDescriptorV1 {
  readonly contract: 'cordisx.channel-service-config-descriptor/v1'
  readonly schemaVersion: 1
  readonly identity: {
    readonly source: string
    readonly pluginId: string
    readonly serviceId: string
  }
  readonly scope: {
    readonly profileId: string
    readonly generation: string
  }
  readonly revision: number
  readonly lastGoodRevision: number
  readonly configApplies: 'restart'
  readonly writable: boolean
  readonly schema: {
    readonly id: typeof CHANNEL_SERVICE_CONFIG_SCHEMA_V1
    readonly projection: { readonly kind: 'schemastery'; readonly envelope: Readonly<Record<string, unknown>> }
  }
  readonly configuration: {
    readonly contract: 'cordisx.channel-service-config/v1'
    readonly schemaVersion: 1
    readonly connections: ReadonlyArray<
      Omit<ChannelServiceConnectionConfig, 'secretRef'> & {
        readonly secretState: ChannelSecretState
      }
    >
  }
}

export interface ChannelServiceConfigProjectionInput {
  readonly declaration: unknown
  readonly configuration?: unknown
  readonly identity: ChannelServiceConfigDescriptorV1['identity']
  readonly scope: ChannelServiceConfigDescriptorV1['scope']
  readonly revision: number
  readonly lastGoodRevision: number
  readonly writable: boolean
  readonly resolveSecretState?: (
    secretRef: string | undefined,
    connection: ChannelTenantRef,
  ) => ChannelSecretState
}

export interface ChannelHostServiceConfigContract {
  readonly identity: { readonly source: string; readonly pluginId: string; readonly serviceId: string }
  readonly schema: {
    readonly id: typeof CHANNEL_SERVICE_CONFIG_SCHEMA_V1
    readonly projection: { readonly kind: 'schemastery'; readonly envelope: Readonly<Record<string, unknown>> }
  }
  readonly configApplies: 'service-restart'
  readonly initialConfiguration: unknown
  parseStored(value: unknown): unknown
  normalizeMutation(value: unknown, current: unknown): unknown
  project(
    value: unknown,
    secretState: (secretRef: string | undefined) => ChannelSecretState,
  ): {
    readonly configuration: unknown
    readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  }
}

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const ADAPTER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/
const CALLBACK_ALIAS = /^[a-z0-9][a-z0-9._-]*$/
const SECRET_REF = /^(?:keychain|host-secret):[A-Za-z0-9][A-Za-z0-9._:/-]{0,500}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ADAPTER_KINDS = new Set<ChannelAdapterKind>([
  'simulator',
  'feishu',
  'lark',
  'wecom-intelligent-bot',
  'wecom-enterprise-app',
  'wecom-message-push',
  'wechat-service',
])
const TRANSPORT_MODES = new Set<ChannelTransportMode>(['simulator', 'websocket', 'webhook', 'outbound-webhook'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is not supported`)
}

function text(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > maximum
    || pattern !== undefined && !pattern.test(value)
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function array(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum} through ${maximum} items`)
  }
  return value
}

function distinct<T>(
  values: readonly T[],
  label: string,
  key: (value: T) => string = value => String(value),
): readonly T[] {
  const seen = new Set<string>()
  for (const value of values) {
    const identity = key(value)
    if (seen.has(identity)) throw new TypeError(`${label} contains duplicate ${identity}`)
    seen.add(identity)
  }
  return values
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new TypeError(`${label} is invalid`)
  return value as T
}

function tenantRef(value: unknown, label: string): ChannelTenantRef {
  const ref = record(value, label)
  exactKeys(ref, ['adapterId', 'accountId', 'tenantId'], label)
  return {
    adapterId: text(ref.adapterId, `${label}.adapterId`, 128, ADAPTER_ID),
    accountId: text(ref.accountId, `${label}.accountId`, 512),
    tenantId: text(ref.tenantId, `${label}.tenantId`, 512),
  }
}

function tenantKey(ref: ChannelTenantRef): string {
  return JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
}

function parseTransport(value: unknown, label: string): ChannelServiceTransportConfig {
  const transport = record(value, label)
  exactKeys(transport, ['mode', 'callbackAlias'], label)
  const mode = enumValue(transport.mode, TRANSPORT_MODES, `${label}.mode`)
  if (mode === 'webhook') {
    return {
      mode,
      callbackAlias: text(transport.callbackAlias, `${label}.callbackAlias`, 128, CALLBACK_ALIAS),
    }
  }
  if (transport.callbackAlias !== undefined) {
    throw new TypeError(`${label}.callbackAlias is supported only for webhook mode`)
  }
  return { mode }
}

function allowedModes(kind: ChannelAdapterKind): ReadonlySet<ChannelTransportMode> {
  switch (kind) {
    case 'simulator':
      return new Set(['simulator'])
    case 'feishu':
    case 'lark':
    case 'wecom-intelligent-bot':
      return new Set(['websocket', 'webhook'])
    case 'wecom-enterprise-app':
    case 'wechat-service':
      return new Set(['webhook'])
    case 'wecom-message-push':
      return new Set(['outbound-webhook'])
  }
}

function parseConnection(value: unknown, label: string): ChannelServiceConnectionConfig {
  const connection = record(value, label)
  exactKeys(connection, ['ref', 'adapterKind', 'enabled', 'transport', 'secretRef'], label)
  const ref = tenantRef(connection.ref, `${label}.ref`)
  const adapterKind = enumValue(connection.adapterKind, ADAPTER_KINDS, `${label}.adapterKind`)
  const transport = parseTransport(connection.transport, `${label}.transport`)
  if (!allowedModes(adapterKind).has(transport.mode)) {
    throw new TypeError(`${label}.transport.mode is not supported by ${adapterKind}`)
  }
  if (adapterKind === 'simulator') {
    if (connection.secretRef !== undefined) throw new TypeError(`${label}.secretRef is not supported by simulator`)
    return { ref, adapterKind, enabled: boolean(connection.enabled, `${label}.enabled`), transport }
  }
  return {
    ref,
    adapterKind,
    enabled: boolean(connection.enabled, `${label}.enabled`),
    transport,
    secretRef: text(connection.secretRef, `${label}.secretRef`, 512, SECRET_REF),
  }
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

const ChannelConnectionConfigSchema = Schema.object({
  contract: Schema.const('cordisx.channel-service-config/v1'),
  schemaVersion: Schema.const(1),
  connections: Schema.array(Schema.object({
    ref: Schema.object({
      adapterId: Schema.string().required().max(128),
      accountId: Schema.string().required().max(512),
      tenantId: Schema.string().required().max(512),
    }),
    adapterKind: Schema.string().required(),
    enabled: Schema.boolean().default(true),
    transport: Schema.object({
      mode: Schema.string().required(),
      callbackAlias: Schema.string().max(128),
    }),
    secretRef: Schema.string().max(512).role('credential-ref'),
  })).default([]).max(64),
})

function channelConnectionSchemasteryProjection(): {
  readonly kind: 'schemastery'
  readonly envelope: Readonly<Record<string, unknown>>
  readonly form: {
    readonly version: 1
    readonly fields: readonly {
      readonly path: readonly ['connections']
      readonly presenter: { readonly version: 1; readonly kind: 'array.object-page' }
    }[]
  }
} {
  return Object.freeze({
    kind: 'schemastery' as const,
    envelope: immutable(JSON.parse(JSON.stringify(ChannelConnectionConfigSchema.toJSON())) as Record<string, unknown>),
    form: Object.freeze({
      version: 1 as const,
      fields: Object.freeze([Object.freeze({
        path: Object.freeze(['connections'] as const),
        presenter: Object.freeze({ version: 1 as const, kind: 'array.object-page' as const }),
      })]),
    }),
  })
}

export function parseChannelServiceConfig(value: unknown): ChannelServiceConfigV1 {
  const config = record(value, 'Channel service configuration')
  exactKeys(config, ['contract', 'schemaVersion', 'connections'], 'Channel service configuration')
  if (config.contract !== 'cordisx.channel-service-config/v1' || config.schemaVersion !== 1) {
    throw new TypeError('Channel service configuration contract/version is unsupported')
  }
  const connections = distinct(
    array(config.connections, 'Channel service configuration.connections', 0, 64)
      .map((item, index) => parseConnection(item, `Channel service configuration.connections[${index}]`)),
    'Channel service configuration.connections',
    connection => tenantKey(connection.ref),
  )
  return immutable({
    contract: 'cordisx.channel-service-config/v1',
    schemaVersion: 1,
    connections,
  })
}

export function parseChannelServiceConfigurationDeclaration(value: unknown): ChannelServiceConfigurationDeclaration {
  const declaration = record(value, 'Channel service configuration declaration')
  if (declaration.kind === 'none') {
    exactKeys(declaration, ['kind'], 'Channel service configuration declaration')
    return Object.freeze({ kind: 'none' })
  }
  exactKeys(declaration, ['kind', 'schema', 'configApplies'], 'Channel service configuration declaration')
  if (
    declaration.kind !== 'host'
    || declaration.schema !== CHANNEL_SERVICE_CONFIG_SCHEMA_V1
    || declaration.configApplies !== 'restart'
  ) {
    throw new TypeError('Channel service Host configuration declaration is unsupported')
  }
  return Object.freeze({
    kind: 'host',
    schema: CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
    configApplies: 'restart',
  })
}

function canonicalSource(value: unknown): string {
  const source = text(value, 'Channel service config identity.source', 2048)
  if (!/^(?:https:\/\/[^?#]+|file:\/\/\/[^?#]+)$/.test(source)) {
    throw new TypeError('Channel service config identity.source must be an unqualified https or file URL')
  }
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw new TypeError('Channel service config identity.source must be a canonical URL')
  }
  if (!['https:', 'file:'].includes(parsed.protocol) || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('Channel service config identity.source must be an unqualified https or file URL')
  }
  return source
}

function localId(value: unknown, label: string): string {
  return text(value, label, 96, LOCAL_ID)
}

function revision(value: unknown, label: string): number {
  return integer(value, label, 0, Number.MAX_SAFE_INTEGER)
}

/**
 * Build the only renderer-visible configuration view for a launcher Channel
 * service. A `none` declaration returns no descriptor and rejects any supplied
 * placeholder configuration. Host-owned secret handles are consumed only by
 * the readiness resolver and cannot enter the returned object.
 */
export function projectChannelServiceConfig(
  input: ChannelServiceConfigProjectionInput,
): ChannelServiceConfigDescriptorV1 | undefined {
  const declaration = parseChannelServiceConfigurationDeclaration(input.declaration)
  if (declaration.kind === 'none') {
    if (input.configuration !== undefined) {
      throw new TypeError('A no-configuration Channel service must not receive a configuration value')
    }
    return undefined
  }
  if (input.configuration === undefined) throw new TypeError('Channel service Host configuration is required')
  const configuration = parseChannelServiceConfig(input.configuration)
  const currentRevision = revision(input.revision, 'Channel service config revision')
  const lastGoodRevision = revision(input.lastGoodRevision, 'Channel service config lastGoodRevision')
  if (lastGoodRevision > currentRevision) {
    throw new TypeError('Channel service config lastGoodRevision exceeds revision')
  }
  const generation = text(input.scope.generation, 'Channel service config scope.generation', 128, GENERATION)
  if (typeof input.writable !== 'boolean') throw new TypeError('Channel service config writable must be a boolean')

  const connections = configuration.connections.map(connection => ({
    ref: connection.ref,
    adapterKind: connection.adapterKind,
    enabled: connection.enabled,
    transport: connection.transport,
    secretState: input.resolveSecretState?.(connection.secretRef, connection.ref) ?? 'unavailable',
  }))
  for (const [index, connection] of connections.entries()) {
    if (!(['missing', 'ready', 'unavailable'] as const).includes(connection.secretState)) {
      throw new TypeError(`Channel service config connection ${index} has an invalid secret state`)
    }
  }

  return immutable({
    contract: 'cordisx.channel-service-config-descriptor/v1',
    schemaVersion: 1,
    identity: {
      source: canonicalSource(input.identity.source),
      pluginId: localId(input.identity.pluginId, 'Channel service config identity.pluginId'),
      serviceId: localId(input.identity.serviceId, 'Channel service config identity.serviceId'),
    },
    scope: {
      profileId: localId(input.scope.profileId, 'Channel service config scope.profileId'),
      generation,
    },
    revision: currentRevision,
    lastGoodRevision,
    configApplies: 'restart',
    writable: input.writable,
    schema: {
      id: CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
      projection: channelConnectionSchemasteryProjection(),
    },
    configuration: {
      contract: configuration.contract,
      schemaVersion: configuration.schemaVersion,
      connections,
    },
  })
}

/** Safe disabled default for the generic Host service-configuration store. */
export const CHANNEL_SERVICE_CONFIG_INITIAL: ChannelServiceConfigV1 = parseChannelServiceConfig({
  contract: 'cordisx.channel-service-config/v1',
  schemaVersion: 1,
  connections: [],
})

function mergeCurrentSecretRefs(value: unknown, current: unknown): ChannelServiceConfigV1 {
  const candidate = record(structuredClone(value), 'Channel service configuration mutation')
  const stored = parseChannelServiceConfig(current)
  const storedByTenant = new Map(stored.connections.map(connection => [tenantKey(connection.ref), connection]))
  const candidateConnections = array(
    candidate.connections,
    'Channel service configuration mutation.connections',
    1,
    64,
  ).map((value, index) => {
    const connection = record(value, `Channel service configuration mutation.connections[${index}]`)
    if (connection.secretRef !== undefined) return connection
    const connectionRef = tenantRef(connection.ref, `Channel service configuration mutation.connections[${index}].ref`)
    const secretRef = storedByTenant.get(tenantKey(connectionRef))?.secretRef
    return secretRef === undefined ? connection : { ...connection, secretRef }
  })
  return parseChannelServiceConfig({ ...candidate, connections: candidateConnections })
}

/**
 * Adapter for the generic launcher HostServiceConfigNarrowApi. The closed
 * manifest-v4 `restart` declaration maps to the Host's precise
 * `service-restart` application plane; no renderer Config document is created.
 */
export function createChannelHostServiceConfigContract(
  identity: ChannelHostServiceConfigContract['identity'],
  initialConfiguration: unknown = CHANNEL_SERVICE_CONFIG_INITIAL,
): ChannelHostServiceConfigContract {
  const initial = parseChannelServiceConfig(initialConfiguration)
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    schema: Object.freeze({
      id: CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
      projection: channelConnectionSchemasteryProjection(),
    }),
    configApplies: 'service-restart',
    initialConfiguration: initial,
    parseStored: (value: unknown) => parseChannelServiceConfig(value),
    normalizeMutation: (value: unknown, current: unknown) => mergeCurrentSecretRefs(value, current),
    project: (value: unknown, secretState: (secretRef: string | undefined) => ChannelSecretState) => {
      const configuration = parseChannelServiceConfig(value)
      return immutable({
        configuration: {
          ...configuration,
          connections: configuration.connections.map(({ secretRef: _secretRef, ...connection }) => connection),
        },
        secrets: configuration.connections.flatMap((connection, index) => (
          connection.adapterKind === 'simulator'
            ? []
            : [{
              path: ['connections', String(index), 'secretRef'],
              set: secretState(connection.secretRef) === 'ready',
            }]
        )),
      })
    },
  })
}
