import { type CordisXIconToken, type CordisXRouteReference } from '../../contracts.js'
import { createHostSurfaceIcon } from '.././icons.js'
import { create } from './dom.js'
import type { ManagerContentState } from './interaction-state.js'
import {
  ManagerContentFocusRestore,
  ManagerModel,
  ManagerRouteState,
  ManagerSettingsNavigationItemSnapshot,
  ManagerSnapshot,
} from './model.js'

export interface ContentMountDependencies {
  model: ManagerModel
  navButtons: Map<string, HTMLButtonElement>
  content: HTMLDivElement
  settingsNavigationItems: (snapshot: ManagerSnapshot) => readonly ManagerSettingsNavigationItemSnapshot[]
  routeState: ManagerRouteState
  routeKey: (route: ManagerRouteState) => string
  navigationHistory: ManagerRouteState[]
  renderContent: () => void
  document: Document
  navigateBack: () => Promise<void>
  setDirectManagerNavigationHeading: (title: string, icon: CordisXIconToken) => void
  contentState: Pick<
    ManagerContentState,
    | 'managerContentMount'
    | 'managerContentMountId'
    | 'managerContentTransition'
    | 'managerContentError'
    | 'managerContentTransitioning'
    | 'managerContentRoot'
  >
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createContentMount(dependencies: ContentMountDependencies) {
  const stopManagerContent = async (): Promise<void> => {
    const mount = dependencies.contentState.managerContentMount
    const mountId = dependencies.contentState.managerContentMountId
    dependencies.contentState.managerContentMount = undefined
    dependencies.contentState.managerContentMountId = undefined
    if (mount === undefined && mountId === undefined) return
    mount?.abort()
    if (dependencies.model.closeManagerContent !== undefined) await dependencies.model.closeManagerContent()
    else await mount?.dispose()
  }

  const resetManagerContent = async (): Promise<void> => {
    dependencies.contentState.managerContentTransition += 1
    if (
      dependencies.contentState.managerContentMount === undefined
      && dependencies.contentState.managerContentMountId === undefined
    ) {
      dependencies.contentState.managerContentError = undefined
      dependencies.contentState.managerContentTransitioning = false
      dependencies.contentState.managerContentRoot = undefined
      return
    }
    dependencies.contentState.managerContentTransitioning = true
    try {
      await stopManagerContent()
    } finally {
      dependencies.contentState.managerContentError = undefined
      dependencies.contentState.managerContentTransitioning = false
      dependencies.contentState.managerContentRoot = undefined
    }
  }

  const focusManagerContentNavigation = (id: string): void => {
    dependencies.navButtons.get(`manager-content:${id}`)?.focus()
  }

  const focusManagerContentTab = (id: string): void => {
    dependencies.content.querySelectorAll<HTMLButtonElement>('[data-manager-content-tab]').forEach(button => {
      if (button.dataset.managerContentTab === id) button.focus()
    })
  }

  const managerContentReferenceKey = (reference: CordisXRouteReference): string => (
    `${reference.id}\u0000${
      JSON.stringify(Object.entries(reference.params ?? {}).sort(([left], [right]) => left.localeCompare(right)))
    }`
  )

  const managerContentKey = (id: string, reference: CordisXRouteReference): string =>
    `${id}\u0000${managerContentReferenceKey(reference)}`

  // Encode each local-id code point independently. Concatenated punctuation
  // cannot alias: e.g. "a.b" and "a-b" deliberately produce different IDs.
  const managerContentDomIdPart = (value: string): string =>
    [...value]
      .map(character => character.codePointAt(0)!.toString(16))
      .join('-')

  const managerContentPanelId = (id: string): string => `cordisx-manager-content-panel-${managerContentDomIdPart(id)}`

  const managerContentTabId = (id: string, tabId: string): string => (
    `cordisx-manager-content-tab-${managerContentDomIdPart(id)}-${managerContentDomIdPart(tabId)}`
  )

  const managerContentFocusRestore = (id: string, reference: CordisXRouteReference): ManagerContentFocusRestore => {
    const tabs = dependencies.model.managerContentPresentation?.(id, reference)?.tabs ?? []
    const active = tabs.filter(tab => managerContentReferenceKey(tab.route) === managerContentReferenceKey(reference))
    return active.length === 1 ? { kind: 'tab', id: active[0]!.id } : { kind: 'navigation' }
  }

  const activateManagerContent = async (
    id: string,
    reference: CordisXRouteReference | undefined,
    restoreFocus: ManagerContentFocusRestore,
    recordHistory = true,
  ): Promise<void> => {
    const item = dependencies.settingsNavigationItems(dependencies.model.snapshot()).find(candidate =>
      candidate.id === id
    )
    if (item === undefined || dependencies.contentState.managerContentTransitioning) return
    const resolvedReference = reference ?? item.route
    if (
      dependencies.model.managerContentPresentation !== undefined
      && dependencies.model.managerContentPresentation(id, resolvedReference) === undefined
    ) return
    const previousRoute = dependencies.routeState
    const nextRoute: ManagerRouteState = { kind: 'manager-content', id, reference: resolvedReference }
    const mountKey = managerContentKey(id, resolvedReference)
    if (
      dependencies.routeKey(previousRoute) === dependencies.routeKey(nextRoute)
      && dependencies.contentState.managerContentMountId === mountKey
    ) {
      if (restoreFocus?.kind === 'navigation') focusManagerContentNavigation(id)
      if (restoreFocus?.kind === 'tab') focusManagerContentTab(restoreFocus.id)
      return
    }
    if (recordHistory && dependencies.routeKey(previousRoute) !== dependencies.routeKey(nextRoute)) {
      dependencies.navigationHistory.push(previousRoute)
    }
    const token = ++dependencies.contentState.managerContentTransition
    dependencies.contentState.managerContentTransitioning = true
    dependencies.contentState.managerContentMount?.abort()
    try {
      await stopManagerContent()
      if (token !== dependencies.contentState.managerContentTransition) return
      dependencies.routeState = nextRoute
      dependencies.contentState.managerContentError = undefined
      dependencies.contentState.managerContentTransitioning = false
      dependencies.renderContent()
      if (
        dependencies.model.mountManagerContent === undefined
        || dependencies.contentState.managerContentRoot === undefined
      ) {
        throw new Error('manager content page mount is unavailable')
      }
      dependencies.contentState.managerContentRoot.setAttribute('aria-busy', 'true')
      const loading = create(dependencies.document, 'div', 'cxm-notice', '正在加载插件页面…')
      dependencies.contentState.managerContentRoot.replaceChildren(loading)
      dependencies.contentState.managerContentMountId = mountKey
      const mount = await dependencies.model.mountManagerContent(
        id,
        resolvedReference,
        dependencies.contentState.managerContentRoot,
        {
          navigate: next => activateManagerContent(id, next, undefined),
          back: async () => {
            const active = dependencies.routeState
            if (active.kind !== 'manager-content') return
            const presentation = dependencies.model.managerContentPresentation?.(active.id, active.reference)
            if (presentation?.parent !== undefined) {
              await activateManagerContent(active.id, presentation.parent, { kind: 'navigation' })
            } else await dependencies.navigateBack()
          },
        },
      )
      if (
        token !== dependencies.contentState.managerContentTransition
        || dependencies.routeState.kind !== 'manager-content'
        || dependencies.routeState.id !== id || managerContentKey(id, dependencies.routeState.reference) !== mountKey
      ) {
        mount.abort()
        await mount.dispose()
        return
      }
      dependencies.contentState.managerContentMount = mount
      dependencies.contentState.managerContentMountId = mountKey
      loading.remove()
      dependencies.contentState.managerContentRoot.removeAttribute('aria-busy')
      if (restoreFocus?.kind === 'navigation') focusManagerContentNavigation(id)
      if (restoreFocus?.kind === 'tab') focusManagerContentTab(restoreFocus.id)
    } catch (error) {
      if (token !== dependencies.contentState.managerContentTransition) return
      dependencies.contentState.managerContentMount?.abort()
      await stopManagerContent().catch(() => {})
      dependencies.contentState.managerContentError = error instanceof Error ? error.message : String(error)
      dependencies.routeState = { kind: 'primary', primary: 'plugins' }
      dependencies.contentState.managerContentTransitioning = false
      dependencies.renderContent()
      if (restoreFocus !== undefined) dependencies.navButtons.get('plugins')?.focus()
    }
  }

  const renderManagerContent = (snapshot: ManagerSnapshot, id: string, reference: CordisXRouteReference): void => {
    const item = dependencies.settingsNavigationItems(snapshot).find(candidate => candidate.id === id)
    if (item === undefined) return
    const projection = dependencies.model.managerContentPresentation?.(id, reference) ?? {
      title: item.pageTitle,
      description: item.pageDescription,
      icon: item.icon,
      tabs: [],
    }
    // The current exact route is the only authority for selection. An invalid
    // projection is rendered as an untabbed page instead of emitting a broken
    // tablist with no active tab or an orphaned aria-labelledby reference.
    const activeTabs = projection.tabs.filter(tab => (
      managerContentReferenceKey(tab.route) === managerContentReferenceKey(reference)
    ))
    const activeTab = activeTabs.length === 1 ? activeTabs[0] : undefined
    const tabs = activeTab === undefined
      ? []
      : projection.tabs.map(tab => ({ ...tab, active: tab === activeTab }))
    // A Manager navigation row is the page's first-level parent. Its icon and
    // label form the Host header, so route history never adds a duplicate Back
    // control or a "Plugins / …" breadcrumb above plugin-owned body content.
    dependencies.setDirectManagerNavigationHeading(item.title, item.icon)
    if (
      dependencies.contentState.managerContentRoot === undefined
      || !dependencies.contentState.managerContentRoot.isConnected
    ) {
      dependencies.contentState.managerContentRoot = create(dependencies.document, 'div', 'cxm-manager-content-root')
      dependencies.contentState.managerContentRoot.dataset.managerContentRoot = 'true'
      dependencies.content.append(dependencies.contentState.managerContentRoot)
    }
    const focusedTabId = dependencies.document.activeElement instanceof dependencies.document.defaultView!.HTMLElement
      ? dependencies.document.activeElement.dataset.managerContentTab
      : undefined
    dependencies.content.querySelector<HTMLElement>('[data-manager-content-tabs]')?.remove()
    if (tabs.length > 0 && activeTab !== undefined) {
      const tablist = create(dependencies.document, 'div', 'cxm-tabs')
      tablist.dataset.managerContentTabs = 'true'
      tablist.setAttribute('role', 'tablist')
      tablist.setAttribute('aria-label', projection.title)
      tablist.setAttribute('aria-orientation', 'horizontal')
      const panelId = managerContentPanelId(id)
      dependencies.contentState.managerContentRoot.id = panelId
      dependencies.contentState.managerContentRoot.setAttribute('role', 'tabpanel')
      dependencies.contentState.managerContentRoot.tabIndex = 0
      for (const tab of tabs) {
        const button = create(dependencies.document, 'button', 'cxm-tab')
        button.type = 'button'
        button.id = managerContentTabId(id, tab.id)
        button.dataset.managerContentTab = tab.id
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-controls', panelId)
        button.setAttribute('aria-selected', String(tab.active))
        button.tabIndex = tab.active ? 0 : -1
        const visibleContent = create(dependencies.document, 'span', 'cxm-tab-content')
        const icon = createHostSurfaceIcon(dependencies.document, tab.icon)
        icon.classList.add('cxm-tab-icon')
        visibleContent.append(icon, create(dependencies.document, 'span', undefined, tab.label))
        button.append(visibleContent)
        const activate = (): void => {
          void activateManagerContent(id, tab.route, { kind: 'tab', id: tab.id }, false)
        }
        button.addEventListener('click', activate)
        button.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
            return
          }
          const current = tabs.findIndex(candidate => candidate.id === tab.id)
          let next: (typeof tabs)[number] | undefined
          if (event.key === 'ArrowRight') next = tabs[(current + 1) % tabs.length]
          if (event.key === 'ArrowLeft') next = tabs[(current - 1 + tabs.length) % tabs.length]
          if (event.key === 'Home') next = tabs[0]
          if (event.key === 'End') next = tabs.at(-1)
          if (next === undefined) return
          event.preventDefault()
          void activateManagerContent(id, next.route, { kind: 'tab', id: next.id }, false)
        })
        tablist.append(button)
      }
      dependencies.contentState.managerContentRoot.setAttribute(
        'aria-labelledby',
        managerContentTabId(id, activeTab.id),
      )
      dependencies.content.insertBefore(tablist, dependencies.contentState.managerContentRoot)
      if (focusedTabId !== undefined) focusManagerContentTab(focusedTabId)
    } else {
      dependencies.contentState.managerContentRoot.removeAttribute('role')
      dependencies.contentState.managerContentRoot.removeAttribute('aria-labelledby')
      dependencies.contentState.managerContentRoot.removeAttribute('tabindex')
      dependencies.contentState.managerContentRoot.removeAttribute('id')
    }
    const mountKey = managerContentKey(id, reference)
    dependencies.contentState.managerContentRoot.dataset.managerContentId = id
    dependencies.contentState.managerContentRoot.dataset.managerContentRoute = reference.id
    if (dependencies.contentState.managerContentMountId !== mountKey) {
      dependencies.contentState.managerContentRoot.replaceChildren(
        create(
          dependencies.document,
          'div',
          'cxm-notice',
          dependencies.contentState.managerContentTransitioning ? '正在切换插件页面…' : '插件页面尚未加载。',
        ),
      )
      if (
        !dependencies.contentState.managerContentTransitioning
        && dependencies.contentState.managerContentError === undefined
      ) {
        queueMicrotask(() => {
          if (
            dependencies.routeState.kind !== 'manager-content' || dependencies.routeState.id !== id
            || managerContentKey(id, dependencies.routeState.reference) !== mountKey
            || dependencies.contentState.managerContentMountId === mountKey
            || dependencies.contentState.managerContentTransitioning
          ) return
          void activateManagerContent(id, reference, undefined, false)
        })
      }
    }
    if (dependencies.contentState.managerContentError !== undefined) {
      dependencies.contentState.managerContentRoot.append(
        create(dependencies.document, 'div', 'cxm-error', '无法打开插件页面。'),
      )
    }
  }
  return { resetManagerContent, managerContentFocusRestore, activateManagerContent, renderManagerContent }
}
