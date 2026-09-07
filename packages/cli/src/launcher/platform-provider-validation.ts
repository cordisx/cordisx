import type {
  PlatformProviderAdapterV1,
  PlatformProviderBrokerDeclarationV1,
  PlatformProviderDefinitionV1,
  PlatformProviderJsonValue,
  PlatformProviderLifecycleEventV1,
  PlatformProviderOperationV1,
} from '@cordisx/protocol/platform-provider/v1'
import type {
  PlatformProviderDefinition,
  PlatformProviderFactoryConfiguration,
} from './platform-provider-service-types.js'

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

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
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
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > 4_096) throw new Error(`${label} exceeds the string limit`)
    return value
  }
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

export function providerMapping(value: unknown): PlatformProviderDefinitionV1['mapping'] {
  const mapping = record(value, 'Platform provider mapping')
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
      || item.displayName !== undefined
        && (typeof item.displayName !== 'string' || item.displayName === '' || item.displayName.length > 200)
      || typeof item.enabled !== 'boolean' || typeof item.isDefault !== 'boolean'
      || sourceIds.has(item.sourceModelId) || modelIds.has(item.modelId)
    ) throw new Error(`Platform provider mapping.models[${index}] is invalid or duplicated`)
    sourceIds.add(item.sourceModelId)
    modelIds.add(item.modelId)
    if (item.enabled && item.isDefault) defaults += 1
    return immutable({
      sourceModelId: item.sourceModelId,
      modelId: item.modelId,
      ...(item.displayName === undefined ? {} : { displayName: item.displayName }),
      enabled: item.enabled,
      isDefault: item.isDefault,
    })
  })
  if (defaults > 1) throw new Error('Platform provider mapping has multiple enabled defaults')
  return immutable({ models }) as unknown as PlatformProviderDefinitionV1['mapping']
}

export function factoryConfiguration(value: unknown): PlatformProviderFactoryConfiguration {
  const configuration = record(value, 'Platform provider factory configuration')
  const version = configuration.$schema
        === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v1.schema.json'
      && configuration.contract === 'cordisx.platform-provider-factory-configuration/v1'
      && configuration.schemaVersion === 1
    ? 1
    : configuration.$schema
          === 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json'
        && configuration.contract === 'cordisx.platform-provider-factory-configuration/v2'
        && configuration.schemaVersion === 2
    ? 2
    : undefined
  exact(configuration, [
    '$schema',
    'contract',
    'schemaVersion',
    'configurationRevision',
    'providerId',
    'displayName',
    'enabled',
    'requestTimeoutMs',
    ...(version === 2 ? ['mapping'] : []),
  ], 'Platform provider factory configuration')
  if (
    version === undefined
    || !Number.isInteger(configuration.configurationRevision) || (configuration.configurationRevision as number) < 0
    || typeof configuration.providerId !== 'string' || !PROVIDER_ID.test(configuration.providerId)
    || typeof configuration.displayName !== 'string' || configuration.displayName.trim() === ''
    || configuration.displayName.length > 200 || typeof configuration.enabled !== 'boolean'
    || !Number.isInteger(configuration.requestTimeoutMs) || (configuration.requestTimeoutMs as number) < 1_000
    || (configuration.requestTimeoutMs as number) > 120_000
  ) throw new Error('Platform provider factory configuration is invalid')
  const mapping = version === 2 ? providerMapping(configuration.mapping) : undefined
  return immutable({
    $schema: configuration.$schema,
    contract: configuration.contract,
    schemaVersion: configuration.schemaVersion,
    configurationRevision: configuration.configurationRevision,
    providerId: configuration.providerId,
    displayName: configuration.displayName,
    enabled: configuration.enabled,
    requestTimeoutMs: configuration.requestTimeoutMs,
    ...(mapping === undefined ? {} : { mapping }),
  }) as unknown as PlatformProviderFactoryConfiguration
}

