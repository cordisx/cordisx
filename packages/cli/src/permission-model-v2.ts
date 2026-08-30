import type { CordisXLocalizedText, CordisXMessageParam } from './contracts.js'
import {
  CORDISX_PERMISSION_CAPABILITIES_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  type CordisXCapabilityDeclarationV2,
  type CordisXChannelAccountRef,
  type CordisXChannelConversationRef,
  type CordisXChannelTenantRef,
  type CordisXChannelUserRef,
  type CordisXPermissionAuthorizationBindingV2,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationKeyV2,
  type CordisXPermissionAuthorizationKeyV3,
  type CordisXPermissionAuthorizationKeyV4,
  type CordisXPermissionCapabilityV2,
  type CordisXPermissionIdentityV2,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyV2,
  type CordisXPermissionRationaleV2,
  type CordisXPermissionScopeV2,
  type CordisXPermissionSecurityDeclarationV2,
  type CordisXPluginManifestV4,
  type CordisXPluginServiceConfigurationV4,
  type CordisXPluginServiceDeclarationV4,
} from './permission-contracts.js'
import type { CordisXPlatformSessionRef } from './platform-contracts.js'

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const REFERENCE = /^[a-z0-9][a-z0-9._-]{0,95}(?::[a-z0-9][a-z0-9._-]{0,95})?$/
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const SERVICE_ENTRY = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:cjs|mjs|js)$/
const CHANNEL_SERVICE_CONFIG_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json'
const RATIONALE_UNSAFE = /[\u0000-\u001f\u007f<>]|(?:https?:\/\/|javascript:)/iu
const RATIONALE_IMPERSONATION = /(?:cordisx|host).*(?:verified|approved|guaranteed|safe)|(?:CordisX|宿主).*(?:验证|批准|保证|安全)/iu

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function nonEmptyString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  }
  return value.trim()
}

function normalizedStringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
  validate: (value: string) => boolean = () => true,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${label} must be a non-empty array of at most ${maximumItems} items`)
  }
  const normalized = value.map((item, index) => {
    const text = nonEmptyString(item, `${label}[${index}]`, maximumLength)
    if (!validate(text)) throw new Error(`${label}[${index}] is invalid`)
    return text
  }).sort()
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`)
  return Object.freeze(normalized)
}

function normalizedObjectList<Value>(
  value: unknown,
  label: string,
  normalize: (value: unknown, label: string) => Value,
): readonly Value[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`${label} must be a non-empty array of at most 100 items`)
  }
  const normalized = value.map((item, index) => normalize(item, `${label}[${index}]`))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const identities = normalized.map(item => JSON.stringify(item))
  if (new Set(identities).size !== identities.length) throw new Error(`${label} must not contain duplicates`)
  return Object.freeze(normalized)
}

function platformSession(value: unknown, label: string): CordisXPlatformSessionRef {
  const item = object(value, label)
  exactKeys(item, ['providerId', 'remoteSessionId'], label)
  const providerId = nonEmptyString(item.providerId, `${label}.providerId`, 128)
  if (!PROVIDER_ID.test(providerId)) throw new Error(`${label}.providerId is invalid`)
  return Object.freeze({ providerId, remoteSessionId: nonEmptyString(item.remoteSessionId, `${label}.remoteSessionId`, 512) })
}

function channelAccount(value: unknown, label: string): CordisXChannelAccountRef {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId'], label)
  return Object.freeze({
    adapterId: nonEmptyString(item.adapterId, `${label}.adapterId`, 96),
    accountId: nonEmptyString(item.accountId, `${label}.accountId`, 200),
  })
}

function channelTenant(value: unknown, label: string): CordisXChannelTenantRef {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId', 'tenantId'], label)
  return Object.freeze({
    ...channelAccount({ adapterId: item.adapterId, accountId: item.accountId }, label),
    tenantId: nonEmptyString(item.tenantId, `${label}.tenantId`, 200),
  })
}

function channelConversation(value: unknown, label: string): CordisXChannelConversationRef {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'], label)
  if (item.kind !== 'direct' && item.kind !== 'group' && item.kind !== 'broadcast') {
    throw new Error(`${label}.kind is unsupported`)
  }
  return Object.freeze({
    ...channelTenant({ adapterId: item.adapterId, accountId: item.accountId, tenantId: item.tenantId }, label),
    conversationId: nonEmptyString(item.conversationId, `${label}.conversationId`, 512),
    kind: item.kind,
  })
}

