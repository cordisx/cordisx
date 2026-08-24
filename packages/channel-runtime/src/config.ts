import type { ChannelAdapterKind, ChannelTenantRef } from './types.js'

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
export type ChannelNotificationKind =
  | 'completion'
  | 'failure'
  | 'approval-required'
  | 'approval-resolved'
  | 'approval-expired'

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

export type ChannelServiceSelector = { readonly useDefault: true } | { readonly id: string }

export interface ChannelServiceRoutePolicy {
  readonly conversationKinds?: readonly ('direct' | 'group' | 'broadcast')[]
  readonly allowedUserIds?: readonly string[]
  readonly allowedConversationIds?: readonly string[]
  readonly groupTrigger?: 'deny' | 'mention' | 'reply' | 'command' | 'mention-or-command'
  readonly commandPrefixes?: readonly string[]
}

export interface ChannelServiceTaskMapping {
  readonly provider: ChannelServiceSelector
  readonly model: ChannelServiceSelector
  readonly profile: ChannelServiceSelector
  readonly workspaceAlias: string
}

export interface ChannelServiceRouteConfig {
  readonly id: string
  readonly connection: ChannelTenantRef
  readonly enabled: boolean
  readonly policy: ChannelServiceRoutePolicy
  readonly task: ChannelServiceTaskMapping
  readonly notifications: readonly ChannelNotificationKind[]
}

export interface ChannelServiceReliabilityConfig {
  readonly leaseMs: number
  readonly retry: {
    readonly maxAttempts: number
    readonly baseDelayMs: number
    readonly maxDelayMs: number
    readonly maxAgeMs: number
    readonly jitterRatio: number
  }
  readonly rateLimit: {
    readonly perAccountPerMinute: number
    readonly perUserPerMinute: number
    readonly perConversationPerMinute: number
    readonly maxConcurrent: number
    readonly maxBacklog: number
  }
  readonly attachments: {
    readonly maxFiles: number
    readonly maxBytesPerFile: number
    readonly allowedMediaTypes: readonly string[]
  }
}

export interface ChannelServiceConfigV1 {
  readonly contract: 'cordisx.channel-service-config/v1'
  readonly schemaVersion: 1
  readonly connections: readonly ChannelServiceConnectionConfig[]
  readonly routes: readonly ChannelServiceRouteConfig[]
  readonly reliability: ChannelServiceReliabilityConfig
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
  readonly configuration: {
    readonly contract: 'cordisx.channel-service-config/v1'
    readonly schemaVersion: 1
    readonly connections: ReadonlyArray<Omit<ChannelServiceConnectionConfig, 'secretRef'> & {
      readonly secretState: ChannelSecretState
    }>
    readonly routes: readonly ChannelServiceRouteConfig[]
    readonly reliability: ChannelServiceReliabilityConfig
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
    readonly projection: { readonly kind: 'standard'; readonly renderable: false }
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
const WORKSPACE_ALIAS = /^[a-z0-9][a-z0-9._-]*$/
const CALLBACK_ALIAS = /^[a-z0-9][a-z0-9._-]*$/
const SECRET_REF = /^(?:keychain|host-secret):[A-Za-z0-9][A-Za-z0-9._:/-]{0,500}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/
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
const CONVERSATION_KINDS = new Set(['direct', 'group', 'broadcast'] as const)
const GROUP_TRIGGERS = new Set(['deny', 'mention', 'reply', 'command', 'mention-or-command'] as const)
const NOTIFICATION_KINDS = new Set<ChannelNotificationKind>([
  'completion',
  'failure',
  'approval-required',
  'approval-resolved',
  'approval-expired',
])

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
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || pattern !== undefined && !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} through ${maximum}`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function array(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum} through ${maximum} items`)
  }
  return value
}

function distinct<T>(values: readonly T[], label: string, key: (value: T) => string = value => String(value)): readonly T[] {
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
  if (transport.callbackAlias !== undefined) throw new TypeError(`${label}.callbackAlias is supported only for webhook mode`)
  return { mode }
}

