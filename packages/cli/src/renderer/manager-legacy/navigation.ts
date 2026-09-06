import { type CordisXRouteReference } from '../../contracts.js'
import { createHostSurfaceIcon } from '.././icons.js'
import { create } from './dom.js'
import {
  ManagerContentFocusRestore,
  ManagerModel,
  ManagerPageRoute,
  ManagerRouteState,
  ManagerSettingsNavigationItemSnapshot,
  ManagerSnapshot,
} from './model.js'

export interface NavigationDependencies {
  document: Document
  navButtons: Map<string, HTMLButtonElement>
  nav: HTMLElement
  settingsNavigationItems: (snapshot: ManagerSnapshot) => readonly ManagerSettingsNavigationItemSnapshot[]
  activateManagerContent: (
    id: string,
    reference: CordisXRouteReference | undefined,
    restoreFocus: ManagerContentFocusRestore,
    recordHistory?: boolean,
  ) => Promise<void>
  normalizeRoute: (snapshot: ManagerSnapshot, candidate?: ManagerRouteState) => ManagerRouteState
  model: ManagerModel
  routeKey: (route: ManagerRouteState) => string
  routeState: ManagerRouteState
  activateSettingsTab: (id: string, restoreFocus: boolean, recordHistory?: boolean) => Promise<void>
  managerContentFocusRestore: (id: string, reference: CordisXRouteReference) => ManagerContentFocusRestore
  navigationHistory: ManagerRouteState[]
  activePrimary: (route?: ManagerRouteState) => string
  disposeSettingsForRouteChange: () => Promise<void>
  resetManagerContent: () => Promise<void>
  renderContent: () => void
  restoreListScroll: () => void
  resolvePageRoute: (snapshot: ManagerSnapshot) => ManagerPageRoute
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createNavigation(dependencies: NavigationDependencies) {
  const syncSettingsNavigation = (snapshot: ManagerSnapshot): void => {
    const focusedId = dependencies.document.activeElement instanceof dependencies.document.defaultView!.HTMLElement
      ? dependencies.document.activeElement.dataset.managerNavigationId
      : undefined
    for (const [id] of dependencies.navButtons) {
      if (id.startsWith('manager-content:')) dependencies.navButtons.delete(id)
    }
    for (const previous of dependencies.nav.querySelectorAll<HTMLElement>('[data-settings-navigation-item]')) {
      previous.remove()
    }
    const aboutButton = dependencies.navButtons.get('about')
    if (aboutButton === undefined) return
    const items = dependencies.settingsNavigationItems(snapshot)
    const build = (item: ManagerSettingsNavigationItemSnapshot): HTMLButtonElement => {
      const button = create(dependencies.document, 'button', 'cxm-nav-button')
      button.type = 'button'
      button.dataset.settingsNavigationItem = item.id
      button.dataset.managerNavigationId = `manager-content:${item.id}`
      button.dataset.settingsNavigationGroup = item.group
      button.setAttribute('aria-label', item.title)
      button.setAttribute('aria-description', item.description)
      button.disabled = item.disabled
      if (item.disabled) button.setAttribute('aria-disabled', 'true')
      if (item.disabledReason !== undefined) button.title = item.disabledReason
      const icon = createHostSurfaceIcon(dependencies.document, item.icon)
      icon.classList.add('cxm-nav-icon')
      icon.setAttribute('aria-hidden', 'true')
      button.append(icon, create(dependencies.document, 'span', 'cxm-nav-label', item.title))
      button.addEventListener('click', () => {
        if (!item.disabled) void dependencies.activateManagerContent(item.id, item.route, { kind: 'navigation' })
      })
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (!item.disabled) void dependencies.activateManagerContent(item.id, item.route, { kind: 'navigation' })
          return
        }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const candidates = [...dependencies.nav.querySelectorAll<HTMLButtonElement>('.cxm-nav-button')].filter(
          candidate => !candidate.disabled,
        )
        const index = candidates.indexOf(button)
        const next = event.key === 'Home'
          ? candidates[0]
          : event.key === 'End'
          ? candidates.at(-1)
          : candidates.at((index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length)
        next?.focus()
      })
      dependencies.navButtons.set(`manager-content:${item.id}`, button)
      return button
    }
    // The old Settings row is intentionally absent. Both compatibility groups share
    // this Host-owned virtual seam immediately before About, never a plugin anchor.
    for (const item of items) dependencies.nav.insertBefore(build(item), aboutButton)
    if (focusedId !== undefined) dependencies.navButtons.get(focusedId)?.focus()
  }

  const navigateRoute = async (
    target: ManagerRouteState,
    options: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean } = {},
  ): Promise<void> => {
    const recordHistory = options.recordHistory ?? true
    const restoreFocus = options.restoreFocus ?? false
    const next = dependencies.normalizeRoute(dependencies.model.snapshot(), target)
    if (dependencies.routeKey(next) === dependencies.routeKey(dependencies.routeState)) return
    if (next.kind === 'settings') {
      await dependencies.activateSettingsTab(next.tabId, restoreFocus, recordHistory)
      return
    }
    if (next.kind === 'manager-content') {
      await dependencies.activateManagerContent(
        next.id,
        next.reference,
        restoreFocus ? dependencies.managerContentFocusRestore(next.id, next.reference) : undefined,
        recordHistory,
      )
      return
    }
    const previous = dependencies.routeState
    if (recordHistory) dependencies.navigationHistory.push(previous)
    if (dependencies.activePrimary(previous) === 'settings') await dependencies.disposeSettingsForRouteChange()
    if (previous.kind === 'manager-content') {
      await dependencies.resetManagerContent()
    }
    dependencies.routeState = next
    dependencies.renderContent()
    if (next.kind === 'primary') dependencies.restoreListScroll()
    if (restoreFocus && next.kind === 'primary') dependencies.navButtons.get(next.primary)?.focus()
  }

  const navigateBack = async (): Promise<void> => {
    const snapshot = dependencies.model.snapshot()
    let target: ManagerRouteState | undefined
    while (dependencies.navigationHistory.length > 0 && target === undefined) {
      const candidate = dependencies.navigationHistory.pop()
      if (candidate === undefined) break
      const normalized = dependencies.normalizeRoute(snapshot, candidate)
      if (dependencies.routeKey(normalized) !== dependencies.routeKey(dependencies.routeState)) target = normalized
    }
    if (target === undefined) {
      const segments = dependencies.resolvePageRoute(snapshot).segments
      target = [...segments].reverse().find(segment => (
        segment.target !== undefined
        && dependencies.routeKey(segment.target) !== dependencies.routeKey(dependencies.routeState)
      ))?.target
    }
    if (target !== undefined) await navigateRoute(target, { recordHistory: false, restoreFocus: true })
    else dependencies.navButtons.get(dependencies.activePrimary())?.focus()
  }
  return { syncSettingsNavigation, navigateRoute, navigateBack }
}
