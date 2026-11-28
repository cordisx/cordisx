import { normalizePluginManifest } from '../renderer/platform/platform-manifest.js'

/** A service-free graph can use the owner model catalog when the capability is optional. */
export function isServiceRendererOptionalModelManifest(value: unknown, pluginId: string): boolean {
  try {
    if (
      !value || typeof value !== 'object' || Array.isArray(value)
      || ![4, 5, 10, 11].includes(Number((value as { schemaVersion?: unknown }).schemaVersion))
    ) return false
    const manifest = normalizePluginManifest(value, pluginId)
    if (manifest.schemaVersion === 1 || manifest.services.length !== 0) return false
    return manifest.capabilities.some(capability => capability.name === 'models.read')
      && manifest.capabilities.every(capability =>
        capability.name === 'models.read'
          ? capability.required === false && Object.keys(capability.scope).every(key => key === 'providers')
          : capability.name === 'ui.extension-points.render'
      )
  } catch {
    return false
  }
}
