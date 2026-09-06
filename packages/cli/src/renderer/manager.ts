import lunaConsoleCss from 'luna-console/luna-console.css'
import lunaDataGridCss from 'luna-data-grid/luna-data-grid.css'
import lunaDomViewerCss from 'luna-dom-viewer/luna-dom-viewer.css'
import lunaObjectViewerCss from 'luna-object-viewer/luna-object-viewer.css'
import type { ConfigMutationOperation, ConfigRendererMountHandle } from './configuration.js'
import { HOST_COLLECTION_STYLES, type HostCollectionView } from './host-collection.js'
import { HostFormAdapter } from './host-form.js'
import { HostThemeProjection, resolveHostTheme } from './host-theme.js'
import {
  createManagerIcon,
  hostSurfaceIconKey,
  type ManagerIconToken,
  renderHostIconSvg,
  renderManagerIconSvg,
} from './icons.js'
import { createAbout } from './manager-legacy/about.js'
import { createMarketplaceFetcher, createPublisherGrantClient } from './manager-legacy/bridges.js'
import { createChrome } from './manager-legacy/chrome.js'
import { createCollections } from './manager-legacy/collections.js'
import { createConfiguration } from './manager-legacy/configuration.js'
import { createConsole } from './manager-legacy/console.js'
import { createContentMount } from './manager-legacy/content-mount.js'
import { create, createAdaptiveBrandMark, syncAdaptiveBrandMarks } from './manager-legacy/dom.js'
import { createExtensionPoints } from './manager-legacy/extension-points.js'
import { createHeading } from './manager-legacy/heading.js'
import { ManagerInstallOptions } from './manager-legacy/install-options.js'
import { installManagerEvents } from './manager-legacy/installation-events.js'
import {
  createManagerConsoleState,
  createManagerContentState,
  createManagerMenuState,
  createManagerSettingsState,
  createManagerSourceState,
} from './manager-legacy/interaction-state.js'
import { createMarketplaceDetail } from './manager-legacy/marketplace-detail.js'
import { createMarketplaceList } from './manager-legacy/marketplace-list.js'
import { createMarketplaceSources } from './manager-legacy/marketplace-sources.js'
import { ManagerModel, ManagerPluginStatus, ManagerRouteState, ManagerTab } from './manager-legacy/model.js'
import { createNavigation } from './manager-legacy/navigation.js'
import { createPermissions } from './manager-legacy/permissions.js'
import { createPluginDetail } from './manager-legacy/plugin-detail.js'
import { createPluginList } from './manager-legacy/plugin-list.js'
import { createPluginOperations } from './manager-legacy/plugin-operations.js'
import { MANAGER_STYLE_ID } from './manager-legacy/presentation.js'
import { createRouteProjection } from './manager-legacy/route-projection.js'
import { createRoutes } from './manager-legacy/routes.js'
import { createSettings } from './manager-legacy/settings.js'
import { HOST_THEME_OVERLAY_STYLES, MANAGER_STYLES } from './manager-legacy/styles.js'
import { safeStorage } from './manager-legacy/widgets.js'
import { BrowserMarketplaceModel, type MarketplaceModel } from './marketplace.js'
import { HostTooltipController } from './tooltips.js'
import { managerCopy } from './ui-copy.js'
export {
  requestPluginAuthorization,
  requestPluginAuthorizationV2,
  requestPluginAuthorizationV4,
} from './manager-legacy/authorization.js'
export { projectManagerBreadcrumbs } from './manager-legacy/breadcrumbs.js'
export {
  projectPluginConsoleEntryForLuna,
  projectPluginConsoleValueForLuna,
  serializePluginConsoleExport,
} from './manager-legacy/console-projection.js'
export type { PluginConsoleLunaEntryProjection } from './manager-legacy/console-projection.js'
export type { ManagerInstallOptions } from './manager-legacy/install-options.js'
export type {
  ManagerCapabilityAvailabilitySnapshot,
  ManagerCapabilityProviderSnapshot,
  ManagerModel,
  ManagerPermissionSnapshot,
  ManagerPluginSnapshot,
  ManagerPluginStatus,
  ManagerSettingsNavigationItemSnapshot,
  ManagerSettingsTabSnapshot,
  ManagerSnapshot,
} from './manager-legacy/model.js'
export { CORDISX_BUILTIN_MANAGER_SETTINGS_TABS } from './manager-legacy/presentation.js'

