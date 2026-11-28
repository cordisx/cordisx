import type { CordisXConfigPlugin } from '../launcher/config.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import type { DesktopManagerConfigProjection } from './desktop-manager-config-projection.js'
import type { ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'
import { hasNoPackageServiceState } from './service-renderer-profile-inputs.js'

export type DesktopConfigProjector =
  & Pick<DesktopManagerConfigProjection, 'project' | 'clear'>
  & Partial<
    Pick<DesktopManagerConfigProjection, 'projectForAdmission' | 'canWrite' | 'canCoordinateLifecycle' | 'remember'>
  >

/** Retain the Desktop owner's exact configured selection across confirmed writes. */
export class DesktopConfiguredSelection {
  private plugins: readonly CordisXConfigPlugin[] | undefined

  constructor(plugins: readonly CordisXConfigPlugin[] | undefined) {
    this.plugins = plugins === undefined ? undefined : structuredClone(plugins)
  }

  matches(plugins: readonly CordisXConfigPlugin[]): boolean {
    return this.plugins === undefined || attachmentEqual(this.plugins, plugins)
  }

  readonly adopt = (previous: readonly CordisXConfigPlugin[], next: readonly CordisXConfigPlugin[]): boolean => {
    if (this.plugins === undefined || !attachmentEqual(this.plugins, previous)) return false
    this.plugins = structuredClone(next)
    return true
  }
}

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

/** Classify each installed configuration before acquiring browser graph leases. */
export async function preflightDesktopManagerConfigs(
  projector: DesktopConfigProjector | undefined,
  snapshot: ServiceRendererSnapshot,
  plugins: readonly CordisXConfigPlugin[],
  current: () => boolean,
): Promise<{ readonly unavailable: Set<string>; readonly values: Map<string, unknown> }> {
  const unavailable = new Set<string>()
  const values = new Map<string, unknown>()
  for (const plugin of plugins) {
    if (emptyPluginConfig(plugin.config)) continue
    if (!projector) unavailable.add(plugin.id)
    else if (projector.projectForAdmission) {
      const result = await projector.projectForAdmission(snapshot, plugin)
      if (result.status === 'unavailable') unavailable.add(plugin.id)
      else values.set(plugin.id, result.value)
    } else values.set(plugin.id, await projector.project(snapshot, plugin))
    if (!current()) throw new Error('renderer-bootstrap-stale')
  }
  return { unavailable, values }
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
  preprojected: ReadonlyMap<string, unknown>,
): Promise<{
  readonly projectedConfigs: Map<string, unknown>
  readonly writablePlugins: string[]
  readonly lifecyclePlugins: string[]
}> {
  const projectedConfigs = new Map<string, unknown>()
  for (const plugin of plugins) {
    if (emptyPluginConfig(plugin.config)) continue
    if (!input.projectPluginConfig || !preprojected.has(plugin.id)) {
      throw new Error('renderer-bootstrap-plugin-unsupported')
    }
    projectedConfigs.set(plugin.id, structuredClone(preprojected.get(plugin.id)))
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

/** Only graphs already admitted by the owner may receive configured-plugin write capability. */
export async function prepareDesktopConfiguredConfigWrites(
  input: {
    readonly projectPluginConfig?: DesktopConfigProjector
    readonly desktopPackageConfigEnabled?: () => boolean
  },
  snapshot: ServiceRendererSnapshot,
  plugins: readonly CordisXConfigPlugin[],
  configured: readonly { readonly pluginId: string }[],
  current: () => boolean,
): Promise<string[]> {
  const canWrite = input.projectPluginConfig?.canWrite?.bind(input.projectPluginConfig)
  if (!input.desktopPackageConfigEnabled?.() || !canWrite) return []
  const eligible = new Set(configured.map(item => item.pluginId))
  const writable: string[] = []
  for (const plugin of plugins) {
    if (!eligible.has(plugin.id)) continue
    try {
      if (await canWrite(snapshot, plugin)) writable.push(plugin.id)
    } catch { /* An unproved configured archive remains read-only. */ }
    if (!current()) throw new Error('renderer-bootstrap-stale')
  }
  return writable
}