function channelUser(value: unknown, label: string): CordisXChannelUserRef {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId', 'tenantId', 'userId'], label)
  return Object.freeze({
    ...channelTenant({ adapterId: item.adapterId, accountId: item.accountId, tenantId: item.tenantId }, label),
    userId: nonEmptyString(item.userId, `${label}.userId`, 512),
  })
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function canonicalSource(value: unknown, label: string): string {
  const source = nonEmptyString(value, label, 2048)
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw new Error(`${label} must be a canonical file or HTTPS URL`)
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'file:')
    || parsed.search !== '' || parsed.hash !== ''
    || (parsed.protocol === 'file:' && !source.startsWith('file:///'))) {
    throw new Error(`${label} must be a canonical file or HTTPS URL`)
  }
  return parsed.href
}

export function normalizePermissionLocalIdV2(value: unknown, label: string): string {
  const normalized = nonEmptyString(value, label, 96)
  if (!LOCAL_ID.test(normalized)) throw new Error(`${label} is invalid`)
  return normalized
}

export function normalizePermissionOperationIdV2(value: unknown, label: string): string {
  const normalized = nonEmptyString(value, label, 128)
  if (!BINDING_ID.test(normalized)) throw new Error(`${label} is invalid`)
  return normalized
}

export function normalizePermissionIdentityV2(value: unknown, label = 'permission identity'): CordisXPermissionIdentityV2 {
  const identity = object(value, label)
  exactKeys(identity, ['source', 'pluginId'], label)
  return Object.freeze({
    source: canonicalSource(identity.source, `${label}.source`),
    pluginId: normalizePermissionLocalIdV2(identity.pluginId, `${label}.pluginId`),
  })
}

export function normalizePermissionScopeV2(value: unknown, label = 'permission scope'): CordisXPermissionScopeV2 {
  const scope = object(value, label)
  exactKeys(scope, [
    'providers', 'cwdRoots', 'sessions', 'sessionIds', 'channelAccounts', 'channelTenants',
    'channelConversations', 'channelUsers',
  ], label)
  const providers = normalizedStringList(scope.providers, `${label}.providers`, 32, 128, value => PROVIDER_ID.test(value))
  const cwdRoots = normalizedStringList(scope.cwdRoots, `${label}.cwdRoots`, 32, 4096, absolutePath)
  const sessions = normalizedObjectList(scope.sessions, `${label}.sessions`, platformSession)
  const sessionIds = normalizedStringList(scope.sessionIds, `${label}.sessionIds`, 100, 512)
  const channelAccounts = normalizedObjectList(scope.channelAccounts, `${label}.channelAccounts`, channelAccount)
  const channelTenants = normalizedObjectList(scope.channelTenants, `${label}.channelTenants`, channelTenant)
  const channelConversations = normalizedObjectList(
    scope.channelConversations,
    `${label}.channelConversations`,
    channelConversation,
  )
  const channelUsers = normalizedObjectList(scope.channelUsers, `${label}.channelUsers`, channelUser)
  return Object.freeze({
    ...(providers === undefined ? {} : { providers }),
    ...(cwdRoots === undefined ? {} : { cwdRoots }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(channelAccounts === undefined ? {} : { channelAccounts }),
    ...(channelTenants === undefined ? {} : { channelTenants }),
    ...(channelConversations === undefined ? {} : { channelConversations }),
    ...(channelUsers === undefined ? {} : { channelUsers }),
  })
}

function inertRationaleText(value: string, label: string): void {
  if (RATIONALE_UNSAFE.test(value)) throw new Error(`${label} contains markup, control characters, or a link/script scheme`)
  if (RATIONALE_IMPERSONATION.test(value)) throw new Error(`${label} impersonates a Host security claim`)
}

function localizedText(value: unknown, label: string, maximumFallback: number): CordisXLocalizedText {
  const message = object(value, label)
  exactKeys(message, ['namespace', 'key', 'params', 'fallback'], label)
  const key = nonEmptyString(message.key, `${label}.key`, 96)
  if (!LOCAL_ID.test(key)) throw new Error(`${label}.key is invalid`)
  let namespace: string | undefined
  if (message.namespace !== undefined) {
    namespace = nonEmptyString(message.namespace, `${label}.namespace`, 193)
    if (!REFERENCE.test(namespace)) throw new Error(`${label}.namespace is invalid`)
  }
  let fallback: string | undefined
  if (message.fallback !== undefined) {
    fallback = nonEmptyString(message.fallback, `${label}.fallback`, maximumFallback)
    inertRationaleText(fallback, `${label}.fallback`)
  }
  let params: Readonly<Record<string, CordisXMessageParam>> | undefined
  if (message.params !== undefined) {
    const raw = object(message.params, `${label}.params`)
    if (Object.keys(raw).length > 16) throw new Error(`${label}.params must contain at most 16 values`)
    const next: Record<string, CordisXMessageParam> = {}
    for (const [param, entry] of Object.entries(raw).sort(([left], [right]) => left.localeCompare(right))) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(param)) throw new Error(`${label}.params has invalid key ${param}`)
      if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) {
        throw new Error(`${label}.params.${param} must be a scalar`)
      }
      if (typeof entry === 'string') {
        if (entry.length > 512) throw new Error(`${label}.params.${param} is too long`)
        inertRationaleText(entry, `${label}.params.${param}`)
      }
      next[param] = entry as CordisXMessageParam
    }
    params = Object.freeze(next)
  }
  return Object.freeze({
    ...(namespace === undefined ? {} : { namespace }),
    key,
    ...(params === undefined ? {} : { params }),
    ...(fallback === undefined ? {} : { fallback }),
  })
}

