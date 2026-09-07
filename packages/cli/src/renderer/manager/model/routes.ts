import type { CordisXRouteReference } from '../../../contracts.js'
import type { CordisXPermissionCapabilityV4 } from '../../../permission-contracts.js'

export type ManagerPrimaryPage = 'plugins' | 'plugin-bundles' | 'extension-points' | 'routes' | 'marketplace' | 'about'
export type PluginDetailPage = 'readme' | 'config' | 'permissions' | 'runtime' | 'logs' | 'extension-points' | 'routes'
export type PluginBundleDetailPage = 'readme' | 'members' | 'permissions' | 'relations' | 'records'

export type ManagerRoute =
  | { readonly kind: 'primary'; readonly page: ManagerPrimaryPage }
  | { readonly kind: 'plugin'; readonly pluginId: string; readonly page: PluginDetailPage }
  | { readonly kind: 'plugin-bundle'; readonly bundleId: string; readonly page: PluginBundleDetailPage }
  | {
    readonly kind: 'permission'
    readonly pluginId: string
    readonly capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact'
    readonly fingerprint: string
  }
  | { readonly kind: 'extension-point'; readonly pointId: string }
  | { readonly kind: 'route'; readonly qualifiedId: string }
  | { readonly kind: 'page'; readonly qualifiedId: string }
  | { readonly kind: 'marketplace-plugin'; readonly identity: string }
  | { readonly kind: 'marketplace-sources' }
  | { readonly kind: 'about-acknowledgements' }
  | { readonly kind: 'manager-content'; readonly id: string; readonly reference: CordisXRouteReference }

export interface ManagerRouter {
  readonly route: ManagerRoute
  readonly navigate: (route: ManagerRoute) => void
  /** Host-owned tab activation replaces the current Manager history entry. */
  readonly replace: (route: ManagerRoute) => void
  /** Open an external detail target with one exact in-Manager Back destination. */
  readonly openDetail: (root: ManagerRoute, detail: ManagerRoute) => void
  readonly back: () => void
}

/**
 * The old bundle primary route remains readable so persisted Manager history
 * and callers from an older renderer can return safely. Plugin Store remains
 * an independent primary destination.
 */
export function normalizeManagerRoute(route: ManagerRoute): ManagerRoute {
  if (route.kind === 'primary' && route.page === 'plugin-bundles') return { kind: 'primary', page: 'plugins' }
  return route
}

export function normalizeManagerHistory(history: readonly ManagerRoute[]): readonly ManagerRoute[] {
  const normalized = history.map(normalizeManagerRoute).filter((route, index, routes) => (
    index === 0 || JSON.stringify(routes[index - 1]) !== JSON.stringify(route)
  ))
  return normalized.length > 0 ? normalized : [{ kind: 'primary', page: 'plugins' }]
}

export function primaryFor(route: ManagerRoute): ManagerPrimaryPage {
  if (route.kind === 'primary') {
    return route.page === 'plugin-bundles' ? 'plugins' : route.page
  }
  if (route.kind === 'extension-point') return 'extension-points'
  if (route.kind === 'route' || route.kind === 'page') return 'routes'
  if (route.kind === 'about-acknowledgements') return 'about'
  if (route.kind === 'marketplace-plugin' || route.kind === 'marketplace-sources') return 'marketplace'
  return 'plugins'
}
