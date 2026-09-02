import type { HostDomModifyOperation, HostDomOperation, HostDomReadOperation } from '@cordisx/protocol/host-dom/v1'
import {
  CORDISX_PERMISSION_CAPABILITIES_V2,
  CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PERMISSION_POLICY_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  type CordisXCapabilityDeclarationV4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationKeyV4,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationPlanV4,
  type CordisXPermissionCapabilityV4,
  type CordisXPermissionPolicyRecordV4,
  type CordisXPermissionScopeV4,
  type CordisXPluginManifestV5,
  type CordisXPluginServiceConfigurationV4,
  type CordisXPluginServiceDeclarationV4,
} from './permission-contracts.js'
import {
  normalizeCapabilityDeclarationV2,
  normalizePermissionIdentityV2,
  normalizePermissionLocalIdV2,
  normalizePermissionRationaleV2,
  normalizePermissionSecurityV2,
  sha256Hex,
} from './permission-model-v2.js'

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u
const LOCAL_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const SERVICE_ENTRY = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:mjs|js)$/u
const CHANNEL_SERVICE_CONFIG_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json'

export const HOST_DOM_READ_OPERATIONS = Object.freeze([
  'inspect-structure',
  'read-text',
  'read-attributes',
  'read-state',
] as const satisfies readonly HostDomReadOperation[])

export const HOST_DOM_MODIFY_OPERATIONS = Object.freeze([
  'set-text',
  'set-attribute',
  'insert-owned-structured-child',
  'remove-owned-child',
  'focus',
] as const satisfies readonly HostDomModifyOperation[])

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function nonEmpty(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new Error(`${label} is invalid`)
  return value
}

function uniqueSortedStrings(
  value: unknown,
  label: string,
  maximum: number,
  validate: (item: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} items`)
  }
  const values = value.map((item, index) => {
    if (typeof item !== 'string' || !validate(item)) throw new Error(`${label}[${index}] is invalid`)
    return item
  })
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`)
  return Object.freeze([...values].sort())
}

export function isHostDomPermissionCapability(
  value: unknown,
): value is 'ui.host-dom.read' | 'ui.host-dom.modify' {
  return value === 'ui.host-dom.read' || value === 'ui.host-dom.modify'
}

