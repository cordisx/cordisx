import type { CordisXConfigPlugin } from '../launcher/config.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import type { DesktopManagerConfigProjection } from './desktop-manager-config-projection.js'
import type { ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'
import { hasNoPackageServiceState } from './service-renderer-profile-inputs.js'

export type DesktopConfigProjector =
  & Pick<DesktopManagerConfigProjection, 'project' | 'clear'>
  & Partial<Pick<DesktopManagerConfigProjection, 'canWrite' | 'canCoordinateLifecycle' | 'remember'>>

export function emptyPluginConfig(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

export function desktopPackageConfigBundleOptions(
  plugins: readonly string[] | undefined,
  enabled: boolean | undefined,
) {
  return plugins?.length && enabled
    ? { standaloneDesktopPackageConfig: { token: 'renderer-binding-placeholder', plugins } }
    : {}
}

/** Select only owner-proved package values and live fields for one Manager bootstrap. */
export async function prepareDesktopManagerConfigs(
  input: {
    readonly homeDir: string
    readonly profileId: string
    readonly projectPluginConfig?: DesktopConfigProjector
    readonly desktopPackageConfigEnabled?: () => boolean
  },
  snapshot: ServiceRendererSnapshot,
  plugins: readonly CordisXConfigPlugin[],
  managedOwners: ReadonlyMap<string, string>,
  current: () => boolean,
): Promise<{
  readonly projectedConfigs: Map<string, unknown>
  readonly writablePlugins: string[]
  readonly lifecyclePlugins: string[]
}> {
  const projectedConfigs = new Map<string, unknown>()
  for (const plugin of plugins) {
    if (emptyPluginConfig(plugin.config)) continue
    if (!input.projectPluginConfig) throw new Error('renderer-bootstrap-plugin-unsupported')
    projectedConfigs.set(plugin.id, await input.projectPluginConfig.project(snapshot, plugin))
    if (!current()) throw new Error('renderer-bootstrap-stale')
  }
  const writablePlugins: string[] = []
  const lifecyclePlugins: string[] = []
  const canWrite = input.projectPluginConfig?.canWrite?.bind(input.projectPluginConfig)
  const canCoordinateLifecycle = input.projectPluginConfig?.canCoordinateLifecycle?.bind(input.projectPluginConfig)
  if (canWrite || canCoordinateLifecycle) {
    for (const plugin of plugins) {
      const manifest = plugin.manifest
      if (
        !plugin.package || manifest?.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1
        || manifest.schemaVersion !== 1 || manifest.capabilities.length !== 0 || managedOwners.has(plugin.id)
      ) continue
      try {
        if (await hasNoPackageServiceState(input.homeDir, input.profileId, plugin.id)) {
          const lifecycle = !emptyPluginConfig(plugin.config) && canCoordinateLifecycle !== undefined
            && await canCoordinateLifecycle(snapshot, plugin)
          if (lifecycle) lifecyclePlugins.push(plugin.id)
          // A proved disabled package needs the binding after it is enabled.
          // Renderer and owner checks still refuse writes while it is disabled.
          if (
            input.desktopPackageConfigEnabled?.() && canWrite
            && (plugin.enabled ? await canWrite(snapshot, plugin) : lifecycle)
          ) {
            writablePlugins.push(plugin.id)
          }
        }
      } catch { /* An unproved package remains read-only. */ }
      if (!current()) throw new Error('renderer-bootstrap-stale')
    }
  }
  return { projectedConfigs, writablePlugins, lifecyclePlugins }
}
