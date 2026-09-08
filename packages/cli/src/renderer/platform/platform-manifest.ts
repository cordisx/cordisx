import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  type CordisXPluginManifestV11,
  normalizeUsageManifestV11,
} from '../../usage-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  type CordisXPluginManifestV12,
  type CordisXPluginManifestV13,
  normalizePluginManifestV12,
  normalizePluginManifestV13,
} from '../../runtime-exact-request-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../../extension-point-interaction-permissions.js'
import type { CordisXPluginManifestV10 } from '../../extension-point-interaction-permissions.js'
import { CORDISX_PLATFORM_CAPABILITIES, CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../../contracts.js'
import type {
  CordisXCapabilityDeclaration,
  CordisXLocalizedText,
  CordisXPlatformCapability,
  CordisXPlatformDiagnostic,
  CordisXPlatformResult,
  CordisXPluginIdentity,
  CordisXPluginManifestV1,
} from '../../contracts.js'
import { normalizePermissionScope, permissionIdentityKey, permissionScopeFingerprint } from '../../permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
} from '../../permission-contracts.js'
import type {
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
  CordisXPluginManifestV9,
} from '../../permission-contracts.js'
import { CapabilityRiskCatalog } from '../../capability-risk-catalog.js'
import { normalizePluginManifestV4 } from '../../permission-model-v2.js'
import {
  normalizePluginManifestV5,
  normalizePluginManifestV6,
  normalizePluginManifestV7,
  normalizePluginManifestV8,
  normalizePluginManifestV9,
} from '../../permission-model-v4.js'

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/

export const LEGACY_POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v1'

export const POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v2'

export function failure(
  code: CordisXPlatformDiagnostic['code'],
  message: string,
  retryable = false,
): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message, ...(retryable ? { retryable: true } : {}) } }
}

export function copy<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