/** One strict normalizer shared by runtime Broker and launcher lifecycle review. */
export function normalizeCertifiedPermissionProjectionV1(
  value: unknown,
  identity: Readonly<{ source: string; pluginId: string }>,
  artifact: Readonly<{ version: string; integrity: `sha256:${string}` }>,
  now: Date,
): CordisXCertifiedPermissionProjectionV1 | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const expected = [
    '$schema', 'schemaVersion', 'kind', 'status', 'source', 'pluginId', 'version', 'integrity', 'reviewPolicy',
    'reviewedAt', 'expiresAt', 'evidence', 'feed', 'fingerprint', 'revision',
  ]
  if (Object.keys(input).some(key => !expected.includes(key))
    || input.$schema !== CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1
    || input.schemaVersion !== 1
    || input.kind !== 'cordisx-certified-permission-eligibility'
    || input.status !== 'active'
    || input.source !== identity.source
    || input.pluginId !== identity.pluginId
    || input.version !== artifact.version
    || input.integrity !== artifact.integrity
    || typeof input.reviewedAt !== 'string'
    || typeof input.expiresAt !== 'string'
    || typeof input.fingerprint !== 'string'
    || typeof input.revision !== 'string') return undefined
  const reviewPolicy = input.reviewPolicy !== null && typeof input.reviewPolicy === 'object' && !Array.isArray(input.reviewPolicy)
    ? input.reviewPolicy as Record<string, unknown> : undefined
  const evidence = input.evidence !== null && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
    ? input.evidence as Record<string, unknown> : undefined
  const feed = input.feed !== null && typeof input.feed === 'object' && !Array.isArray(input.feed)
    ? input.feed as Record<string, unknown> : undefined
  if (reviewPolicy === undefined || evidence === undefined || feed === undefined
    || Object.keys(reviewPolicy).some(key => !['id', 'version'].includes(key))
    || reviewPolicy.id !== 'cordisx-marketplace-review' || typeof reviewPolicy.version !== 'string'
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(reviewPolicy.version)
    || Object.keys(evidence).some(key => !['kind', 'reference'].includes(key))
    || evidence.kind !== 'protected-marketplace-review' || typeof evidence.reference !== 'string'
    || !/^https:\/\/github\.com\/cordisx\/marketplace\/(?:pull\/[1-9][0-9]*|commit\/[a-f0-9]{40})$/u.test(evidence.reference)
    || Object.keys(feed).some(key => !['generatedAt', 'root', 'authority'].includes(key))
    || typeof feed.generatedAt !== 'string' || typeof feed.root !== 'string'
    || !/^https:\/\/[^?#]+$/u.test(feed.root) || feed.root.length > 2048
    || feed.authority !== 'cordisx.marketplace.codeowners/v1'
    || input.revision !== feed.generatedAt
    || !/^sha256:[a-f0-9]{64}$/u.test(input.fingerprint)) return undefined
  const reviewedAt = Date.parse(input.reviewedAt)
  const expiresAt = Date.parse(input.expiresAt)
  const generatedAt = Date.parse(feed.generatedAt)
  if (!Number.isFinite(reviewedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(generatedAt)
    || reviewedAt > generatedAt || generatedAt > now.getTime() || now.getTime() >= expiresAt) return undefined
  const payload = {
    source: input.source,
    pluginId: input.pluginId,
    version: input.version,
    integrity: input.integrity,
    reviewPolicy: { id: reviewPolicy.id, version: reviewPolicy.version },
    reviewedAt: input.reviewedAt,
    expiresAt: input.expiresAt,
    evidence: { kind: evidence.kind, reference: evidence.reference },
    feed: { generatedAt: feed.generatedAt, root: feed.root, authority: feed.authority },
  }
  if (input.fingerprint !== `sha256:${sha256Hex(JSON.stringify(payload))}`) return undefined
  return Object.freeze({
    $schema: CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
    schemaVersion: 1,
    kind: 'cordisx-certified-permission-eligibility',
    status: 'active',
    ...payload,
    fingerprint: input.fingerprint,
    revision: input.revision,
  }) as CordisXCertifiedPermissionProjectionV1
}

export function normalizeHostDomPermissionScopeV4(
  value: unknown,
  capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  label = 'Host DOM permission scope',
): CordisXPermissionScopeV4 {
  const scope = object(value, label)
  exact(scope, ['rootIds', 'operations'], label)
  const operations = capability === 'ui.host-dom.read'
    ? HOST_DOM_READ_OPERATIONS as readonly HostDomOperation[]
    : HOST_DOM_MODIFY_OPERATIONS as readonly HostDomOperation[]
  return Object.freeze({
    rootIds: uniqueSortedStrings(scope.rootIds, `${label}.rootIds`, 64, item => LOCAL_ID.test(item)),
    operations: uniqueSortedStrings(
      scope.operations,
      `${label}.operations`,
      operations.length,
      item => operations.includes(item as HostDomOperation),
    ) as readonly HostDomOperation[],
  })
}

export function normalizeCapabilityDeclarationV4(
  value: unknown,
  label = 'capability declaration',
): CordisXCapabilityDeclarationV4 {
  const declaration = object(value, label)
  if (!isHostDomPermissionCapability(declaration.name)) {
    if (declaration.name === 'ui.extension-points.render') throw new Error(`${label}.name is not supported by manifest v5`)
    const normalized = normalizeCapabilityDeclarationV2(value, label)
    return normalized as CordisXCapabilityDeclarationV4
  }
  exact(declaration, ['name', 'required', 'rationale', 'security', 'scope'], label)
  if (typeof declaration.required !== 'boolean') throw new Error(`${label}.required must be boolean`)
  if (declaration.rationale === undefined || declaration.security === undefined) {
    throw new Error(`${label} requires rationale and security declarations`)
  }
  return Object.freeze({
    name: declaration.name,
    required: declaration.required,
    rationale: normalizePermissionRationaleV2(declaration.rationale, `${label}.rationale`),
    security: normalizePermissionSecurityV2(declaration.security, `${label}.security`),
    scope: normalizeHostDomPermissionScopeV4(declaration.scope, declaration.name, `${label}.scope`),
  })
}

function serviceConfiguration(value: unknown, label: string): CordisXPluginServiceConfigurationV4 {
  const configuration = object(value, label)
  if (configuration.kind === 'none') {
    exact(configuration, ['kind'], label)
    return Object.freeze({ kind: 'none' })
  }
  exact(configuration, ['kind', 'schema', 'configApplies'], label)
  if (configuration.kind !== 'host' || configuration.schema !== CHANNEL_SERVICE_CONFIG_SCHEMA
    || configuration.configApplies !== 'restart') throw new Error(`${label} is unsupported`)
  return Object.freeze({ kind: 'host', schema: CHANNEL_SERVICE_CONFIG_SCHEMA, configApplies: 'restart' })
}

function serviceDeclaration(value: unknown, label: string): CordisXPluginServiceDeclarationV4 {
  const service = object(value, label)
  exact(service, ['id', 'kind', 'entry', 'configuration'], label)
  const id = nonEmpty(service.id, `${label}.id`, 96)
  const entry = nonEmpty(service.entry, `${label}.entry`, 512)
  if (!LOCAL_ID.test(id) || !SERVICE_ENTRY.test(entry) || entry.includes('..') || service.kind !== 'channel-adapter') {
    throw new Error(`${label} is unsupported`)
  }
  return Object.freeze({ id, kind: 'channel-adapter', entry, configuration: serviceConfiguration(service.configuration, `${label}.configuration`) })
}

export interface PermissionCapabilityCatalogBoundaryV4 {
  assertScope(capability: CordisXPermissionCapabilityV4, scope: CordisXPermissionScopeV4): void
}

export function normalizePluginManifestV5(
  value: unknown,
  expectedId: string,
  catalog: PermissionCapabilityCatalogBoundaryV4,
): CordisXPluginManifestV5 {
  const manifest = object(value, 'plugin manifest')
  exact(manifest, ['$schema', 'schemaVersion', 'id', 'name', 'capabilities', 'services'], 'plugin manifest')
  if (manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 || manifest.schemaVersion !== 5) {
    throw new Error('plugin manifest schema is unsupported')
  }
  const id = nonEmpty(manifest.id, 'plugin manifest.id', 96)
  if (!LOCAL_ID.test(id) || id !== expectedId) throw new Error('plugin manifest id does not match its Host identity')
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 24) {
    throw new Error('plugin manifest.capabilities must be an array of at most 24 items')
  }
  const seenCapabilities = new Set<CordisXPermissionCapabilityV4>()
  const capabilities = Object.freeze(manifest.capabilities.map((candidate, index) => {
    const declaration = normalizeCapabilityDeclarationV4(candidate, `plugin manifest.capabilities[${index}]`)
    if (seenCapabilities.has(declaration.name)) throw new Error(`duplicate capability declaration: ${declaration.name}`)
    seenCapabilities.add(declaration.name)
    catalog.assertScope(declaration.name, declaration.scope)
    return declaration
  }))
  if (!Array.isArray(manifest.services) || manifest.services.length > 16) {
    throw new Error('plugin manifest.services must be an array of at most 16 items')
  }
  const seenServices = new Set<string>()
  const services = Object.freeze(manifest.services.map((candidate, index) => {
    const service = serviceDeclaration(candidate, `plugin manifest.services[${index}]`)
    if (seenServices.has(service.id)) throw new Error(`duplicate service declaration: ${service.id}`)
    seenServices.add(service.id)
    return service
  }))
  return Object.freeze({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
    schemaVersion: 5,
    id,
    ...(manifest.name === undefined ? {} : { name: nonEmpty(manifest.name, 'plugin manifest.name', 200) }),
    capabilities,
    services,
  })
}

function normalizedForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedForFingerprint)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizedForFingerprint(entry)]))
}

export function permissionSecurityFingerprintV4(
  catalogVersion: string,
  declaration: CordisXCapabilityDeclarationV4,
): `sha256:${string}` {
  const normalized = normalizeCapabilityDeclarationV4(declaration)
  return `sha256:${sha256Hex(JSON.stringify(normalizedForFingerprint({
    catalogVersion,
    capability: normalized.name,
    rationale: normalized.rationale ?? null,
    scope: normalized.scope,
    security: normalized.security ?? null,
  })))}`
}

export function normalizePermissionPolicyRecordV4(
  value: unknown,
  label = 'permission policy v4',
): CordisXPermissionPolicyRecordV4 {
  const record = object(value, label)
  exact(record, ['$schema', 'schemaVersion', 'key', 'policy'], label)
  if (record.$schema !== CORDISX_PERMISSION_POLICY_SCHEMA_V4 || record.schemaVersion !== 4) {
    throw new Error(`${label} schema is unsupported`)
  }
  const key = object(record.key, `${label}.key`)
  exact(key, ['profileId', 'identity', 'capability', 'scope', 'securityFingerprint'], `${label}.key`)
  if (!isHostDomPermissionCapability(key.capability)) throw new Error(`${label} stores only Host DOM v4 capabilities`)
  if (typeof key.securityFingerprint !== 'string' || !FINGERPRINT.test(key.securityFingerprint)) {
    throw new Error(`${label}.key.securityFingerprint is invalid`)
  }
  if (record.policy !== 'ask' && record.policy !== 'allow-persistent' && record.policy !== 'deny-persistent') {
    throw new Error(`${label}.policy is unsupported`)
  }
  if (key.capability === 'ui.host-dom.modify' && record.policy === 'allow-persistent') {
    throw new Error('ui.host-dom.modify cannot persist allow')
  }
  return Object.freeze({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
    schemaVersion: 4,
    key: Object.freeze({
      profileId: normalizePermissionLocalIdV2(key.profileId, `${label}.key.profileId`),
      identity: normalizePermissionIdentityV2(key.identity, `${label}.key.identity`),
      capability: key.capability,
      scope: normalizeHostDomPermissionScopeV4(key.scope, key.capability, `${label}.key.scope`),
      securityFingerprint: key.securityFingerprint as `sha256:${string}`,
    }),
    policy: record.policy,
  })
}