export function normalizePermissionRationaleV2(value: unknown, label = 'permission rationale'): CordisXPermissionRationaleV2 {
  const rationale = object(value, label)
  exactKeys(rationale, ['title', 'description', 'feature', 'deniedBehavior'], label)
  return Object.freeze({
    title: localizedText(rationale.title, `${label}.title`, 160),
    description: localizedText(rationale.description, `${label}.description`, 800),
    feature: localizedText(rationale.feature, `${label}.feature`, 800),
    deniedBehavior: localizedText(rationale.deniedBehavior, `${label}.deniedBehavior`, 800),
  })
}

export function normalizePermissionSecurityV2(
  value: unknown,
  label = 'permission security declaration',
): CordisXPermissionSecurityDeclarationV2 {
  const security = object(value, label)
  exactKeys(security, ['dataUse', 'retention', 'externalTransfer'], label)
  if (security.dataUse !== 'ephemeral' && security.dataUse !== 'profile-persistent' && security.dataUse !== 'external-service') {
    throw new Error(`${label}.dataUse is unsupported`)
  }
  if (security.retention !== 'none' && security.retention !== 'runtime' && security.retention !== 'profile') {
    throw new Error(`${label}.retention is unsupported`)
  }
  if (typeof security.externalTransfer !== 'boolean') throw new Error(`${label}.externalTransfer must be a boolean`)
  return Object.freeze({
    dataUse: security.dataUse,
    retention: security.retention,
    externalTransfer: security.externalTransfer,
  })
}

export function normalizeCapabilityDeclarationV2(
  value: unknown,
  label = 'capability declaration',
): CordisXCapabilityDeclarationV2 {
  const declaration = object(value, label)
  exactKeys(declaration, ['name', 'required', 'rationale', 'security', 'scope'], label)
  if (typeof declaration.name !== 'string'
    || !(CORDISX_PERMISSION_CAPABILITIES_V2 as readonly string[]).includes(declaration.name)) {
    throw new Error(`${label}.name is unsupported`)
  }
  if (typeof declaration.required !== 'boolean') throw new Error(`${label}.required must be a boolean`)
  const name = declaration.name as CordisXPermissionCapabilityV2
  const scope = normalizePermissionScopeV2(declaration.scope, `${label}.scope`)
  if (name.startsWith('agent.') && scope.sessions !== undefined) throw new Error(`${name} cannot use Platform sessions`)
  if (!name.startsWith('agent.') && scope.sessionIds !== undefined) throw new Error(`${name} cannot use Agent session ids`)
  const channelScope = Object.keys(scope).some(key => key.startsWith('channel'))
  if (!name.startsWith('channel.') && channelScope) throw new Error(`${name} cannot use Channel scope`)
  return Object.freeze({
    name,
    required: declaration.required,
    ...(declaration.rationale === undefined ? {} : {
      rationale: normalizePermissionRationaleV2(declaration.rationale, `${label}.rationale`),
    }),
    ...(declaration.security === undefined ? {} : {
      security: normalizePermissionSecurityV2(declaration.security, `${label}.security`),
    }),
    scope,
  })
}

