import {
  CORDISX_PERMISSION_CAPABILITIES_V3,
  CORDISX_PERMISSION_POLICY_SCHEMA_V3,
  type CordisXCapabilityDeclarationV3,
  type CordisXPermissionAuthorizationKeyV3,
  type CordisXPermissionCapabilityV3,
  type CordisXPermissionPolicyRecordV3,
  type CordisXPermissionScopeV3,
} from './permission-contracts.js'
import {
  normalizePermissionIdentityV2,
  normalizePermissionLocalIdV2,
  sha256Hex,
} from './permission-model-v2.js'

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u
const POINT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function extensionPoints(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error(`${label} must contain 1 to 64 point ids`)
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string' || !POINT_ID.test(item)) throw new Error(`${label}[${index}] is invalid`)
    return item
  })
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`)
  return Object.freeze([...normalized].sort())
}

export function normalizeDomPermissionScopeV3(value: unknown, label = 'DOM permission scope'): CordisXPermissionScopeV3 {
  const scope = object(value, label)
  exact(scope, ['extensionPoints'], label)
  return Object.freeze({ extensionPoints: extensionPoints(scope.extensionPoints, `${label}.extensionPoints`) })
}

export function normalizeDomCapabilityDeclarationV3(
  value: unknown,
  label = 'DOM capability declaration',
): CordisXCapabilityDeclarationV3 {
  const declaration = object(value, label)
  exact(declaration, ['name', 'required', 'scope'], label)
  if (declaration.name !== 'ui.extension-points.render') throw new Error(`${label}.name is unsupported`)
  if (typeof declaration.required !== 'boolean') throw new Error(`${label}.required must be boolean`)
  return Object.freeze({
    name: declaration.name,
    required: declaration.required,
    scope: normalizeDomPermissionScopeV3(declaration.scope, `${label}.scope`),
  })
}

export function permissionSecurityFingerprintV3(
  catalogVersion: string,
  declaration: CordisXCapabilityDeclarationV3,
): `sha256:${string}` {
  const normalized = normalizeDomCapabilityDeclarationV3(declaration)
  return `sha256:${sha256Hex(JSON.stringify({
    catalogVersion,
    capability: normalized.name,
    rationale: null,
    scope: normalized.scope,
    security: null,
  }))}`
}

export function normalizePermissionPolicyRecordV3(
  value: unknown,
  label = 'permission policy v3',
): CordisXPermissionPolicyRecordV3 {
  const record = object(value, label)
  exact(record, ['$schema', 'schemaVersion', 'key', 'policy'], label)
  if (record.$schema !== CORDISX_PERMISSION_POLICY_SCHEMA_V3 || record.schemaVersion !== 3) {
    throw new Error(`${label} schema is unsupported`)
  }
  const key = object(record.key, `${label}.key`)
  exact(key, ['profileId', 'identity', 'capability', 'scope', 'securityFingerprint'], `${label}.key`)
  const profileId = normalizePermissionLocalIdV2(key.profileId, `${label}.key.profileId`)
  const identity = normalizePermissionIdentityV2(key.identity, `${label}.key.identity`)
  if (typeof key.capability !== 'string' || !(CORDISX_PERMISSION_CAPABILITIES_V3 as readonly string[]).includes(key.capability)) {
    throw new Error(`${label}.key.capability is unsupported`)
  }
  if (key.capability !== 'ui.extension-points.render') throw new Error(`${label} non-DOM capability must remain a v2 record`)
  if (typeof key.securityFingerprint !== 'string' || !FINGERPRINT.test(key.securityFingerprint)) {
    throw new Error(`${label}.key.securityFingerprint is invalid`)
  }
  if (record.policy !== 'ask' && record.policy !== 'allow-persistent' && record.policy !== 'deny-persistent') {
    throw new Error(`${label}.policy is unsupported`)
  }
  return Object.freeze({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
    schemaVersion: 3,
    key: Object.freeze({
      profileId,
      identity,
      capability: key.capability as CordisXPermissionCapabilityV3,
      scope: normalizeDomPermissionScopeV3(key.scope, `${label}.key.scope`),
      securityFingerprint: key.securityFingerprint as `sha256:${string}`,
    }),
    policy: record.policy,
  })
}

export function permissionRecordKeyV3(record: CordisXPermissionPolicyRecordV3): string {
  const normalized = normalizePermissionPolicyRecordV3(record)
  return JSON.stringify([
    normalized.key.profileId,
    normalized.key.identity.source,
    normalized.key.identity.pluginId,
    normalized.key.capability,
    normalized.key.scope,
    normalized.key.securityFingerprint,
  ])
}

export function domPermissionAuthorizationKeyV3(input: {
  readonly profileId: string
  readonly identity: CordisXPermissionAuthorizationKeyV3['identity']
  readonly pointId: string
  readonly catalogVersion: string
}): CordisXPermissionAuthorizationKeyV3 {
  const declaration = normalizeDomCapabilityDeclarationV3({
    name: 'ui.extension-points.render',
    required: false,
    scope: { extensionPoints: [input.pointId] },
  })
  return Object.freeze({
    profileId: normalizePermissionLocalIdV2(input.profileId, 'DOM permission profile id'),
    identity: normalizePermissionIdentityV2(input.identity, 'DOM permission identity'),
    capability: declaration.name,
    scope: declaration.scope,
    securityFingerprint: permissionSecurityFingerprintV3(input.catalogVersion, declaration),
  })
}
