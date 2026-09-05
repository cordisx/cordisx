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
    readonly capability: CordisXPermissionCapabilityV4
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

export function primaryFor(route: ManagerRoute): ManagerPrimaryPage {
  if (route.kind === 'primary') return route.page
  if (route.kind === 'extension-point') return 'extension-points'
  if (route.kind === 'route' || route.kind === 'page') return 'routes'
  if (route.kind === 'marketplace-plugin' || route.kind === 'marketplace-sources') return 'marketplace'
  if (route.kind === 'plugin-bundle') return 'plugin-bundles'
  if (route.kind === 'about-acknowledgements') return 'about'
  return 'plugins'
}