export function safeAdapterFailure(): CordisXPlatformResult<never> {
  return failure('adapter-failure', 'Platform adapter operation failed')
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function normalizedReason(value: unknown, label: string): CordisXLocalizedText {
  const reason = object(value, label)
  const unknown = Object.keys(reason).filter(key => !['namespace', 'key', 'params', 'fallback'].includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
  if (typeof reason.key !== 'string' || !ID_PATTERN.test(reason.key)) throw new Error(`${label}.key is invalid`)
  if (
    reason.namespace !== undefined
    && (typeof reason.namespace !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,95}(?::[a-z0-9][a-z0-9._-]{0,95})?$/.test(reason.namespace))
  ) {
    throw new Error(`${label}.namespace is invalid`)
  }
  if (reason.fallback !== undefined && (typeof reason.fallback !== 'string' || reason.fallback.trim() === '')) {
    throw new Error(`${label}.fallback is invalid`)
  }
  const params = reason.params === undefined ? undefined : object(reason.params, `${label}.params`)
  if (
    params !== undefined && (Object.keys(params).length > 32 || Object.entries(params).some(([key, item]) => {
      return !/^[a-z][a-zA-Z0-9]*$/.test(key)
        || !(item === null || ['string', 'number', 'boolean'].includes(typeof item))
    }))
  ) throw new Error(`${label}.params is invalid`)
  return Object.freeze({
    ...(typeof reason.namespace === 'string' ? { namespace: reason.namespace } : {}),
    key: reason.key,
    ...(params === undefined ? {} : {
      params: Object.fromEntries(
        Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
      ) as NonNullable<CordisXLocalizedText['params']>,
    }),
    ...(typeof reason.fallback === 'string' ? { fallback: reason.fallback } : {}),
  })
}

/** Validate and freeze one module manifest against its launcher-owned id. */
export function normalizePluginManifest(
  value: unknown,
  expectedId: string,
):
  | CordisXPluginManifestV1
  | CordisXPluginManifestV4
  | CordisXPluginManifestV5
  | CordisXPluginManifestV6
  | CordisXPluginManifestV7
  | CordisXPluginManifestV8
  | CordisXPluginManifestV9
  | CordisXPluginManifestV10
  | CordisXPluginManifestV11
  | CordisXPluginManifestV12
  | CordisXPluginManifestV13
{
  if (!ID_PATTERN.test(expectedId)) throw new Error(`launcher plugin id ${expectedId} is invalid`)
  if (value === undefined) {
    return Object.freeze({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id: expectedId,
      capabilities: Object.freeze([]),
    })
  }
  const manifest = object(value, `plugin ${expectedId} manifest`)
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 || manifest.schemaVersion === 12) {
    return normalizePluginManifestV12(manifest, expectedId)
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 || manifest.schemaVersion === 13) {
    return normalizePluginManifestV13(manifest, expectedId)
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 || manifest.schemaVersion === 11) {
    return normalizeUsageManifestV11(manifest, expectedId)
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 || manifest.schemaVersion === 10) {
    return normalizeVisualManifestV10(manifest, expectedId)
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V9 || manifest.schemaVersion === 9) {
    return normalizePluginManifestV9(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V8 || manifest.schemaVersion === 8) {
    return normalizePluginManifestV8(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V7 || manifest.schemaVersion === 7) {
    return normalizePluginManifestV7(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V6 || manifest.schemaVersion === 6) {
    return normalizePluginManifestV6(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 || manifest.schemaVersion === 5) {
    return normalizePluginManifestV5(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 || manifest.schemaVersion === 4) {
    return normalizePluginManifestV4(manifest, expectedId, new CapabilityRiskCatalog())
  }
  const unknown = Object.keys(manifest).filter(key =>
    !['$schema', 'schemaVersion', 'id', 'name', 'capabilities'].includes(key)
  )
  if (unknown.length > 0) throw new Error(`plugin ${expectedId} manifest contains unknown field ${unknown[0]}`)
  if (manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1) {
    throw new Error(`plugin ${expectedId} manifest schema is unsupported`)
  }
  if (manifest.schemaVersion !== 1) throw new Error(`plugin ${expectedId} manifest version is unsupported`)
  if (manifest.id !== expectedId) {
    throw new Error(`plugin manifest id ${String(manifest.id)} does not match launcher id ${expectedId}`)
  }
  if (manifest.name !== undefined && (typeof manifest.name !== 'string' || manifest.name.trim() === '')) {
    throw new Error(`plugin ${expectedId} manifest name is invalid`)
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new Error(`plugin ${expectedId} manifest capabilities must be an array`)
  }
  const seen = new Set<string>()
  const capabilities = manifest.capabilities.map((item, index): CordisXCapabilityDeclaration => {
    const declaration = object(item, `plugin ${expectedId} capability[${index}]`)
    const unknownFields = Object.keys(declaration).filter(key => !['name', 'required', 'reason', 'scope'].includes(key))
    if (unknownFields.length > 0) {
      throw new Error(`plugin ${expectedId} capability[${index}] contains unknown field ${unknownFields[0]}`)
    }
    if (
      typeof declaration.name !== 'string'
      || !(CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(declaration.name)
    ) {
      throw new Error(`plugin ${expectedId} capability[${index}] name is unsupported`)
    }
    if (seen.has(declaration.name)) throw new Error(`plugin ${expectedId} declares ${declaration.name} more than once`)
    seen.add(declaration.name)
    if (typeof declaration.required !== 'boolean') {
      throw new Error(`plugin ${expectedId} capability[${index}].required must be boolean`)
    }
    const name = declaration.name as CordisXPlatformCapability
    const scope = normalizePermissionScope(declaration.scope, `plugin ${expectedId} capability[${index}].scope`)
    if (name.startsWith('agent.') && scope.sessions !== undefined) {
      throw new Error(`plugin ${expectedId} capability[${index}] cannot use Platform sessions scope for ${name}`)
    }
    if (!name.startsWith('agent.') && scope.sessionIds !== undefined) {
      throw new Error(`plugin ${expectedId} capability[${index}] cannot use Agent sessionIds scope for ${name}`)
    }
    return Object.freeze({
      name,
      required: declaration.required,
      reason: normalizedReason(declaration.reason, `plugin ${expectedId} capability[${index}].reason`),
      scope,
    })
  })
  return Object.freeze({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id: expectedId,
    ...(typeof manifest.name === 'string' ? { name: manifest.name.trim() } : {}),
    capabilities: Object.freeze(capabilities),
  })
}

export function platformIdentityKey(identity: CordisXPluginIdentity): string {
  return permissionIdentityKey(identity)
}

export function certifiedArtifactKey(
  identity: Readonly<{ source: string; pluginId: string }>,
  artifact: Readonly<{ version: string; integrity: string }>,
): string {
  return [identity.source, identity.pluginId, artifact.version, artifact.integrity].join('\u0000')
}

export function declarationFingerprint(declaration: CordisXCapabilityDeclaration): string {
  return permissionScopeFingerprint(declaration.name, declaration.scope)
}
