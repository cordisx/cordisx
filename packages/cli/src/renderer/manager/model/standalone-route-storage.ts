import { type ManagerRoute, normalizeManagerRoute, primaryFor } from './routes.js'

const KEY = 'cordisx.standalone.manager.route.v1'
const primaryPages = new Set([
  'plugins',
  'plugin-bundles',
  'extension-points',
  'routes',
  'marketplace',
  'about',
  'model-services',
])
const pluginPages = new Set(['readme', 'config', 'permissions', 'runtime', 'logs', 'extension-points', 'routes'])
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,255}$/u.test(value)
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))

/** Only navigation identities are stored; route parameters and edit inputs are never persisted. */
function safeRoute(value: unknown): ManagerRoute | undefined {
  const route = object(value)
  if (!route || typeof route.kind !== 'string') return undefined
  if (
    route.kind === 'primary' && keysAre(route, ['kind', 'page']) && typeof route.page === 'string'
    && primaryPages.has(route.page)
  ) {
    return normalizeManagerRoute({
      kind: 'primary',
      page: route.page as Extract<ManagerRoute, { kind: 'primary' }>['page'],
    })
  }
  if (
    route.kind === 'plugin' && keysAre(route, ['kind', 'pluginId', 'page']) && identifier(route.pluginId)
    && typeof route.page === 'string' && pluginPages.has(route.page)
  ) {
    return {
      kind: 'plugin',
      pluginId: route.pluginId,
      page: route.page as Extract<ManagerRoute, { kind: 'plugin' }>['page'],
    }
  }
  if (route.kind === 'manager-content' && keysAre(route, ['kind', 'id', 'reference']) && identifier(route.id)) {
    const reference = object(route.reference)
    if (reference && keysAre(reference, ['id']) && identifier(reference.id)) {
      return { kind: 'manager-content', id: route.id, reference: { id: reference.id } }
    }
  }
  if (
    (route.kind === 'marketplace-sources' || route.kind === 'notification-rules'
      || route.kind === 'about-acknowledgements')
    && keysAre(route, ['kind'])
  ) return { kind: route.kind }
  return undefined
}

export function readStandaloneManagerRoute(storage: Storage | undefined): ManagerRoute | undefined {
  if (!storage) return undefined
  try {
    const value = storage.getItem(KEY)
    if (value === null || value.length > 2048) return undefined
    return safeRoute(JSON.parse(value))
  } catch {
    return undefined
  }
}

export function writeStandaloneManagerRoute(storage: Storage | undefined, route: ManagerRoute): void {
  if (!storage) return
  try {
    const value = safeRoute(route) ?? { kind: 'primary', page: primaryFor(route) }
    storage.setItem(KEY, JSON.stringify(value))
  } catch { /* Storage can be disabled; navigation still works in memory. */ }
}
