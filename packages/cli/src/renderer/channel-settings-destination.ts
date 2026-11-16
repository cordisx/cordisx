import type { ManagerSnapshot } from './manager.js'

interface SettingsDestination {
  readonly owner: string
  readonly source: string
  readonly routeId: string
  readonly live: () => boolean
}
interface Store {
  entries: readonly SettingsDestination[]
  readonly listeners: Set<() => void>
}
const stores = new WeakMap<Document, Store>()
const empty: readonly SettingsDestination[] = Object.freeze([])
function store(document: Document): Store {
  let value = stores.get(document)
  if (!value) {
    value = { entries: empty, listeners: new Set() }
    stores.set(document, value)
  }
  return value
}
export function registerChannelSettingsDestination(document: Document, input: SettingsDestination): () => void {
  const state = store(document)
  const publish = () => {
    for (const listener of state.listeners) listener()
  }
  state.entries = [...state.entries, input]
  publish()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    state.entries = state.entries.filter(item => item !== input)
    publish()
  }
}
export function subscribeChannelSettingsDestinations(document: Document, listener: () => void): () => void {
  const state = store(document)
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
}
export function channelSettingsDestinations(document: Document): readonly SettingsDestination[] {
  return stores.get(document)?.entries ?? empty
}
/** Hiding a fallback requires the real current route/page and an active same-source plugin. */
export function availableChannelSettingsDestination(
  snapshot: ManagerSnapshot,
  entries: readonly SettingsDestination[],
) {
  return [...entries].reverse().find(entry => {
    if (!entry.live()) return false
    const plugin = snapshot.plugins.find(plugin => plugin.id === entry.owner && plugin.source === entry.source)
    if (plugin?.status !== 'active') return false
    if (
      !snapshot.settingsNavigationItems?.some(item =>
        item.owner === entry.owner && !item.disabled && !item.permissionReview
      )
    ) return false
    const route = snapshot.navigation.routes.find(route => route.owner === entry.owner && route.id === entry.routeId)
    if (
      !route?.valid || !route.authorized || route.effectivePointPolicy !== 'allow'
      || route.definition.outlet !== 'manager.content'
    ) return false
    if (route.definition.path.includes(':') || route.definition.path.includes('*')) return false
    return snapshot.navigation.pages.some(page => page.owner === entry.owner && page.id === route.definition.page)
  })
}
