import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../extension-point-interaction-permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../usage-permissions.js'

/** A service-free visual graph has no standalone native seat or usage provider. */
export function isServiceRendererVisualManifest(value: unknown, pluginId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  try {
    const manifest = item.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 && item.schemaVersion === 10
      ? normalizeVisualManifestV10(value, pluginId)
      : item.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 && item.schemaVersion === 11
      ? normalizeUsageManifestV11(value, pluginId)
      : undefined
    return !!manifest && manifest.services.length === 0
      && manifest.capabilities.every(capability =>
        capability.name === 'ui.extension-points.render'
        || (capability.name === 'ui.extension-points.interact' || capability.name === 'usage.read')
          && capability.required === false
      )
  } catch {
    return false
  }
}
