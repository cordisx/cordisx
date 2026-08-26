import type { CordisXPlatformCapability, CordisXRouteReference } from '../../../contracts.js'

export type ManagerPrimaryPage = 'plugins' | 'extension-points' | 'routes' | 'marketplace' | 'about'
export type PluginDetailPage = 'readme' | 'config' | 'permissions' | 'runtime' | 'logs' | 'extension-points' | 'routes'

export type ManagerRoute =
  | { readonly kind: 'primary'; readonly page: ManagerPrimaryPage }
  | { readonly kind: 'plugin'; readonly pluginId: string; readonly page: PluginDetailPage }
  | { readonly kind: 'permission'; readonly pluginId: string; readonly capability: CordisXPlatformCapability }
  | { readonly kind: 'extension-point'; readonly pointId: string }
  | { readonly kind: 'route'; readonly qualifiedId: string }
  | { readonly kind: 'page'; readonly qualifiedId: string }
  | { readonly kind: 'marketplace-plugin'; readonly identity: string }
  | { readonly kind: 'marketplace-sources' }
  | { readonly kind: 'manager-content'; readonly id: string; readonly reference: CordisXRouteReference }

export interface ManagerRouter {
  readonly route: ManagerRoute
  readonly navigate: (route: ManagerRoute) => void
  readonly back: () => void
}

export function primaryFor(route: ManagerRoute): ManagerPrimaryPage {
  if (route.kind === 'primary') return route.page
  if (route.kind === 'extension-point') return 'extension-points'
  if (route.kind === 'route' || route.kind === 'page') return 'routes'
  if (route.kind === 'marketplace-plugin' || route.kind === 'marketplace-sources') return 'marketplace'
  return 'plugins'
}
