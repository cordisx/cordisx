import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  type CordisXPluginManifestV12,
  type CordisXPluginManifestV13,
  normalizePluginManifestV12,
  normalizePluginManifestV13,
} from '../runtime-exact-request-permissions.js'
import type { CordisXPluginManifestV11 } from '../usage-permissions.js'

export function normalizeLatestRuntimeManifest(
  value: unknown,
  expectedId: string,
): CordisXPluginManifestV12 | CordisXPluginManifestV13 | undefined {
  const candidate = value as { readonly $schema?: unknown; readonly schemaVersion?: unknown }
  return candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 && candidate.schemaVersion === 12
    ? normalizePluginManifestV12(value, expectedId)
    : candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 && candidate.schemaVersion === 13
    ? normalizePluginManifestV13(value, expectedId)
    : undefined
}

export function runtimeManifestHasServices<T extends { readonly schemaVersion: number }>(
  manifest: T,
): manifest is T & { readonly services: CordisXPluginManifestV11['services'] } {
  return manifest.schemaVersion >= 4
}
