import type {
  PlatformProviderAdapterV1,
  PlatformProviderBrokerDeclarationV1,
  PlatformProviderDefinitionV1,
  PlatformProviderFactoryConfigurationV1,
  PlatformProviderJsonValue,
  PlatformProviderLifecycleEventV1,
  PlatformProviderOperationV1,
} from '@cordisx/protocol/platform-provider/v1'

export const VALUE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-value.v1.schema.json'
const FORBIDDEN_AUTHORITY_FIELD =
  /secret|password|token|credential|path|directory|datadir|cwd|executable|process|env|transport|client|fleet|endpoint|url|host|header|auth|cookie/i
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
export const METHOD = /^[a-z][A-Za-z0-9]*(?:[./:-][a-z][A-Za-z0-9]*){0,7}$/u
const OPERATIONS = new Set<PlatformProviderOperationV1>([
  'models.list',
  'sessions.list',
  'sessions.read',
  'sessions.create',
  'sessions.control',
  'turns.submit',
  'turns.control',
  'turns.introduce',
  'approvals.decide',
])

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

export function immutable<Value>(value: Value): Value {
  const cloned = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child)
    Object.freeze(item)
  }
  freeze(cloned)
  return cloned
}

export function safeValue(value: unknown, label = 'broker value', depth = 0): PlatformProviderJsonValue {
  if (depth > 32) throw new Error(`${label} is too deeply nested`)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error(`${label} exceeds the item limit`)
    return value.map((item, index) => safeValue(item, `${label}[${index}]`, depth + 1))
  }
  if (typeof value !== 'object') throw new Error(`${label} is not JSON`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 512) throw new Error(`${label} exceeds the field limit`)
  return Object.fromEntries(entries.map(([key, item]) => {
    if (FORBIDDEN_AUTHORITY_FIELD.test(key)) throw new Error(`${label}.${key} is Host-private`)
    return [key, safeValue(item, `${label}.${key}`, depth + 1)]
  }))
}

export function factoryConfiguration(value: unknown): PlatformProviderFactoryConfigurationV1 {
  const configuration = record(value, 'Platform provider factory configuration')
  exact(configuration, [
    '$schema',
    'contract',
    'schemaVersion',
    'configurationRevision',
    'providerId',
    'displayName',
    'enabled',
    'requestTimeoutMs',
  ], 'Platform provider factory configuration')
  if (
    configuration.$schema
      !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v1.schema.json'
    || configuration.contract !== 'cordisx.platform-provider-factory-configuration/v1'
    || configuration.schemaVersion !== 1
    || !Number.isInteger(configuration.configurationRevision) || (configuration.configurationRevision as number) < 0
    || typeof configuration.providerId !== 'string' || !PROVIDER_ID.test(configuration.providerId)
    || typeof configuration.displayName !== 'string' || configuration.displayName.trim() === ''
    || configuration.displayName.length > 200 || typeof configuration.enabled !== 'boolean'
    || !Number.isInteger(configuration.requestTimeoutMs) || (configuration.requestTimeoutMs as number) < 1_000
    || (configuration.requestTimeoutMs as number) > 120_000
  ) throw new Error('Platform provider factory configuration is invalid')
  return immutable(configuration) as unknown as PlatformProviderFactoryConfigurationV1
}