export function installCordisXManager(
  document: Document,
  model: ManagerModel,
  options: ManagerInstallOptions = {},
): () => void {
  const theme = new HostThemeProjection(document)
  let renderedLocale = model.snapshot().localization.locale
  const copy = (key: Parameters<typeof managerCopy>[1]): string => managerCopy(renderedLocale, key)
  const ownedPortals = new Map<HTMLElement, () => void>()
  const mountPortal = <Element extends HTMLElement>(portal: Element): () => void => {
    const detachTheme = theme.attach(portal)
    ownedPortals.set(portal, detachTheme)
    ;(document.body ?? document.documentElement).append(portal)
    return () => {
      ownedPortals.delete(portal)
      detachTheme()
      portal.remove()
    }
  }
  document.getElementById(MANAGER_STYLE_ID)?.remove()
  const style = create(document, 'style')
  style.id = MANAGER_STYLE_ID
  style.textContent =
    `${lunaObjectViewerCss}\n${lunaDataGridCss}\n${lunaDomViewerCss}\n${lunaConsoleCss}\n${HOST_COLLECTION_STYLES}\n${MANAGER_STYLES}\n${HOST_THEME_OVERLAY_STYLES}`
  ;(document.head ?? document.documentElement).append(style)

  const trigger = create(document, 'button')
  trigger.type = 'button'
  trigger.dataset.cordisxManagerTrigger = 'true'
  trigger.setAttribute('aria-label', copy('manager.trigger.manage'))
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.title = copy('manager.trigger.manage')
  const triggerMark = createAdaptiveBrandMark(document)
  trigger.append(triggerMark)

  const modal = create(document, 'div', 'cxf-scope')
  const detachModalTheme = theme.attach(modal)
  modal.dataset.cordisxManagerModal = 'true'
  modal.hidden = true
  const backdrop = create(document, 'div', 'cxm-backdrop')
  const dialog = create(document, 'section', 'cxm-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', copy('manager.dialog'))

  const sidebar = create(document, 'aside', 'cxm-sidebar')
  const nav = create(document, 'nav', 'cxm-nav')
  nav.setAttribute('aria-label', copy('manager.navigation'))
  const tabs: readonly { id: ManagerTab; icon?: ManagerIconToken; label: string; brand?: boolean }[] = [
    { id: 'plugins', icon: 'plugins', label: copy('manager.nav.plugins') },
    { id: 'extension-points', icon: 'contributions', label: copy('manager.nav.extension-points') },
    { id: 'routes', icon: 'routes', label: copy('manager.nav.routes') },
    { id: 'marketplace', icon: 'marketplace', label: copy('manager.nav.marketplace') },
    { id: 'about', label: copy('manager.nav.about'), brand: true },
  ]
  let routeState: ManagerRouteState = { kind: 'primary', primary: 'plugins' }
  const navigationHistory: ManagerRouteState[] = []
  const navButtons = new Map<string, HTMLButtonElement>()
  for (const tab of tabs) {
    const button = create(document, 'button', 'cxm-nav-button')
    button.type = 'button'
    button.dataset.tab = tab.id
    button.dataset.managerNavigationId = tab.id
    const icon = tab.brand === true
      ? createAdaptiveBrandMark(document)
      : createManagerIcon(document, tab.icon ?? 'plugins', 'cxm-nav-icon')
    icon.classList.add('cxm-nav-icon')
    icon.setAttribute('aria-hidden', 'true')
    button.append(icon, create(document, 'span', 'cxm-nav-label', tab.label))
    navButtons.set(tab.id, button)
    nav.append(button)
  }
  sidebar.append(nav)

  const main = create(document, 'div', 'cxm-main')
  const header = create(document, 'header', 'cxm-header')
  const heading = create(document, 'div', 'cxm-heading')
  const close = create(document, 'button', 'cxm-close')
  close.type = 'button'
  close.setAttribute('aria-label', copy('manager.close'))
  close.append(createManagerIcon(document, 'close', 'cxm-close-icon'))
  header.append(heading, close)
  const content = create(document, 'div', 'cxm-content')
  main.append(header, content)
  dialog.append(sidebar, main)
  backdrop.append(dialog)
  modal.append(backdrop)
  ;(document.body ?? document.documentElement).append(modal)
  const { syncPrimaryChrome, localizeTabs } = createChrome({
    copy,
    trigger,
    dialog,
    nav,
    close,
    navButtons,
  })

  const marketplaceFetcher = createMarketplaceFetcher(document.defaultView)
  const publisherGrantClient = createPublisherGrantClient(document.defaultView)
  const publisherGrantStatuses = new Map<string, string>()
  const marketplace: MarketplaceModel = new BrowserMarketplaceModel(
    safeStorage(document.defaultView),
    marketplaceFetcher.fetcher,
  )
  const tooltips = new HostTooltipController(document)
  const forms = new HostFormAdapter(document, modal, () => model.snapshot().localization.locale)
  const { disposeHostCollections, mountHostCollection, managerIconAction } = createCollections({
    document,
    tooltips,
    theme,
  })

  let pluginQuery = ''
  let marketplaceQuery = ''
  let marketplaceCertifiedOnly = false
  let marketplaceOfficialOnly = false
  let extensionPointQuery = ''
  let routeQuery = ''
  const extensionPointUsageQueries = new Map<string, string>()
  const pluginExtensionPointQueries = new Map<string, string>()
  const pluginRouteQueries = new Map<string, string>()
  const favoritePluginIds = (() => {
    try {
      const stored = JSON.parse(
        safeStorage(document.defaultView)?.getItem('cordisx.manager.favoritePlugins.v1') ?? '[]',
      )
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
    } catch {
      return new Set<string>()
    }
  })()
  const consoleState = createManagerConsoleState()
  const consoleScrollStates = new Map<string, { follow: boolean; scrollTop: number }>()
  const dismissedConsoleWarnings = new Map<string, number>()
  const settingsState = createManagerSettingsState()
  const contentState = createManagerContentState()
  const listScrollPositions = new Map<string, number>()
  let busyPluginId: string | undefined
  let operationError: string | undefined
  const configDrafts = new Map<string, {
    baseRevision: number
    readonly values: Map<string, unknown>
    readonly operations: Map<string, ConfigMutationOperation>
    readonly issues: Map<string, string>
    state: 'pristine' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'
    message?: string
  }>()
  const sourceState = createManagerSourceState()
  let marketplaceCollectionView: HostCollectionView | undefined
  const lifecycleBusy = new Map<string, ManagerPluginStatus>()
  let lifecycleInstallBusy = false
  const configRendererMounts = new Set<ConfigRendererMountHandle>()
  const configFieldActionMenus = new Set<{ dispose(): void }>()
  const lunaConsoleMounts = new Set<{
    readonly destroy: () => void
    readonly setTheme: (theme: 'dark' | 'light') => void
  }>()
  let breadcrumbCleanup = (): void => {}
  const menuState = createManagerMenuState()

  const disposeConfigRenderers = (): void => {
    for (const mount of configRendererMounts) void mount.dispose()
    configRendererMounts.clear()
  }

  const disposeConfigFieldActionMenus = (): void => {
    for (const menu of configFieldActionMenus) menu.dispose()
    configFieldActionMenus.clear()
  }

  const disposeLunaConsoles = (): void => {
    for (const mount of lunaConsoleMounts) mount.destroy()
    lunaConsoleMounts.clear()
  }

  const syncHostUiTheme = (): void => {
    const current = resolveHostTheme(document).theme
    syncAdaptiveBrandMarks(document)
    for (const mount of lunaConsoleMounts) mount.setTheme(current)
  }
  const {
    authorizeAndRestore,
    hideForExternalNavigation,
    configureExternalLink,
    favoritePlugins,
    setFavorite,
    runLocalPackageInstall,
    runPluginLifecycle,
    sharePlugin,
    packageOperationUnavailableReason,
    sourceUnavailableReason,
    openPluginSource,
  } = createPluginOperations({
    model,
    document,
    disposeHostCollections,
    resetManagerContent: (...args) => resetManagerContent(...args),
    modal,
    trigger,
    forms,
    mountPortal,
    managerIconAction,
    get lifecycleInstallBusy() {
      return lifecycleInstallBusy
    },
    set lifecycleInstallBusy(value) {
      lifecycleInstallBusy = value
    },
    get operationError() {
      return operationError
    },
    set operationError(value) {
      operationError = value
    },
    renderContent,
    lifecycleBusy,
    contentState,
    menuState,
  })

  const { activePrimary, currentSettingsTab, settingsNavigationItems, resolvePageRoute, normalizeRoute, routeKey } =
    createRouteProjection({
      get routeState() {
        return routeState
      },
      set routeState(value) {
        routeState = value
      },
      localizeTabs,
      copy,
      marketplace,
      model,
    })

  const { rememberListScroll, restoreListScroll, createListSearch, setHeading, setDirectManagerNavigationHeading } =
    createHeading({
      get breadcrumbCleanup() {
        return breadcrumbCleanup
      },
      set breadcrumbCleanup(value) {
        breadcrumbCleanup = value
      },
      document,
      navigateRoute: (...args) => navigateRoute(...args),
      listScrollPositions,
      activePrimary,
      content,
      renderContent,
      heading,
      resolvePageRoute,
      copy,
      navigateBack: (...args) => navigateBack(...args),
    })

  const { renderAbout } = createAbout({
    setHeading,
    document,
    configureExternalLink,
    content,
  })

  const { extensionPointRowStatus, renderExtensionPointList, renderExtensionPointDetail } = createExtensionPoints({
    document,
    setHeading,
    rememberListScroll,
    get operationError() {
      return operationError
    },
    set operationError(value) {
      operationError = value
    },
    navigateRoute: (...args) => navigateRoute(...args),
    mountHostCollection,
    content,
    copy,
    get extensionPointQuery() {
      return extensionPointQuery
    },
    set extensionPointQuery(value) {
      extensionPointQuery = value
    },
    get routeState() {
      return routeState
    },
    set routeState(value) {
      routeState = value
    },
    localizeTabs,
    extensionPointUsageQueries,
    createListSearch,
    forms,
    model,
    renderContent,
  })

  const {
    qualifiedNavigationId,
    routeCollectionItem,
    pageCollectionItem,
    renderRouteList,
    renderRouteDetail,
    renderPageDetail,
  } = createRoutes({
    document,
    copy,
    setHeading,
    rememberListScroll,
    navigateRoute: (...args) => navigateRoute(...args),
    mountHostCollection,
    content,
    get routeQuery() {
      return routeQuery
    },
    set routeQuery(value) {
      routeQuery = value
    },
  })

  const { renderPluginList } = createPluginList({
    setHeading,
    copy,
    content,
    managerIconAction,
    get lifecycleInstallBusy() {
      return lifecycleInstallBusy
    },
    set lifecycleInstallBusy(value) {
      lifecycleInstallBusy = value
    },
    lifecycleBusy,
    model,
    runLocalPackageInstall,
    favoritePlugins,
    packageOperationUnavailableReason,
    sourceUnavailableReason,
    document,
    runPluginLifecycle,
    setFavorite,
    renderContent,
    sharePlugin,
    get operationError() {
      return operationError
    },
    set operationError(value) {
      operationError = value
    },
    openPluginSource,
    rememberListScroll,
    navigateRoute: (...args) => navigateRoute(...args),
    mountHostCollection,
    get pluginQuery() {
      return pluginQuery
    },
    set pluginQuery(value) {
      pluginQuery = value
    },
    favoritePluginIds,
    menuState,
  })

  const { commitPermissionPolicy, renderPermissionDetail } = createPermissions({
    get operationError() {
      return operationError
    },
    set operationError(value) {
      operationError = value
    },
    model,
    renderContent,
    setHeading,
    content,
    document,
    forms,
  })

  const { renderPluginConfiguration } = createConfiguration({
    model,
    document,
    forms,
    configDrafts,
    get busyPluginId() {
      return busyPluginId
    },
    set busyPluginId(value) {
      busyPluginId = value
    },
    configRendererMounts,
    renderContent,
    configFieldActionMenus,
  })

  const { mountLunaConsole, copyConsoleText, exportPluginConsole } = createConsole({
    consoleScrollStates,
    document,
    renderContent,
    lunaConsoleMounts,
    consoleState,
  })

  const { renderPluginDetail } = createPluginDetail({
    setHeading,
    copy,
    content,
    document,
    get routeState() {
      return routeState
    },
    set routeState(value) {
      routeState = value
    },
    localizeTabs,
    navigateRoute: (...args) => navigateRoute(...args),
    renderPluginConfiguration,
    get operationError() {
      return operationError
    },
    set operationError(value) {
      operationError = value
    },
    forms,
    commitPermissionPolicy,
    model,
    dismissedConsoleWarnings,
    managerIconAction,
    renderContent,
    get busyPluginId() {
      return busyPluginId
    },
    set busyPluginId(value) {
      busyPluginId = value
    },
    authorizeAndRestore,
    consoleScrollStates,
    tooltips,
    copyConsoleText,
    exportPluginConsole,
    mountLunaConsole,
    pluginExtensionPointQueries,
    extensionPointRowStatus,
    mountHostCollection,
    pluginRouteQueries,
    qualifiedNavigationId,
    routeCollectionItem,
    pageCollectionItem,
    consoleState,
  })

  const { refreshPublisherGrantStatus, renderMarketplaceList } = createMarketplaceList({
    document,
    tooltips,
    mountPortal,
    copy,
    navigateRoute: (...args) => navigateRoute(...args),
    importMarketplaceSourceFromClipboard: (...args) => importMarketplaceSourceFromClipboard(...args),
    publisherGrantStatuses,
    publisherGrantClient,
    renderContent,
    marketplace,
    setHeading,
    content,
    managerIconAction,
    get marketplaceCertifiedOnly() {
      return marketplaceCertifiedOnly
    },
    set marketplaceCertifiedOnly(value) {
      marketplaceCertifiedOnly = value
    },
    get marketplaceOfficialOnly() {
      return marketplaceOfficialOnly
    },
    set marketplaceOfficialOnly(value) {
      marketplaceOfficialOnly = value
    },
    get marketplaceQuery() {
      return marketplaceQuery
    },
    set marketplaceQuery(value) {
      marketplaceQuery = value
    },
    model,
    rememberListScroll,
    mountHostCollection,
    menuState,
  })

  const { renderMarketplaceDetail } = createMarketplaceDetail({
    marketplace,
    setHeading,
    copy,
    content,
    document,
    get routeState() {
      return routeState
    },
    set routeState(value) {
      routeState = value
    },
    localizeTabs,
    navigateRoute: (...args) => navigateRoute(...args),
    configureExternalLink,
    refreshPublisherGrantStatus,
    publisherGrantStatuses,
    publisherGrantClient,
    renderContent,
  })

  const { importMarketplaceSourceFromClipboard, renderMarketplaceSourcePage } = createMarketplaceSources({
    marketplace,
    renderContent,
    copy,
    forms,
    document,
    navigateRoute: (...args) => navigateRoute(...args),
    setHeading,
    managerIconAction,
    get marketplaceCollectionView() {
      return marketplaceCollectionView
    },
    set marketplaceCollectionView(value) {
      marketplaceCollectionView = value
    },
    tooltips,
    theme,
    content,
    sourceState,
  })

  const { stopSettingsContent, resetSettings, activateSettingsTab, disposeSettingsForRouteChange } = createSettings({
    model,
    activePrimary,
    get routeState() {
      return routeState
    },
    set routeState(value) {
      routeState = value
    },
    document,
    routeKey,
    navigationHistory,
    renderContent,
    currentSettingsTab,
    setHeading,
    content,
    settingsState,
  })

  const { resetManagerContent, managerContentFocusRestore, activateManagerContent, renderManagerContent } =
    createContentMount({
      model,
      navButtons,
      content,
      settingsNavigationItems,
      get routeState() {
        return routeState
      },
      set routeState(value) {
        routeState = value
      },
      routeKey,
      navigationHistory,
      renderContent,
      document,
      navigateBack: (...args) => navigateBack(...args),
      setDirectManagerNavigationHeading,
      contentState,
    })

  const { syncSettingsNavigation, navigateRoute, navigateBack } = createNavigation({
    document,
    navButtons,
    nav,
    settingsNavigationItems,
    activateManagerContent,
    normalizeRoute,
    model,
    routeKey,
    get routeState() {
      return routeState
    },
    set routeState(value) {
      routeState = value
    },
    activateSettingsTab,
    managerContentFocusRestore,
    navigationHistory,
    activePrimary,
    disposeSettingsForRouteChange,
    resetManagerContent,
    renderContent,
    restoreListScroll,
    resolvePageRoute,
  })

  function renderContent(): void {
    tooltips.hide()
    disposeConfigFieldActionMenus()
    disposeLunaConsoles()
    marketplaceCollectionView?.dispose()
    marketplaceCollectionView = undefined
    delete content.dataset.marketplaceDiscovery
    delete content.dataset.managerListPage
    delete content.dataset.managerContentPage
    const snapshot = model.snapshot()
    renderedLocale = snapshot.localization.locale
    syncPrimaryChrome(renderedLocale)
    const normalized = normalizeRoute(snapshot)
    const normalizedRouteChanged = routeKey(normalized) !== routeKey(routeState)
    const removedActiveManagerContent = routeState.kind === 'manager-content'
      && normalized.kind === 'primary' && normalized.primary === 'plugins'
    if (normalizedRouteChanged) {
      routeState = normalized
      if (removedActiveManagerContent) void resetManagerContent().then(renderContent).catch(() => {})
    }
    const primary = activePrimary()
    syncSettingsNavigation(snapshot)
    const preserveManagerContent = routeState.kind === 'manager-content'
      && contentState.managerContentRoot?.isConnected === true
    if (!preserveManagerContent) {
      disposeHostCollections()
      disposeConfigRenderers()
      content.replaceChildren()
      delete content.dataset.scrollMode
    }
    for (const [id, button] of navButtons) {
      const selected = id === primary
      if (selected) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
      button.removeAttribute('aria-selected')
      button.tabIndex = selected ? 0 : -1
      const icon = button.querySelector<HTMLElement>(':scope > .cordisx-host-icon')
      const surfaceToken = icon?.dataset.hostIcon
      const managerToken = icon?.dataset.hostIconKey as ManagerIconToken | undefined
      if (icon !== null && icon !== undefined && managerToken !== undefined && surfaceToken === undefined) {
        icon.replaceChildren(
          renderManagerIconSvg(document, managerToken, {
            state: selected ? 'active' : 'default',
            theme: resolveHostTheme(document).theme,
          }).svg,
        )
      } else if (surfaceToken !== undefined) {
        const key = hostSurfaceIconKey(surfaceToken)
        if (icon !== null && icon !== undefined && key !== undefined) {
          icon.replaceChildren(
            renderHostIconSvg(document, key, {
              state: selected ? 'active' : 'default',
              theme: resolveHostTheme(document).theme,
            }).svg,
          )
        }
      }
    }
    if (removedActiveManagerContent) queueMicrotask(() => navButtons.get('plugins')?.focus())
    if (routeState.kind === 'permission') {
      return renderPermissionDetail(snapshot, routeState.pluginId, routeState.capability, routeState.fingerprint)
    }
    if (routeState.kind === 'plugin') return renderPluginDetail(snapshot, routeState.pluginId)
    if (routeState.kind === 'marketplace') return renderMarketplaceDetail(snapshot, routeState.identity)
    if (routeState.kind === 'marketplace-source') return renderMarketplaceSourcePage(snapshot, routeState)
    if (routeState.kind === 'extension-point') return renderExtensionPointDetail(snapshot, routeState.pointId)
    if (routeState.kind === 'route') return renderRouteDetail(snapshot, routeState.qualifiedId)
    if (routeState.kind === 'page') return renderPageDetail(snapshot, routeState.qualifiedId)
    if (routeState.kind === 'manager-content') {
      content.dataset.managerContentPage = 'true'
      return renderManagerContent(snapshot, routeState.id, routeState.reference)
    }
    if (routeState.kind !== 'primary') return renderPluginList(snapshot)
    if (routeState.primary === 'about') renderAbout(snapshot)
    if (routeState.primary === 'extension-points') renderExtensionPointList(snapshot)
    if (routeState.primary === 'routes') renderRouteList(snapshot)
    if (routeState.primary === 'plugins') renderPluginList(snapshot)
    if (routeState.primary === 'marketplace') renderMarketplaceList(snapshot)
    if (normalizedRouteChanged) restoreListScroll()
  }
  return installManagerEvents({
    modal,
    trigger,
    syncHostUiTheme,
    renderContent,
    close,
    disposeHostCollections,
    disposeConfigRenderers,
    disposeConfigFieldActionMenus,
    disposeLunaConsoles,
    get marketplaceCollectionView() {
      return marketplaceCollectionView
    },
    set marketplaceCollectionView(value) {
      marketplaceCollectionView = value
    },
    resetSettings,
    resetManagerContent,
    content,
    document,
    hideForExternalNavigation,
    backdrop,
    navButtons,
    navigateRoute,
    nav,
    options,
    model,
    get routeState() {
      return routeState
    },
    set routeState(value) {
      routeState = value
    },
    marketplace,
    get breadcrumbCleanup() {
      return breadcrumbCleanup
    },
    set breadcrumbCleanup(value) {
      breadcrumbCleanup = value
    },
    stopSettingsContent,
    tooltips,
    marketplaceFetcher,
    publisherGrantClient,
    ownedPortals,
    detachModalTheme,
    style,
    theme,
    settingsState,
    contentState,
    menuState,
    consoleState,
  })
}
