import type { UsageReadCapabilityV1 } from '@cordisx/protocol/usage/v1'
import type { PluginRuntimeManifestV11 } from '@cordisx/protocol/plugin-manifest/v11'
import { normalizeVisualManifestV10 } from './extension-point-interaction-permissions.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v11.schema.json' as const
export type CordisXPluginManifestV11 = Omit<PluginRuntimeManifestV11, 'services'> & {
  readonly services: ReturnType<typeof normalizeVisualManifestV10>['services']
}
export function normalizeUsageDeclaration(value: unknown): UsageReadCapabilityV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage declaration')
  const item = value as Record<string, unknown>
  const scope = item.scope as Record<string, unknown> | undefined
  if (
    Object.keys(item).some(key => !['name', 'required', 'scope'].includes(key)) || item.name !== 'usage.read'
    || typeof item.required !== 'boolean' || !scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).length !== 1 || scope.profile !== 'current'
  ) throw new Error('Invalid usage scope')
  return Object.freeze({ name: 'usage.read', required: item.required, scope: Object.freeze({ profile: 'current' }) })
}
export function normalizeUsageManifestV11(value: unknown, expectedId: string): CordisXPluginManifestV11 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v11')
  const manifest = value as Record<string, unknown>
  if (
    manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 || manifest.schemaVersion !== 11
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 37
  ) throw new Error('Unsupported manifest v11')
  const usage = manifest.capabilities.filter(item => item?.name === 'usage.read').map(normalizeUsageDeclaration)
  if (usage.length > 1) throw new Error('Duplicate usage declaration')
  const base = normalizeVisualManifestV10({
    ...manifest,
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v10.schema.json',
    schemaVersion: 10,
    capabilities: manifest.capabilities.filter(item => item?.name !== 'usage.read'),
  }, expectedId)
  return Object.freeze({
    ...base,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
    schemaVersion: 11,
    capabilities: Object.freeze([...base.capabilities, ...usage]),
  })
}