export function permissionRecordKeyV4(record: CordisXPermissionPolicyRecordV4): string {
  const normalized = normalizePermissionPolicyRecordV4(record)
  return JSON.stringify([
    normalized.key.profileId,
    normalized.key.identity.source,
    normalized.key.identity.pluginId,
    normalized.key.capability,
    normalized.key.scope,
    normalized.key.securityFingerprint,
  ])
}

export function hostDomPermissionAuthorizationKeyV4(input: {
  readonly profileId: string
  readonly identity: CordisXPermissionAuthorizationKeyV4['identity']
  readonly declaration: CordisXCapabilityDeclarationV4
  readonly catalogVersion: string
}): CordisXPermissionAuthorizationKeyV4 {
  const declaration = normalizeCapabilityDeclarationV4(input.declaration)
  if (!isHostDomPermissionCapability(declaration.name)) throw new Error('Host DOM authorization key requires a Host DOM capability')
  return Object.freeze({
    profileId: normalizePermissionLocalIdV2(input.profileId, 'Host DOM permission profile id'),
    identity: normalizePermissionIdentityV2(input.identity, 'Host DOM permission identity'),
    capability: declaration.name,
    scope: declaration.scope,
    securityFingerprint: permissionSecurityFingerprintV4(input.catalogVersion, declaration),
  })
}

/** Validates an explicit-user decision against exactly the items that still require review. */
export function assertPermissionAuthorizationDecisionV4(
  plan: CordisXPermissionAuthorizationPlanV4,
  decision: CordisXPermissionAuthorizationDecisionV4,
): void {
  if (decision === null || typeof decision !== 'object'
    || decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4
    || decision.schemaVersion !== 4
    || decision.origin !== 'explicit-user'
    || decision.planId !== plan.planId
    || decision.operation !== plan.operation
    || decision.profileId !== plan.profileId
    || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
    || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding)
    || !Array.isArray(decision.decisions)) {
    throw new Error('permission v4 decision does not match the exact plan')
  }
  const expected = new Map(plan.declarations
    .filter(item => item.decisionRequired)
    .map(item => [item.capability, item]))
  const seen = new Set<string>()
  for (const selected of decision.decisions) {
    const item = expected.get(selected.capability)
    if (item === undefined || seen.has(selected.capability)
      || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint
      || !item.allowedDecisions.includes(selected.decision)) {
      throw new Error('permission v4 decision exceeds or does not match the exact plan')
    }
    seen.add(selected.capability)
  }
  if (seen.size !== expected.size) throw new Error('permission v4 decision is incomplete')
}

export function isLegacyPermissionCapabilityV4(capability: CordisXPermissionCapabilityV4): boolean {
  return (CORDISX_PERMISSION_CAPABILITIES_V2 as readonly string[]).includes(capability)
}