export function normalizeCapabilityDeclarationsV2(value: unknown): readonly CordisXCapabilityDeclarationV2[] {
  if (!Array.isArray(value) || value.length > CORDISX_PERMISSION_CAPABILITIES_V2.length) {
    throw new Error(`capabilities must be an array of at most ${CORDISX_PERMISSION_CAPABILITIES_V2.length} items`)
  }
  const seen = new Set<CordisXPermissionCapabilityV2>()
  return Object.freeze(value.map((item, index) => {
    const declaration = normalizeCapabilityDeclarationV2(item, `capabilities[${index}]`)
    if (seen.has(declaration.name)) throw new Error(`duplicate capability declaration: ${declaration.name}`)
    seen.add(declaration.name)
    return declaration
  }))
}

function serviceConfiguration(value: unknown, label: string): CordisXPluginServiceConfigurationV4 {
  const configuration = object(value, label)
  if (configuration.kind === 'none') {
    exactKeys(configuration, ['kind'], label)
    return Object.freeze({ kind: 'none' })
  }
  exactKeys(configuration, ['kind', 'schema', 'configApplies'], label)
  if (configuration.kind !== 'host'
    || configuration.schema !== CHANNEL_SERVICE_CONFIG_SCHEMA
    || configuration.configApplies !== 'restart') {
    throw new Error(`${label} is unsupported`)
  }
  return Object.freeze({ kind: 'host', schema: CHANNEL_SERVICE_CONFIG_SCHEMA, configApplies: 'restart' })
}

function serviceDeclaration(value: unknown, label: string): CordisXPluginServiceDeclarationV4 {
  const service = object(value, label)
  exactKeys(service, ['id', 'kind', 'entry', 'configuration'], label)
  const id = nonEmptyString(service.id, `${label}.id`, 96)
  if (!LOCAL_ID.test(id)) throw new Error(`${label}.id is invalid`)
  const entry = nonEmptyString(service.entry, `${label}.entry`, 512)
  if (!SERVICE_ENTRY.test(entry) || entry.includes('..')) throw new Error(`${label}.entry is invalid`)
  if (service.kind !== 'channel-adapter') throw new Error(`${label}.kind is unsupported`)
  return Object.freeze({
    id,
    kind: 'channel-adapter',
    entry,
    configuration: serviceConfiguration(service.configuration, `${label}.configuration`),
  })
}

export interface PermissionCapabilityCatalogBoundary {
  assertScope(capability: CordisXPermissionCapabilityV2, scope: CordisXPermissionScopeV2): void
}

export function normalizePluginManifestV4(
  value: unknown,
  expectedId: string,
  catalog: PermissionCapabilityCatalogBoundary,
): CordisXPluginManifestV4 {
  const manifest = object(value, 'plugin manifest')
  exactKeys(manifest, ['$schema', 'schemaVersion', 'id', 'name', 'capabilities', 'services'], 'plugin manifest')
  if (manifest.$schema !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v4.schema.json'
    || manifest.schemaVersion !== 4) throw new Error('plugin manifest schema is unsupported')
  const id = nonEmptyString(manifest.id, 'plugin manifest.id', 96)
  if (!LOCAL_ID.test(id) || id !== expectedId) throw new Error('plugin manifest id does not match its Host identity')
  let name: string | undefined
  if (manifest.name !== undefined) name = nonEmptyString(manifest.name, 'plugin manifest.name', 200)
  const capabilities = normalizeCapabilityDeclarationsV2(manifest.capabilities)
  for (const declaration of capabilities) catalog.assertScope(declaration.name, declaration.scope)
  if (!Array.isArray(manifest.services) || manifest.services.length > 16) {
    throw new Error('plugin manifest.services must be an array of at most 16 items')
  }
  const seen = new Set<string>()
  const services = manifest.services.map((item, index) => {
    const normalized = serviceDeclaration(item, `plugin manifest.services[${index}]`)
    if (seen.has(normalized.id)) throw new Error(`duplicate service declaration: ${normalized.id}`)
    seen.add(normalized.id)
    return normalized
  })
  return Object.freeze({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v4.schema.json',
    schemaVersion: 4,
    id,
    ...(name === undefined ? {} : { name }),
    capabilities,
    services: Object.freeze(services),
  })
}

function normalizedForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedForFingerprint)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  }
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizedForFingerprint(entry)]))
}

function rightRotate(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Browser-safe SHA-256 used by both launcher-produced plans and renderer verification. */
export function sha256Hex(value: string): string {
  const encoded = encodeURIComponent(value)
  const bytes: number[] = []
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16))
      index += 2
    } else {
      bytes.push(encoded.charCodeAt(index))
    }
  }
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff)

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0)
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4
      words[index] = ((bytes[cursor]! << 24) | (bytes[cursor + 1]! << 16) | (bytes[cursor + 2]! << 8) | bytes[cursor + 3]!) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!
      const right = words[index - 2]!
      const sigma0 = rightRotate(left, 7) ^ rightRotate(left, 18) ^ (left >>> 3)
      const sigma1 = rightRotate(right, 17) ^ rightRotate(right, 19) ^ (right >>> 10)
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number]
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temporary1 = (h + sigma1 + choose + SHA256_CONSTANTS[index]! + words[index]!) >>> 0
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    state[0] = (state[0]! + a) >>> 0
    state[1] = (state[1]! + b) >>> 0
    state[2] = (state[2]! + c) >>> 0
    state[3] = (state[3]! + d) >>> 0
    state[4] = (state[4]! + e) >>> 0
    state[5] = (state[5]! + f) >>> 0
    state[6] = (state[6]! + g) >>> 0
    state[7] = (state[7]! + h) >>> 0
  }
  return state.map(word => word.toString(16).padStart(8, '0')).join('')
}

export function permissionSecurityFingerprint(
  catalogVersion: string,
  declaration: CordisXCapabilityDeclarationV2,
): `sha256:${string}` {
  const normalized = normalizeCapabilityDeclarationV2(declaration)
  return `sha256:${sha256Hex(JSON.stringify(normalizedForFingerprint({
    catalogVersion,
    capability: normalized.name,
    rationale: normalized.rationale ?? null,
    scope: normalized.scope,
    security: normalized.security ?? null,
  })))}`
}

function dimensionValues(scope: CordisXPermissionScopeV2, dimension: keyof CordisXPermissionScopeV2): readonly unknown[] | undefined {
  return scope[dimension]
}

