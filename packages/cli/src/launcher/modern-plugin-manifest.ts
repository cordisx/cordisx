import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V8, CORDISX_PLUGIN_MANIFEST_SCHEMA_V9 } from '../permission-contracts.js'
import { normalizePluginManifestV8, normalizePluginManifestV9 } from '../permission-model-v4.js'
import { CapabilityRiskCatalog } from '../capability-risk-catalog.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../extension-point-interaction-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  normalizeTaskManifest,
} from '../agent-task-permission-manifest.js'

/** The package producer and installed-package reader share exact modern manifest validation. */
export function normalizeModernPluginManifest(
  value: { readonly $schema?: unknown; readonly schemaVersion?: unknown },
  expectedId: string,
) {
  if (value.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V8 && value.schemaVersion === 8) {
    return normalizePluginManifestV8(value, expectedId, new CapabilityRiskCatalog())
  }
  if (value.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V9 && value.schemaVersion === 9) {
    return normalizePluginManifestV9(value, expectedId, new CapabilityRiskCatalog())
  }
  if (value.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 && value.schemaVersion === 10) {
    return normalizeVisualManifestV10(value, expectedId)
  }
  if (
    (value.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 && value.schemaVersion === 11)
    || (value.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 && value.schemaVersion === 12)
  ) return normalizeTaskManifest(value, expectedId)
  return undefined
}
