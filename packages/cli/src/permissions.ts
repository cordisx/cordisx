import {
  CORDISX_PERMISSION_POLICY_SCHEMA_V1,
  CORDISX_PLATFORM_CAPABILITIES,
  type CordisXCapabilityScope,
  type CordisXPermissionPolicyRecordV1,
  type CordisXPlatformCapability,
  type CordisXPlatformSessionRef,
  type CordisXPluginIdentity,
} from './platform-contracts.js'

const PROFILE_OR_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringList(
  value: unknown,
  label: string,
  maximum: number,
  validate: (item: string) => boolean = () => true,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some(item => (
    typeof item !== 'string' || item.trim() === '' || !validate(item.trim())
  ))) throw new Error(`${label} must be a non-empty string array`)
  const normalized = [...new Set(value.map(item => item.trim()))].sort()
  if (normalized.length !== value.length) throw new Error(`${label} must not contain duplicates`)
  return Object.freeze(normalized)
}

function sessionList(value: unknown, label: string): readonly CordisXPlatformSessionRef[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`${label} must be a non-empty session reference array`)
  }
  const seen = new Set<string>()
  const sessions = value.map((item, index): CordisXPlatformSessionRef => {
    const ref = object(item, `${label}[${index}]`)
    const unknown = Object.keys(ref).find(key => !['providerId', 'remoteSessionId'].includes(key))
    if (unknown !== undefined) throw new Error(`${label}[${index}] contains unknown field ${unknown}`)
    if (typeof ref.providerId !== 'string' || !PROVIDER_ID.test(ref.providerId)) {
      throw new Error(`${label}[${index}].providerId is invalid`)
    }
    if (typeof ref.remoteSessionId !== 'string' || ref.remoteSessionId.trim() === '' || ref.remoteSessionId.length > 512) {
      throw new Error(`${label}[${index}].remoteSessionId is invalid`)
    }
    const normalized = Object.freeze({ providerId: ref.providerId, remoteSessionId: ref.remoteSessionId })
    const key = JSON.stringify([normalized.providerId, normalized.remoteSessionId])
    if (seen.has(key)) throw new Error(`${label} must not contain duplicate session references`)
    seen.add(key)
    return normalized
  })
  return Object.freeze(sessions.sort((left, right) => JSON.stringify([
    left.providerId,
    left.remoteSessionId,
  ]).localeCompare(JSON.stringify([right.providerId, right.remoteSessionId]))))
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export function normalizePermissionScope(value: unknown, label = 'permission scope'): CordisXCapabilityScope {
  const scope = object(value, label)
  const unknown = Object.keys(scope).filter(key => !['providers', 'cwdRoots', 'sessions', 'sessionIds'].includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
  const providers = stringList(scope.providers, `${label}.providers`, 32, item => PROVIDER_ID.test(item))
  const cwdRoots = stringList(scope.cwdRoots, `${label}.cwdRoots`, 32, item => item.length <= 4096)
  const sessions = sessionList(scope.sessions, `${label}.sessions`)
  const sessionIds = stringList(scope.sessionIds, `${label}.sessionIds`, 100, item => item.length <= 512)
  if (cwdRoots?.some(root => !absolutePath(root)) === true) throw new Error(`${label}.cwdRoots must contain absolute paths`)
  return Object.freeze({
    ...(providers === undefined ? {} : { providers }),
    ...(cwdRoots === undefined ? {} : { cwdRoots }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(sessionIds === undefined ? {} : { sessionIds }),
  })
}

export function permissionScopeFingerprint(capability: CordisXPlatformCapability, scope: CordisXCapabilityScope): string {
  return JSON.stringify({ name: capability, scope: normalizePermissionScope(scope) })
}

export function permissionIdentityKey(identity: CordisXPluginIdentity): string {
  return JSON.stringify([identity.source, identity.id])
}

export function permissionRecordKey(record: CordisXPermissionPolicyRecordV1): string {
  return JSON.stringify([
    record.key.profileId,
    record.key.identity.source,
    record.key.identity.pluginId,
    record.key.capability,
    normalizePermissionScope(record.key.scope),
  ])
}

export function normalizePermissionPolicyRecord(value: unknown, label = 'permission policy'): CordisXPermissionPolicyRecordV1 {
  const record = object(value, label)
  const unknown = Object.keys(record).filter(key => !['$schema', 'schemaVersion', 'key', 'policy'].includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
  if (record.$schema !== CORDISX_PERMISSION_POLICY_SCHEMA_V1 || record.schemaVersion !== 1) {
    throw new Error(`${label} schema is unsupported`)
  }
  const key = object(record.key, `${label}.key`)
  const unknownKey = Object.keys(key).filter(field => !['profileId', 'identity', 'capability', 'scope'].includes(field))
  if (unknownKey.length > 0) throw new Error(`${label}.key contains unknown field ${unknownKey[0]}`)
  if (typeof key.profileId !== 'string' || !PROFILE_OR_PLUGIN_ID.test(key.profileId)) throw new Error(`${label}.key.profileId is invalid`)
  const identity = object(key.identity, `${label}.key.identity`)
  const unknownIdentity = Object.keys(identity).filter(field => !['source', 'pluginId'].includes(field))
  if (unknownIdentity.length > 0) throw new Error(`${label}.key.identity contains unknown field ${unknownIdentity[0]}`)
  if (typeof identity.source !== 'string' || identity.source.trim() === '' || identity.source.length > 2048) {
    throw new Error(`${label}.key.identity.source is invalid`)
  }
  if (typeof identity.pluginId !== 'string' || !PROFILE_OR_PLUGIN_ID.test(identity.pluginId)) {
    throw new Error(`${label}.key.identity.pluginId is invalid`)
  }
  if (typeof key.capability !== 'string' || !(CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(key.capability)) {
    throw new Error(`${label}.key.capability is unsupported`)
  }
  if (record.policy !== 'ask' && record.policy !== 'deny' && record.policy !== 'allow') {
    throw new Error(`${label}.policy is unsupported`)
  }
  const capability = key.capability as CordisXPlatformCapability
  const scope = normalizePermissionScope(key.scope, `${label}.key.scope`)
  if (capability.startsWith('agent.') && scope.sessions !== undefined) {
    throw new Error(`${label}.key.scope cannot use Platform sessions for ${capability}`)
  }
  if (!capability.startsWith('agent.') && scope.sessionIds !== undefined) {
    throw new Error(`${label}.key.scope cannot use Agent sessionIds for ${capability}`)
  }
  return Object.freeze({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V1,
    schemaVersion: 1,
    key: Object.freeze({
      profileId: key.profileId,
      identity: Object.freeze({ source: identity.source.trim(), pluginId: identity.pluginId }),
      capability,
      scope,
    }),
    policy: record.policy,
  })
}

export function createPermissionPolicyRecord(input: {
  readonly profileId: string
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPlatformCapability
  readonly scope: CordisXCapabilityScope
  readonly policy: CordisXPermissionPolicyRecordV1['policy']
}): CordisXPermissionPolicyRecordV1 {
  return normalizePermissionPolicyRecord({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V1,
    schemaVersion: 1,
    key: {
      profileId: input.profileId,
      identity: { source: input.identity.source, pluginId: input.identity.id },
      capability: input.capability,
      scope: input.scope,
    },
    policy: input.policy,
  })
}
