import type { ManagerSnapshot } from './manager.js'
import type { ExtensionPointRuntimeSnapshot } from './extension-points.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import type { RedactedIconThemeSnapshot } from './icon-theme-registry.js'

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

function publicIconThemes(snapshot: RedactedIconThemeSnapshot): RedactedIconThemeSnapshot {
  return {
    profileId: snapshot.profileId,
    profileRevision: snapshot.profileRevision,
    selected: {
      providerId: snapshot.selected.providerId,
      namespace: snapshot.selected.namespace,
      protocolVersion: snapshot.selected.protocolVersion,
      providerVersion: snapshot.selected.providerVersion,
      providerGeneration: snapshot.selected.providerGeneration,
    },
    providers: snapshot.providers.map(provider => ({
      providerId: provider.providerId,
      namespace: provider.namespace,
      providerVersion: provider.providerVersion,
      providerGeneration: provider.providerGeneration,
      status: provider.status,
      coverage: provider.coverage,
      tupleCount: provider.tupleCount,
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
    ...(projected.iconThemes === undefined ? {} : { iconThemes: publicIconThemes(projected.iconThemes) }),
    ...(projected.extensionPoints === undefined ? {} : { extensionPoints: publicExtensionPoints(projected.extensionPoints) }),
  }
}