export function providerDefinition(value: PlatformProviderDefinitionV1): PlatformProviderDefinitionV1 {
  const definition = record(value, 'Platform provider definition')
  exact(definition, ['descriptor', 'mapping', 'brokerRequest', 'createAdapter'], 'Platform provider definition')
  if (typeof definition.createAdapter !== 'function') throw new Error('Platform provider factory is invalid')
  const descriptor = record(definition.descriptor, 'Platform provider descriptor')
  exact(descriptor, [
    '$schema',
    'contract',
    'schemaVersion',
    'providerId',
    'displayName',
    'implementationStatus',
    'operations',
  ], 'Platform provider descriptor')
  if (
    descriptor.$schema
      !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-descriptor.v1.schema.json'
    || descriptor.contract !== 'cordisx.platform-provider-descriptor/v1' || descriptor.schemaVersion !== 1
    || typeof descriptor.providerId !== 'string' || !PROVIDER_ID.test(descriptor.providerId)
    || typeof descriptor.displayName !== 'string' || descriptor.displayName.trim() === ''
    || !['implemented', 'verified', 'experimental', 'unavailable'].includes(String(descriptor.implementationStatus))
    || !Array.isArray(descriptor.operations) || descriptor.operations.length === 0
    || descriptor.operations.some(operation => !OPERATIONS.has(operation as PlatformProviderOperationV1))
    || new Set(descriptor.operations).size !== descriptor.operations.length
  ) throw new Error('Platform provider descriptor is invalid')
  const mapping = record(definition.mapping, 'Platform provider mapping')
  exact(mapping, ['models'], 'Platform provider mapping')
  if (!Array.isArray(mapping.models) || mapping.models.length > 256) {
    throw new Error('Platform provider mapping is invalid')
  }
  const sourceIds = new Set<string>()
  const modelIds = new Set<string>()
  let defaults = 0
  const models = mapping.models.map((candidate, index) => {
    const item = record(candidate, `Platform provider mapping.models[${index}]`)
    exact(item, ['sourceModelId', 'modelId', 'displayName', 'enabled', 'isDefault'], `mapping.models[${index}]`)
    if (
      typeof item.sourceModelId !== 'string' || item.sourceModelId === '' || item.sourceModelId.length > 256
      || typeof item.modelId !== 'string' || item.modelId === '' || item.modelId.length > 256
      || item.displayName !== undefined && (typeof item.displayName !== 'string' || item.displayName === '')
      || typeof item.enabled !== 'boolean' || typeof item.isDefault !== 'boolean'
      || sourceIds.has(item.sourceModelId) || modelIds.has(item.modelId)
    ) throw new Error(`Platform provider mapping.models[${index}] is invalid or duplicated`)
    sourceIds.add(item.sourceModelId)
    modelIds.add(item.modelId)
    if (item.enabled && item.isDefault) defaults += 1
    return immutable(item)
  })
  if (defaults > 1) throw new Error('Platform provider mapping has multiple enabled defaults')
  const brokerRequest = record(definition.brokerRequest, 'Platform provider broker request')
  exact(brokerRequest, ['bindings'], 'Platform provider broker request')
  if (!Array.isArray(brokerRequest.bindings) || brokerRequest.bindings.length === 0) {
    throw new Error('Platform provider broker request is invalid')
  }
  return {
    descriptor: immutable(descriptor) as unknown as PlatformProviderDefinitionV1['descriptor'],
    mapping: immutable({ models }) as unknown as PlatformProviderDefinitionV1['mapping'],
    brokerRequest: immutable(brokerRequest) as unknown as PlatformProviderBrokerDeclarationV1,
    createAdapter: definition.createAdapter as PlatformProviderDefinitionV1['createAdapter'],
  }
}

export function assertAdapter(value: PlatformProviderAdapterV1): void {
  const adapter = record(value, 'Platform provider adapter')
  const models = record(adapter.models, 'Platform provider adapter.models')
  const sessions = record(adapter.sessions, 'Platform provider adapter.sessions')
  const turns = record(adapter.turns, 'Platform provider adapter.turns')
  const approvals = record(adapter.approvals, 'Platform provider adapter.approvals')
  const functions = [
    models.list,
    sessions.list,
    sessions.read,
    sessions.create,
    sessions.control,
    turns.submit,
    turns.control,
    turns.introduce,
    approvals.decide,
    adapter.subscribeLifecycle,
    adapter.drain,
    adapter.dispose,
  ]
  if (functions.some(item => typeof item !== 'function')) throw new Error('Platform provider adapter is incomplete')
}

export function validLifecycleEvent(
  event: PlatformProviderLifecycleEventV1,
  providerId: string,
  providerGeneration: string,
): boolean {
  if (
    event.$schema
      !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-lifecycle-event.v1.schema.json'
    || event.contract !== 'cordisx.platform-provider-lifecycle-event/v1' || event.schemaVersion !== 1
    || event.providerId !== providerId || event.providerGeneration !== providerGeneration
    || event.session.providerId !== providerId || event.turnId.length === 0
  ) return false
  if (event.type === 'turn.completed') {
    return event.terminal && event.failure === undefined && event.approval === undefined
  }
  if (event.type === 'turn.failed') {
    return event.terminal && event.failure !== undefined && event.approval === undefined
  }
  if (event.type === 'turn.started') {
    return !event.terminal && event.output === undefined && event.failure === undefined && event.approval === undefined
  }
  if (event.type === 'approval.required') {
    return !event.terminal && event.output === undefined && event.failure === undefined
      && event.approval.state === 'pending' && event.approval.outcome === undefined
  }
  return !event.terminal && event.output === undefined && event.failure === undefined
    && event.approval.state === 'resolved' && event.approval.outcome !== undefined
}
