import type { CordisXConfigPlugin } from '../launcher/config.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import { loadServiceRendererPackage } from './service-renderer-projection.js'
import type { ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'

/** Revalidate packages against the owner's current activation before exposing any operation. */
export async function restrictedLifecycleIds(
  homeDir: string,
  snapshot: ServiceRendererSnapshot,
  plugins: readonly CordisXConfigPlugin[],
  configured: ReadonlySet<string> = new Set(),
): Promise<ReadonlySet<string>> {
  const allowed = new Set<string>()
  const byId = new Map(plugins.map(plugin => [plugin.id, plugin]))
  for (const item of snapshot.active.plugins) {
    const plugin = byId.get(item.id)
    const config = plugin?.config
    const manifest = plugin?.manifest
    if (
      !plugin?.package || plugin.package.digest !== item.digest || plugin.package.version !== item.version
      || plugin.package.moduleGeneration !== item.moduleGeneration || plugin.enabled !== item.enabled
      || config === null || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).length !== 0 && !configured.has(item.id)
      || manifest?.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 || manifest.schemaVersion !== 1
      || manifest.capabilities.length !== 0
    ) continue
    try {
      const staged = await loadServiceRendererPackage(homeDir, item)
      if (attachmentEqual(staged.manifest.runtimeManifest, manifest) && staged.identitySource === plugin.source) {
        allowed.add(item.id)
      }
    } catch { /* An unsupported or stale package has no projected lifecycle actions. */ }
  }
  return allowed
}
