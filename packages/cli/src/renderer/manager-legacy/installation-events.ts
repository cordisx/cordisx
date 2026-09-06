import { type HostCollectionView } from '.././host-collection.js'
import { resolveManagerTriggerTarget } from '.././host-probes.js'
import { HostThemeProjection } from '.././host-theme.js'
import { type MarketplaceModel } from '.././marketplace.js'
import { HostTooltipController } from '.././tooltips.js'
import { MarketplaceFetcherHandle, PublisherGrantClient } from './bridges.js'
import { ManagerInstallOptions } from './install-options.js'
import type {
  ManagerConsoleState,
  ManagerContentState,
  ManagerMenuState,
  ManagerSettingsState,
} from './interaction-state.js'
import { ManagerModel, ManagerRouteState, ManagerTab } from './model.js'
export interface ManagerInstallationEventsDependencies {
  modal: HTMLDivElement
  trigger: HTMLButtonElement
  syncHostUiTheme: () => void
  renderContent: () => void
  close: HTMLButtonElement
  disposeHostCollections: () => void
  disposeConfigRenderers: () => void
  disposeConfigFieldActionMenus: () => void
  disposeLunaConsoles: () => void
  marketplaceCollectionView: HostCollectionView | undefined
  resetSettings: () => Promise<void>
  resetManagerContent: () => Promise<void>
  content: HTMLDivElement
  document: Document
  hideForExternalNavigation: () => void
  backdrop: HTMLDivElement
  navButtons: Map<string, HTMLButtonElement>
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  nav: HTMLElement
  options: ManagerInstallOptions
  model: ManagerModel
  routeState: ManagerRouteState
  marketplace: MarketplaceModel
  breadcrumbCleanup: () => void
  stopSettingsContent: () => Promise<void>
  tooltips: HostTooltipController
  marketplaceFetcher: MarketplaceFetcherHandle
  publisherGrantClient: PublisherGrantClient
  ownedPortals: Map<HTMLElement, () => void>
  detachModalTheme: () => void
  style: HTMLStyleElement
  theme: HostThemeProjection
  settingsState: Pick<ManagerSettingsState, 'settingsMount' | 'settingsMountId'>
  contentState: Pick<ManagerContentState, 'managerContentMount' | 'managerContentMountId'>
  menuState: Pick<
    ManagerMenuState,
    'pluginActionMenuOpen' | 'closePluginActionMenu' | 'pluginActionMenuContainsEvent' | 'repositionPluginActionMenu'
  >
  consoleState: Pick<ManagerConsoleState, 'consolePaused'>
}
/** Bind event subscriptions and release the installation in the original disposal order. */
export function installManagerEvents(dependencies: ManagerInstallationEventsDependencies): () => void {
  const open = (): void => {
    dependencies.modal.hidden = false
    dependencies.trigger.setAttribute('aria-expanded', 'true')
    dependencies.syncHostUiTheme()
    dependencies.renderContent()
    dependencies.close.focus()
  }
  const dismiss = (): void => {
    dependencies.disposeHostCollections()
    dependencies.disposeConfigRenderers()
    dependencies.disposeConfigFieldActionMenus()
    dependencies.disposeLunaConsoles()
    dependencies.marketplaceCollectionView?.dispose()
    dependencies.marketplaceCollectionView = undefined
    dependencies.settingsState.settingsMount?.abort()
    if (
      dependencies.settingsState.settingsMount !== undefined || dependencies.settingsState.settingsMountId !== undefined
    ) {
      void dependencies.resetSettings().catch(() => {})
    }
    if (
      dependencies.contentState.managerContentMount !== undefined
      || dependencies.contentState.managerContentMountId !== undefined
    ) {
      void dependencies.resetManagerContent().catch(() => {})
    }
    dependencies.modal.hidden = true
    dependencies.trigger.setAttribute('aria-expanded', 'false')
    dependencies.trigger.focus()
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.key !== 'Escape' || dependencies.modal.hidden) return
    if (dependencies.menuState.pluginActionMenuOpen) {
      event.preventDefault()
      dependencies.menuState.closePluginActionMenu(true)
      return
    }
    dismiss()
  }
  dependencies.trigger.addEventListener('click', open)
  dependencies.close.addEventListener('click', dismiss)
  dependencies.content.addEventListener('click', (event) => {
    const target = event.target instanceof dependencies.document.defaultView!.Element ? event.target : undefined
    if (target?.closest('a[href]') !== null && target !== undefined) dependencies.hideForExternalNavigation()
  })
  const closeMenuOutside = (event: Event): void => {
    if (!dependencies.menuState.pluginActionMenuOpen || dependencies.menuState.pluginActionMenuContainsEvent(event)) {
      return
    }
    dependencies.menuState.closePluginActionMenu(true)
  }
  const repositionMenu = (): void => dependencies.menuState.repositionPluginActionMenu()
  dependencies.document.addEventListener('pointerdown', closeMenuOutside, true)
  dependencies.document.addEventListener('click', closeMenuOutside, true)
  dependencies.document.defaultView?.addEventListener('resize', repositionMenu)
  dependencies.document.defaultView?.addEventListener('scroll', repositionMenu, true)
  dependencies.backdrop.addEventListener('click', (event) => {
    if (event.target === dependencies.backdrop) dismiss()
  })
  dependencies.document.addEventListener('keydown', onKeydown)
  for (const [id, button] of dependencies.navButtons) {
    button.addEventListener('click', () => {
      void dependencies.navigateRoute({ kind: 'primary', primary: id as ManagerTab })
    })
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void dependencies.navigateRoute({ kind: 'primary', primary: id as ManagerTab }, { restoreFocus: true })
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
  }

  let currentTarget: HTMLElement | undefined
  let scheduled = false
  const reconcile = (): void => {
    scheduled = false
    dependencies.syncHostUiTheme()
    const target = dependencies.options.triggerTarget?.() ?? resolveManagerTriggerTarget(dependencies.document)
    if (target === undefined) {
      dependencies.trigger.remove()
      currentTarget = undefined
      return
    }
    if (
      target === currentTarget && dependencies.trigger.isConnected
      && dependencies.trigger.previousElementSibling === target
    ) return
    target.after(dependencies.trigger)
    currentTarget = target
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const Observer = dependencies.document.defaultView?.MutationObserver
  const observer = Observer === undefined ? undefined : new Observer(() => {
    schedule()
  })
  const themeObserver = Observer === undefined ? undefined : new Observer(dependencies.syncHostUiTheme)
  if (dependencies.document.documentElement !== null) {
    observer?.observe(dependencies.document.documentElement, { childList: true, subtree: true })
  }
  if (dependencies.document.documentElement !== null) {
    themeObserver?.observe(dependencies.document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
    })
  }
  reconcile()
  dependencies.renderContent()
  const unsubscribeRuntime = dependencies.model.subscribe(dependencies.renderContent)
  const unsubscribePluginConsole = dependencies.model.subscribePluginConsole?.(pluginId => {
    if (
      !dependencies.consoleState.consolePaused && dependencies.routeState.kind === 'plugin'
      && dependencies.routeState.pluginId === pluginId
      && (dependencies.routeState.facet === 'runtime' || dependencies.routeState.facet === 'logs')
    ) dependencies.renderContent()
  }) ?? (() => {})
  const unsubscribeMarketplace = dependencies.marketplace.subscribe(dependencies.renderContent)
  void dependencies.marketplace.reload()

  return () => {
    dependencies.breadcrumbCleanup()
    dependencies.disposeHostCollections()
    dependencies.disposeConfigRenderers()
    dependencies.disposeConfigFieldActionMenus()
    dependencies.disposeLunaConsoles()
    dependencies.marketplaceCollectionView?.dispose()
    dependencies.marketplaceCollectionView = undefined
    dependencies.settingsState.settingsMount?.abort()
    void dependencies.stopSettingsContent().catch(() => {})
    observer?.disconnect()
    themeObserver?.disconnect()
    unsubscribeRuntime()
    unsubscribePluginConsole()
    unsubscribeMarketplace()
    dependencies.marketplace.dispose()
    dependencies.tooltips.dispose()
    dependencies.marketplaceFetcher.dispose()
    dependencies.publisherGrantClient.dispose()
    dependencies.document.removeEventListener('keydown', onKeydown)
    dependencies.document.removeEventListener('pointerdown', closeMenuOutside, true)
    dependencies.document.removeEventListener('click', closeMenuOutside, true)
    dependencies.document.defaultView?.removeEventListener('resize', repositionMenu)
    dependencies.document.defaultView?.removeEventListener('scroll', repositionMenu, true)
    dependencies.menuState.closePluginActionMenu(false)
    dependencies.trigger.removeEventListener('click', open)
    dependencies.trigger.remove()
    for (const [portal, detachTheme] of dependencies.ownedPortals) {
      detachTheme()
      portal.remove()
    }
    dependencies.ownedPortals.clear()
    dependencies.detachModalTheme()
    dependencies.modal.remove()
    dependencies.style.remove()
    dependencies.theme.dispose()
  }
}
