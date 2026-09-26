import type { CordisXRouteReference } from '../../../contracts.js'
import type { ManagerRoute } from './routes.js'

/** A root keeps its identity mark; only a route with a real parent exposes Back. */
export function managerHeaderBackRoute(
  route: ManagerRoute,
  managerContentParent?: CordisXRouteReference,
  previous?: ManagerRoute,
): ManagerRoute | undefined {
  if (route.kind === 'primary') return undefined
  if (route.kind === 'manager-content') {
    return managerContentParent === undefined
      ? undefined
      : { kind: 'manager-content', id: route.id, reference: managerContentParent }
  }
  if (route.kind === 'notification-rules') return previous
  if (route.kind === 'extension-point') return { kind: 'primary', page: 'extension-points' }
  if (route.kind === 'route' || route.kind === 'page') return { kind: 'primary', page: 'routes' }
  if (route.kind === 'marketplace-source-edit') return { kind: 'marketplace-sources' }
  if (route.kind === 'marketplace-plugin' || route.kind === 'marketplace-sources') {
    return { kind: 'primary', page: 'marketplace' }
  }
  if (route.kind === 'model-connection-create') return { kind: 'primary', page: 'model-services' }
  if (route.kind === 'about-acknowledgements') return { kind: 'primary', page: 'about' }
  return { kind: 'primary', page: 'plugins' }
}
