import { normalizeTaskManifest } from './agent-task-permission-manifest.js'
import type {
  PluginManifestRuntimeExactCapabilityDeclarationV13,
  PluginManifestRuntimeExactCapabilityNameV13,
  PluginRuntimeManifestV13,
} from '@cordisx/protocol/plugin-manifest/v13'
import type { PluginRuntimeManifestV12 } from '@cordisx/protocol/plugin-manifest/v12'
import { type CordisXPluginManifestV11 } from './usage-permissions.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v12.schema.json' as const
export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v13.schema.json' as const
export type CordisXPluginManifestV12 = Omit<PluginRuntimeManifestV12, 'services'> & {
  readonly services: CordisXPluginManifestV11['services']
}
export type CordisXPluginManifestV13 = Omit<PluginRuntimeManifestV13, 'services'> & {
  readonly services: CordisXPluginManifestV11['services']
}

const RUNTIME_EXACT = new Set<PluginManifestRuntimeExactCapabilityNameV13>([
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
])

export function isRuntimeExactRequestDeclaration(
  value: unknown,
): value is PluginManifestRuntimeExactCapabilityDeclarationV13 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const declaration = value as Record<string, unknown>
  if (
    Object.keys(declaration).some(key => !['name', 'required', 'scope'].includes(key))
    || typeof declaration.name !== 'string'
    || !RUNTIME_EXACT.has(declaration.name as PluginManifestRuntimeExactCapabilityNameV13)
    || declaration.required !== false
    || declaration.scope === null || typeof declaration.scope !== 'object' || Array.isArray(declaration.scope)
  ) return false
  const scope = declaration.scope as Record<string, unknown>
  return Object.keys(scope).length === 1 && scope.runtime === 'exact-request'
}

export function normalizePluginManifestV12(value: unknown, expectedId: string): CordisXPluginManifestV12 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v12')
  const manifest = value as Record<string, unknown>
  if (
    manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 || manifest.schemaVersion !== 12
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 37
  ) throw new Error('Unsupported manifest v12')
  if (
    manifest.capabilities.some(candidate =>
      (candidate as { readonly scope?: { readonly runtime?: unknown } })?.scope?.runtime !== undefined
    )
  ) throw new Error('manifest v12 must not declare runtime exact-request scope')
  return normalizeTaskManifest(value, expectedId) as CordisXPluginManifestV12
}

export function normalizePluginManifestV13(value: unknown, expectedId: string): CordisXPluginManifestV13 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v13')
  const manifest = value as Record<string, unknown>
  if (
    manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 || manifest.schemaVersion !== 13
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 37
  ) throw new Error('Unsupported manifest v13')
  const exact = manifest.capabilities.filter(candidate => isRuntimeExactRequestDeclaration(candidate))
  const invalidExact = manifest.capabilities.find(candidate =>
    typeof (candidate as { name?: unknown })?.name === 'string'
    && RUNTIME_EXACT.has((candidate as { name: PluginManifestRuntimeExactCapabilityNameV13 }).name)
    && (candidate as { scope?: { runtime?: unknown } }).scope?.runtime !== undefined
    && !isRuntimeExactRequestDeclaration(candidate)
  )
  if (invalidExact !== undefined) throw new Error('Invalid runtime exact-request declaration')
  const base = normalizePluginManifestV12({
    ...manifest,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
    schemaVersion: 12,
    capabilities: manifest.capabilities.filter(candidate => !isRuntimeExactRequestDeclaration(candidate)),
  }, expectedId)
  return Object.freeze({
    ...base,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
    schemaVersion: 13,
    capabilities: Object.freeze([
      ...base.capabilities,
      ...exact.map(candidate =>
        Object.freeze({
          name: candidate.name,
          required: false as const,
          scope: Object.freeze({ runtime: 'exact-request' as const }),
        })
      ),
    ]),
  }) as CordisXPluginManifestV13
}

export function runtimeExactCapabilities(
  manifest: CordisXPluginManifestV13,
): ReadonlySet<PluginManifestRuntimeExactCapabilityNameV13> {
  return new Set(manifest.capabilities.filter(isRuntimeExactRequestDeclaration).map(item => item.name))
}
