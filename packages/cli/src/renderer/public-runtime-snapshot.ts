import type { ManagerSnapshot } from './manager.js'
import type { ExtensionPointRuntimeSnapshot } from './extension-points.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'

function publicRegistration<T extends SurfaceContributionSnapshot>(registration: T): T {
  const { control: _control, ...projected } = registration
  return projected as T
}

function publicExtensionPoints(snapshot: ExtensionPointRuntimeSnapshot): ExtensionPointRuntimeSnapshot {
  return {
    ...snapshot,
    points: snapshot.points.map(point => ({
      ...point,
      plugins: point.plugins.map(plugin => ({
        ...plugin,
        registrations: plugin.registrations.map(publicRegistration),
      })),
    })),
  }
}

/** Remove every Host-private control-plane projection from the plugin/debug snapshot. */
export function projectPublicRuntimeSnapshot(snapshot: ManagerSnapshot): ManagerSnapshot {
  const {
    localDevelopment: _localDevelopment,
    extensionPointControls: _extensionPointControls,
    ...projected
  } = snapshot
  return {
    ...projected,
    registrations: projected.registrations.map(publicRegistration),
    plugins: projected.plugins.map(plugin => {
      const { development: _development, ...publicPlugin } = plugin
      return publicPlugin
    }),
    ...(projected.extensionPoints === undefined ? {} : { extensionPoints: publicExtensionPoints(projected.extensionPoints) }),
  }
}
