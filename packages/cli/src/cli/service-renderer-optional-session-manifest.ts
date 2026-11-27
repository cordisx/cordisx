import { CapabilityRiskCatalog } from '../capability-risk-catalog.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../permission-contracts.js'
import { normalizePluginManifestV5 } from '../permission-model-v4.js'

/** Session reads are optional and have no standalone transport or native Session seat. */
export function isServiceRendererOptionalSessionManifest(value: unknown, pluginId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 || item.schemaVersion !== 5) return false
  try {
    const manifest = normalizePluginManifestV5(value, pluginId, new CapabilityRiskCatalog())
    return manifest.services.length === 0 && manifest.capabilities.length > 0
      && manifest.capabilities.every(capability =>
        capability.required === false
        && ['sessions.get', 'sessions.read', 'sessions.subscribe'].includes(capability.name)
      )
  } catch {
    return false
  }
}