export function providerDefinition(value: PlatformProviderDefinition): PlatformProviderDefinition {
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
  const mapping = providerMapping(definition.mapping)
  const brokerRequest = record(definition.brokerRequest, 'Platform provider broker request')
  exact(brokerRequest, ['bindings'], 'Platform provider broker request')
  if (!Array.isArray(brokerRequest.bindings) || brokerRequest.bindings.length === 0) {
    throw new Error('Platform provider broker request is invalid')
  }
  return {
    descriptor: immutable(descriptor) as unknown as PlatformProviderDefinitionV1['descriptor'],
    mapping,
    brokerRequest: immutable(brokerRequest) as unknown as PlatformProviderBrokerDeclarationV1,
    createAdapter: definition.createAdapter,
  } as PlatformProviderDefinition
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
  value: unknown,
  providerId: string,
  providerGeneration: string,
): value is PlatformProviderLifecycleEventV1 {
  try {
    const event = record(value, 'Platform provider lifecycle event')
    exact(event, [
      '$schema',
      'contract',
      'schemaVersion',
      'eventId',
      'sequence',
      'providerId',
      'providerGeneration',
      'session',
      'turnId',
      'type',
      'terminal',
      'output',
      'failure',
      'approval',
    ], 'Platform provider lifecycle event')
    const session = record(event.session, 'Platform provider lifecycle event.session')
    exact(session, ['providerId', 'remoteSessionId'], 'Platform provider lifecycle event.session')
    if (
      event.$schema
        !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-lifecycle-event.v1.schema.json'
      || event.contract !== 'cordisx.platform-provider-lifecycle-event/v1' || event.schemaVersion !== 1
      || typeof event.eventId !== 'string' || event.eventId.length < 1 || event.eventId.length > 128
      || !Number.isInteger(event.sequence) || (event.sequence as number) < 1
      || event.providerId !== providerId || event.providerGeneration !== providerGeneration
      || session.providerId !== providerId || typeof session.remoteSessionId !== 'string'
      || session.remoteSessionId.length < 1 || session.remoteSessionId.length > 512
      || typeof event.turnId !== 'string' || event.turnId.length < 1 || event.turnId.length > 512
    ) return false
    if (
      event.output !== undefined && (
        !Array.isArray(event.output) || event.output.length > 64
        || event.output.some(item => {
          const output = record(item, 'Platform provider lifecycle event.output')
          exact(output, ['type', 'text'], 'Platform provider lifecycle event.output')
          return output.type !== 'text' || typeof output.text !== 'string' || output.text.length > 1_000_000
        })
      )
    ) return false
    if (event.type === 'turn.completed') {
      return event.terminal === true && event.failure === undefined && event.approval === undefined
    }
    if (event.type === 'turn.failed') {
      const failure = record(event.failure, 'Platform provider lifecycle event.failure')
      exact(failure, ['code', 'retryable'], 'Platform provider lifecycle event.failure')
      return event.terminal === true && event.approval === undefined
        && typeof failure.code === 'string' && failure.code.length >= 1 && failure.code.length <= 128
        && typeof failure.retryable === 'boolean'
    }
    if (event.type === 'turn.started') {
      return event.terminal === false && event.output === undefined && event.failure === undefined
        && event.approval === undefined
    }
    if (event.type !== 'approval.required' && event.type !== 'approval.resolved') return false
    const approval = record(event.approval, 'Platform provider lifecycle event.approval')
    exact(approval, ['approvalId', 'kind', 'state', 'outcome'], 'Platform provider lifecycle event.approval')
    if (
      event.terminal !== false || event.output !== undefined || event.failure !== undefined
      || typeof approval.approvalId !== 'string' || approval.approvalId.length < 1 || approval.approvalId.length > 512
      || !['command', 'file-change', 'external-action', 'other'].includes(String(approval.kind))
    ) return false
    return event.type === 'approval.required'
      ? approval.state === 'pending' && approval.outcome === undefined
      : approval.state === 'resolved'
        && ['approved', 'denied', 'expired', 'cancelled'].includes(String(approval.outcome))
  } catch {
    return false
  }
}