function allowedModes(kind: ChannelAdapterKind): ReadonlySet<ChannelTransportMode> {
  switch (kind) {
    case 'simulator': return new Set(['simulator'])
    case 'feishu':
    case 'lark':
    case 'wecom-intelligent-bot': return new Set(['websocket', 'webhook'])
    case 'wecom-enterprise-app':
    case 'wechat-service': return new Set(['webhook'])
    case 'wecom-message-push': return new Set(['outbound-webhook'])
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

function stringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
  pattern?: RegExp,
): readonly string[] {
  return distinct(array(value, label, 1, maximumItems)
    .map((item, index) => text(item, `${label}[${index}]`, maximumLength, pattern)), label)
}

function selector(value: unknown, label: string): ChannelServiceSelector {
  const selected = record(value, label)
  const keys = Object.keys(selected)
  if (keys.length !== 1) throw new TypeError(`${label} must select one id or explicit default`)
  if (Object.hasOwn(selected, 'useDefault')) {
    if (selected.useDefault !== true) throw new TypeError(`${label}.useDefault must be true`)
    return { useDefault: true }
  }
  if (Object.hasOwn(selected, 'id')) return { id: text(selected.id, `${label}.id`, 128) }
  throw new TypeError(`${label} must select one id or explicit default`)
}

function parsePolicy(value: unknown, label: string): ChannelServiceRoutePolicy {
  const policy = record(value, label)
  exactKeys(policy, [
    'conversationKinds', 'allowedUserIds', 'allowedConversationIds', 'groupTrigger', 'commandPrefixes',
  ], label)
  const conversationKinds = policy.conversationKinds === undefined ? undefined : distinct(
    array(policy.conversationKinds, `${label}.conversationKinds`, 1, 3)
      .map((item, index) => enumValue(item, CONVERSATION_KINDS, `${label}.conversationKinds[${index}]`)),
    `${label}.conversationKinds`,
  )
  const allowedUserIds = policy.allowedUserIds === undefined
    ? undefined
    : stringList(policy.allowedUserIds, `${label}.allowedUserIds`, 256, 512)
  const allowedConversationIds = policy.allowedConversationIds === undefined
    ? undefined
    : stringList(policy.allowedConversationIds, `${label}.allowedConversationIds`, 256, 512)
  const groupTrigger = policy.groupTrigger === undefined
    ? undefined
    : enumValue(policy.groupTrigger, GROUP_TRIGGERS, `${label}.groupTrigger`)
  const commandPrefixes = policy.commandPrefixes === undefined
    ? undefined
    : stringList(policy.commandPrefixes, `${label}.commandPrefixes`, 16, 32)
  if ((groupTrigger === 'command' || groupTrigger === 'mention-or-command') && commandPrefixes === undefined) {
    throw new TypeError(`${label}.commandPrefixes is required by ${groupTrigger}`)
  }
  return {
    ...(conversationKinds === undefined ? {} : { conversationKinds }),
    ...(allowedUserIds === undefined ? {} : { allowedUserIds }),
    ...(allowedConversationIds === undefined ? {} : { allowedConversationIds }),
    ...(groupTrigger === undefined ? {} : { groupTrigger }),
    ...(commandPrefixes === undefined ? {} : { commandPrefixes }),
  }
}

function parseTask(value: unknown, label: string): ChannelServiceTaskMapping {
  const task = record(value, label)
  exactKeys(task, ['provider', 'model', 'profile', 'workspaceAlias'], label)
  return {
    provider: selector(task.provider, `${label}.provider`),
    model: selector(task.model, `${label}.model`),
    profile: selector(task.profile, `${label}.profile`),
    workspaceAlias: text(task.workspaceAlias, `${label}.workspaceAlias`, 128, WORKSPACE_ALIAS),
  }
}

function parseRoute(value: unknown, label: string): ChannelServiceRouteConfig {
  const route = record(value, label)
  exactKeys(route, ['id', 'connection', 'enabled', 'policy', 'task', 'notifications'], label)
  const notifications = distinct(array(route.notifications, `${label}.notifications`, 0, 5)
    .map((item, index) => enumValue(item, NOTIFICATION_KINDS, `${label}.notifications[${index}]`)), `${label}.notifications`)
  return {
    id: text(route.id, `${label}.id`, 512),
    connection: tenantRef(route.connection, `${label}.connection`),
    enabled: boolean(route.enabled, `${label}.enabled`),
    policy: parsePolicy(route.policy, `${label}.policy`),
    task: parseTask(route.task, `${label}.task`),
    notifications,
  }
}

function parseReliability(value: unknown, label: string): ChannelServiceReliabilityConfig {
  const reliability = record(value, label)
  exactKeys(reliability, ['leaseMs', 'retry', 'rateLimit', 'attachments'], label)
  const retry = record(reliability.retry, `${label}.retry`)
  exactKeys(retry, ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'maxAgeMs', 'jitterRatio'], `${label}.retry`)
  const parsedRetry = {
    maxAttempts: integer(retry.maxAttempts, `${label}.retry.maxAttempts`, 1, 100),
    baseDelayMs: integer(retry.baseDelayMs, `${label}.retry.baseDelayMs`, 1, 3_600_000),
    maxDelayMs: integer(retry.maxDelayMs, `${label}.retry.maxDelayMs`, 1, 86_400_000),
    maxAgeMs: integer(retry.maxAgeMs, `${label}.retry.maxAgeMs`, 1_000, 2_592_000_000),
    jitterRatio: finite(retry.jitterRatio, `${label}.retry.jitterRatio`, 0, 1),
  }
  if (parsedRetry.baseDelayMs > parsedRetry.maxDelayMs) throw new TypeError(`${label}.retry.baseDelayMs exceeds maxDelayMs`)
  if (parsedRetry.maxDelayMs > parsedRetry.maxAgeMs) throw new TypeError(`${label}.retry.maxDelayMs exceeds maxAgeMs`)

  const rate = record(reliability.rateLimit, `${label}.rateLimit`)
  exactKeys(rate, [
    'perAccountPerMinute', 'perUserPerMinute', 'perConversationPerMinute', 'maxConcurrent', 'maxBacklog',
  ], `${label}.rateLimit`)
  const attachments = record(reliability.attachments, `${label}.attachments`)
  exactKeys(attachments, ['maxFiles', 'maxBytesPerFile', 'allowedMediaTypes'], `${label}.attachments`)
  const mediaTypes = distinct(array(attachments.allowedMediaTypes, `${label}.attachments.allowedMediaTypes`, 0, 64)
    .map((item, index) => text(item, `${label}.attachments.allowedMediaTypes[${index}]`, 127, MEDIA_TYPE)),
  `${label}.attachments.allowedMediaTypes`)
  return {
    leaseMs: integer(reliability.leaseMs, `${label}.leaseMs`, 1_000, 3_600_000),
    retry: parsedRetry,
    rateLimit: {
      perAccountPerMinute: integer(rate.perAccountPerMinute, `${label}.rateLimit.perAccountPerMinute`, 1, 100_000),
      perUserPerMinute: integer(rate.perUserPerMinute, `${label}.rateLimit.perUserPerMinute`, 1, 10_000),
      perConversationPerMinute: integer(rate.perConversationPerMinute, `${label}.rateLimit.perConversationPerMinute`, 1, 10_000),
      maxConcurrent: integer(rate.maxConcurrent, `${label}.rateLimit.maxConcurrent`, 1, 1_000),
      maxBacklog: integer(rate.maxBacklog, `${label}.rateLimit.maxBacklog`, 1, 100_000),
    },
    attachments: {
      maxFiles: integer(attachments.maxFiles, `${label}.attachments.maxFiles`, 0, 32),
      maxBytesPerFile: integer(attachments.maxBytesPerFile, `${label}.attachments.maxBytesPerFile`, 1, 1_073_741_824),
      allowedMediaTypes: mediaTypes,
    },
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

export function parseChannelServiceConfig(value: unknown): ChannelServiceConfigV1 {
  const config = record(value, 'Channel service configuration')
  exactKeys(config, ['contract', 'schemaVersion', 'connections', 'routes', 'reliability'], 'Channel service configuration')
  if (config.contract !== 'cordisx.channel-service-config/v1' || config.schemaVersion !== 1) {
    throw new TypeError('Channel service configuration contract/version is unsupported')
  }
  const connections = distinct(array(config.connections, 'Channel service configuration.connections', 1, 64)
    .map((item, index) => parseConnection(item, `Channel service configuration.connections[${index}]`)),
  'Channel service configuration.connections', connection => tenantKey(connection.ref))
  const connectionKeys = new Set(connections.map(connection => tenantKey(connection.ref)))
  const routes = distinct(array(config.routes, 'Channel service configuration.routes', 0, 256)
    .map((item, index) => parseRoute(item, `Channel service configuration.routes[${index}]`)),
  'Channel service configuration.routes', route => route.id)
  for (const route of routes) {
    if (!connectionKeys.has(tenantKey(route.connection))) {
      throw new TypeError(`Channel service route ${route.id} references a missing connection`)
    }
  }
  return immutable({
    contract: 'cordisx.channel-service-config/v1',
    schemaVersion: 1,
    connections,
    routes,
    reliability: parseReliability(config.reliability, 'Channel service configuration.reliability'),
  })
}

export function parseChannelServiceConfigurationDeclaration(value: unknown): ChannelServiceConfigurationDeclaration {
  const declaration = record(value, 'Channel service configuration declaration')
  if (declaration.kind === 'none') {
    exactKeys(declaration, ['kind'], 'Channel service configuration declaration')
    return Object.freeze({ kind: 'none' })
  }
  exactKeys(declaration, ['kind', 'schema', 'configApplies'], 'Channel service configuration declaration')
  if (declaration.kind !== 'host'
    || declaration.schema !== CHANNEL_SERVICE_CONFIG_SCHEMA_V1
    || declaration.configApplies !== 'restart') {
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
  if (lastGoodRevision > currentRevision) throw new TypeError('Channel service config lastGoodRevision exceeds revision')
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
    configuration: {
      contract: configuration.contract,
      schemaVersion: configuration.schemaVersion,
      connections,
      routes: configuration.routes,
      reliability: configuration.reliability,
    },
  })
}

/** Safe disabled default for the generic Host service-configuration store. */
export const CHANNEL_SERVICE_CONFIG_INITIAL: ChannelServiceConfigV1 = parseChannelServiceConfig({
  contract: 'cordisx.channel-service-config/v1',
  schemaVersion: 1,
  connections: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'default' },
    adapterKind: 'simulator',
    enabled: false,
    transport: { mode: 'simulator' },
  }],
  routes: [],
  reliability: {
    leaseMs: 30_000,
    retry: {
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      maxAgeMs: 86_400_000,
      jitterRatio: 0.2,
    },
    rateLimit: {
      perAccountPerMinute: 120,
      perUserPerMinute: 20,
      perConversationPerMinute: 60,
      maxConcurrent: 8,
      maxBacklog: 1_000,
    },
    attachments: {
      maxFiles: 4,
      maxBytesPerFile: 10_485_760,
      allowedMediaTypes: ['image/png', 'text/plain'],
    },
  },
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
      projection: Object.freeze({ kind: 'standard', renderable: false }),
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