function cwdCoveredBy(root: string, candidate: string): boolean {
  const separator = root.includes('\\') ? '\\' : '/'
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const normalizedCandidate = candidate.replace(/[\\/]+$/, '')
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${separator}`)
}

function dimensionContains(
  dimension: keyof CordisXPermissionScopeV2,
  container: readonly unknown[] | undefined,
  candidate: readonly unknown[] | undefined,
): boolean {
  if (container === undefined) return true
  if (candidate === undefined) return false
  if (dimension === 'cwdRoots') {
    return (candidate as readonly string[]).every(path => (container as readonly string[]).some(root => cwdCoveredBy(root, path)))
  }
  const known = new Set(container.map(value => JSON.stringify(value)))
  return candidate.every(value => known.has(JSON.stringify(value)))
}

export type CordisXPermissionScopeChange = 'equal' | 'narrowed' | 'expanded' | 'changed'

export function comparePermissionScopeV2(
  before: CordisXPermissionScopeV2,
  after: CordisXPermissionScopeV2,
): CordisXPermissionScopeChange {
  const left = normalizePermissionScopeV2(before)
  const right = normalizePermissionScopeV2(after)
  const dimensions = Object.freeze([
    'providers', 'cwdRoots', 'sessions', 'sessionIds', 'channelAccounts', 'channelTenants',
    'channelConversations', 'channelUsers',
  ] as const)
  const leftContainsRight = dimensions.every(dimension => dimensionContains(
    dimension,
    dimensionValues(left, dimension),
    dimensionValues(right, dimension),
  ))
  const rightContainsLeft = dimensions.every(dimension => dimensionContains(
    dimension,
    dimensionValues(right, dimension),
    dimensionValues(left, dimension),
  ))
  if (leftContainsRight && rightContainsLeft) return 'equal'
  if (leftContainsRight) return 'narrowed'
  if (rightContainsLeft) return 'expanded'
  return 'changed'
}

export function normalizePermissionAuthorizationBindingV2(
  value: unknown,
  label = 'permission authorization binding',
): CordisXPermissionAuthorizationBindingV2 {
  const binding = object(value, label)
  exactKeys(binding, ['operationId', 'runtimeGeneration', 'moduleGeneration', 'requestId'], label)
  const operationId = normalizePermissionOperationIdV2(binding.operationId, `${label}.operationId`)
  const runtimeGeneration = nonEmptyString(binding.runtimeGeneration, `${label}.runtimeGeneration`, 200)
  let moduleGeneration: string | undefined
  if (binding.moduleGeneration !== undefined) moduleGeneration = nonEmptyString(binding.moduleGeneration, `${label}.moduleGeneration`, 200)
  let requestId: string | undefined
  if (binding.requestId !== undefined) {
    requestId = nonEmptyString(binding.requestId, `${label}.requestId`, 128)
    if (!BINDING_ID.test(requestId)) throw new Error(`${label}.requestId is invalid`)
  }
  return Object.freeze({
    operationId,
    runtimeGeneration,
    ...(moduleGeneration === undefined ? {} : { moduleGeneration }),
    ...(requestId === undefined ? {} : { requestId }),
  })
}

/** Shared Host validator used by both runtime Broker and lifecycle review authority. */
export function assertPermissionAuthorizationDecisionV2(
  plan: CordisXPermissionAuthorizationPlanV2,
  decision: CordisXPermissionAuthorizationDecisionV2,
): void {
  const candidate = object(decision, 'permission authorization decision')
  exactKeys(candidate, [
    '$schema', 'schemaVersion', 'planId', 'operation', 'profileId', 'identity', 'binding', 'decisions',
  ], 'permission authorization decision')
  const identity = normalizePermissionIdentityV2(decision.identity, 'permission authorization decision identity')
  const binding = normalizePermissionAuthorizationBindingV2(decision.binding)
  if (decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2
    || decision.schemaVersion !== 2
    || decision.planId !== plan.planId
    || decision.operation !== plan.operation
    || decision.profileId !== plan.profileId
    || identity.source !== plan.identity.source
    || identity.pluginId !== plan.identity.pluginId
    || JSON.stringify(binding) !== JSON.stringify(plan.binding)
    || !Array.isArray(decision.decisions)) {
    throw new Error('authorization decision does not match the current v2 plan')
  }
  const declarations = new Map(plan.declarations.map(item => [item.capability, item]))
  const seen = new Set<CordisXPermissionCapabilityV2>()
  for (const [index, item] of decision.decisions.entries()) {
    const raw = object(item, `permission authorization decision decisions[${index}]`)
    exactKeys(raw, ['capability', 'scope', 'securityFingerprint', 'decision'], `permission authorization decision decisions[${index}]`)
    const declaration = declarations.get(item.capability)
    if (declaration === undefined || seen.has(item.capability)
      || item.securityFingerprint !== declaration.securityFingerprint
      || JSON.stringify(normalizePermissionScopeV2(item.scope)) !== JSON.stringify(declaration.scope)
      || !declaration.allowedDecisions.includes(item.decision)) {
      throw new Error('authorization decision does not match the current v2 declaration')
    }
    seen.add(item.capability)
  }
  if (seen.size !== declarations.size) throw new Error('authorization decision is incomplete')
}

export function normalizePermissionPolicyRecordV2(value: unknown, label = 'permission policy'): CordisXPermissionPolicyRecordV2 {
  const record = object(value, label)
  exactKeys(record, ['$schema', 'schemaVersion', 'key', 'policy'], label)
  if (record.$schema !== CORDISX_PERMISSION_POLICY_SCHEMA_V2 || record.schemaVersion !== 2) {
    throw new Error(`${label} schema is unsupported`)
  }
  const key = object(record.key, `${label}.key`)
  exactKeys(key, ['profileId', 'identity', 'capability', 'scope', 'securityFingerprint'], `${label}.key`)
  const profileId = normalizePermissionLocalIdV2(key.profileId, `${label}.key.profileId`)
  const identity = normalizePermissionIdentityV2(key.identity, `${label}.key.identity`)
  if (typeof key.capability !== 'string'
    || !(CORDISX_PERMISSION_CAPABILITIES_V2 as readonly string[]).includes(key.capability)) {
    throw new Error(`${label}.key.capability is unsupported`)
  }
  if (typeof key.securityFingerprint !== 'string' || !FINGERPRINT.test(key.securityFingerprint)) {
    throw new Error(`${label}.key.securityFingerprint is invalid`)
  }
  if (record.policy !== 'ask' && record.policy !== 'allow-persistent' && record.policy !== 'deny-persistent') {
    throw new Error(`${label}.policy is unsupported`)
  }
  const capability = key.capability as CordisXPermissionCapabilityV2
  const scope = normalizePermissionScopeV2(key.scope, `${label}.key.scope`)
  if (capability.startsWith('agent.') && scope.sessions !== undefined) {
    throw new Error(`${label}.key.scope cannot use Platform sessions for ${capability}`)
  }
  if (!capability.startsWith('agent.') && scope.sessionIds !== undefined) {
    throw new Error(`${label}.key.scope cannot use Agent sessionIds for ${capability}`)
  }
  if (!capability.startsWith('channel.') && Object.keys(scope).some(field => field.startsWith('channel'))) {
    throw new Error(`${label}.key.scope cannot use Channel scope for ${capability}`)
  }
  return Object.freeze({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: Object.freeze({
      profileId,
      identity,
      capability,
      scope,
      securityFingerprint: key.securityFingerprint as `sha256:${string}`,
    }),
    policy: record.policy,
  })
}

export function permissionRecordKeyV2(record: CordisXPermissionPolicyRecordV2): string {
  const normalized = normalizePermissionPolicyRecordV2(record)
  return JSON.stringify([
    normalized.key.profileId,
    normalized.key.identity.source,
    normalized.key.identity.pluginId,
    normalized.key.capability,
    normalized.key.scope,
    normalized.key.securityFingerprint,
  ])
}

export interface PermissionPolicyReconciliation {
  readonly policy: CordisXPermissionPolicyV2
  readonly source: 'default' | 'exact' | 'narrowed-scope'
  readonly migration?: CordisXPermissionPolicyRecordV2
}

/**
 * Carries policy across scope narrowing only when the old fingerprint can be
 * reconstructed from the new declaration's identical rationale/security data.
 * Expansion, lateral changes, metadata changes, and conflicting ancestors ask.
 */
export function reconcilePermissionPolicyV2(input: {
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly catalogVersion: string
  readonly declaration: CordisXCapabilityDeclarationV2
  readonly records: readonly CordisXPermissionPolicyRecordV2[]
  readonly persistentAllow: boolean
  readonly persistentDeny: boolean
}): PermissionPolicyReconciliation {
  const declaration = normalizeCapabilityDeclarationV2(input.declaration)
  const targetFingerprint = permissionSecurityFingerprint(input.catalogVersion, declaration)
  const target = normalizePermissionPolicyRecordV2({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: {
      profileId: input.profileId,
      identity: input.identity,
      capability: declaration.name,
      scope: declaration.scope,
      securityFingerprint: targetFingerprint,
    },
    policy: 'ask',
  })
  const exactKey = permissionRecordKeyV2(target)
  const exact = input.records.map(item => normalizePermissionPolicyRecordV2(item))
    .find(item => permissionRecordKeyV2(item) === exactKey)
  if (exact !== undefined) {
    const allowed = exact.policy === 'allow-persistent'
      ? input.persistentAllow
      : exact.policy === 'deny-persistent'
        ? input.persistentDeny
        : true
    return Object.freeze({ policy: allowed ? exact.policy : 'ask', source: 'exact' })
  }

  const candidates = input.records.map(item => normalizePermissionPolicyRecordV2(item)).filter(item => {
    if (item.key.profileId !== target.key.profileId
      || item.key.identity.source !== target.key.identity.source
      || item.key.identity.pluginId !== target.key.identity.pluginId
      || item.key.capability !== target.key.capability
      || comparePermissionScopeV2(item.key.scope, target.key.scope) !== 'narrowed') return false
    const reconstructed = permissionSecurityFingerprint(input.catalogVersion, {
      ...declaration,
      scope: item.key.scope,
    })
    return reconstructed === item.key.securityFingerprint
  }).filter(item => (
    (item.policy !== 'allow-persistent' || input.persistentAllow)
    && (item.policy !== 'deny-persistent' || input.persistentDeny)
  ))
  const policies = new Set(candidates.map(item => item.policy).filter(policy => policy !== 'ask'))
  if (policies.size !== 1) return Object.freeze({ policy: 'ask', source: 'default' })
  const policy = [...policies][0]! as 'allow-persistent' | 'deny-persistent'
  const migration = normalizePermissionPolicyRecordV2({ ...target, policy })
  return Object.freeze({ policy, source: 'narrowed-scope', migration })
}

function onceGrantKey(
  key: CordisXPermissionAuthorizationKeyV2 | CordisXPermissionAuthorizationKeyV3 | CordisXPermissionAuthorizationKeyV4,
  binding: CordisXPermissionAuthorizationBindingV2,
): string {
  const normalizedBinding = normalizePermissionAuthorizationBindingV2(binding)
  return JSON.stringify([
    JSON.stringify([
      key.profileId,
      key.identity.source,
      key.identity.pluginId,
      key.capability,
      key.scope,
      key.securityFingerprint,
    ]),
    normalizedBinding.operationId,
    normalizedBinding.runtimeGeneration,
    normalizedBinding.moduleGeneration ?? null,
    normalizedBinding.requestId ?? null,
  ])
}

/** In-memory, single-consumption grants. This class deliberately has no persistence API. */
export class PermissionOnceGrantLedger {
  readonly #grants = new Set<string>()

  issue(key: CordisXPermissionAuthorizationKeyV2 | CordisXPermissionAuthorizationKeyV3 | CordisXPermissionAuthorizationKeyV4, binding: CordisXPermissionAuthorizationBindingV2): void {
    this.#grants.add(onceGrantKey(key, binding))
  }

  consume(key: CordisXPermissionAuthorizationKeyV2 | CordisXPermissionAuthorizationKeyV3 | CordisXPermissionAuthorizationKeyV4, binding: CordisXPermissionAuthorizationBindingV2): boolean {
    const grant = onceGrantKey(key, binding)
    if (!this.#grants.delete(grant)) return false
    return true
  }

  has(key: CordisXPermissionAuthorizationKeyV2 | CordisXPermissionAuthorizationKeyV3 | CordisXPermissionAuthorizationKeyV4, binding: CordisXPermissionAuthorizationBindingV2): boolean {
    return this.#grants.has(onceGrantKey(key, binding))
  }

  clearOperation(operationId: string): void {
    for (const grant of this.#grants) {
      const parsed = JSON.parse(grant) as readonly [unknown, string]
      if (parsed[1] === operationId) this.#grants.delete(grant)
    }
  }

  clearGeneration(runtimeGeneration: string, moduleGeneration?: string): void {
    for (const grant of this.#grants) {
      const parsed = JSON.parse(grant) as readonly [unknown, string, string, string | null]
      if (parsed[2] === runtimeGeneration && (moduleGeneration === undefined || parsed[3] === moduleGeneration)) {
        this.#grants.delete(grant)
      }
    }
  }

  dispose(): void {
    this.#grants.clear()
  }

  get size(): number {
    return this.#grants.size
  }
}

export function migratePermissionPolicyV1(
  legacyPolicy: 'ask' | 'allow' | 'deny',
  target: {
    readonly key: CordisXPermissionAuthorizationKeyV2
    readonly persistentAllow: boolean
    readonly persistentDeny: boolean
  },
): CordisXPermissionPolicyRecordV2 {
  let policy: CordisXPermissionPolicyV2 = 'ask'
  if (legacyPolicy === 'allow' && target.persistentAllow) policy = 'allow-persistent'
  if (legacyPolicy === 'deny' && target.persistentDeny) policy = 'deny-persistent'
  return normalizePermissionPolicyRecordV2({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: target.key,
    policy,
  })
}
