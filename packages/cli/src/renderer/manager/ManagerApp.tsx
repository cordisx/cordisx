import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { flushSync } from 'react-dom'
import { Button, ConfigProvider } from 'tdesign-react'
import { projectPermissionCapabilityName } from '../../permission-locales.js'
import type { MarketplaceModel } from '../marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../manager.js'
import { HostIcon } from '../host-ui/HostIcon.js'
import { BrandMark } from '../host-ui/BrandMark.js'
import { createBrandMarkElement } from '../host-ui/BrandMark.js'
import { HostBrandIcon } from '../host-ui/HostBrandIcon.js'
import { HostBreadcrumbs, type HostBreadcrumbSegment } from '../host-ui/HostBreadcrumbs.js'
import { createSidebarItem, type SidebarItemControl } from '../host-ui/SidebarItem.js'
import { observeNativeRailActivation } from '../adapter/native-rail-activation.js'
import { notificationCenterForDocument } from '../notifications/host.js'
import type { NotificationCenter } from '../notifications/model.js'
import { managerCopy, productLocale } from '../ui-copy.js'
import { Navigation } from './components/Navigation.js'
import { managerHeaderBackRoute } from './model/header-navigation.js'
import { useManagerRouter } from './hooks/useManagerRouter.js'
import { projectManagerContentBreadcrumbs } from './model/manager-content-breadcrumbs.js'
import { useManagerSnapshot } from './model/store.js'
import { MarketplaceInstallerProvider, useMarketplaceInstaller } from './model/use-marketplace-installer.js'
import { type ManagerPluginManagementBinding, usePluginManagementSnapshot } from './model/plugin-management.js'
import type { ManagerRoute } from './model/routes.js'
import type { HostManagerNavigationController } from './navigation-controller.js'
import { nativeRouteIdentity, type NativeRouteSource, observeNativeRouteTransition } from './native-route-transition.js'
import { AboutPage } from './pages/AboutPage.js'
import { AcknowledgementsPage } from './pages/AcknowledgementsPage.js'
import { ExtensionPointDetailPage } from './pages/ExtensionPointDetailPage.js'
import { ExtensionPointsPage } from './pages/ExtensionPointsPage.js'
import { ManagerContentPage } from './pages/ManagerContentPage.js'
import { MarketplacePluginPage } from './pages/MarketplacePluginPage.js'
import { MarketplacePage } from './pages/MarketplacePage.js'
import { MarketplaceSourceEditPage } from './pages/MarketplaceSourceEditPage.js'
import { MarketplaceSourcesPage } from './pages/MarketplaceSourcesPage.js'
import { NavigationDetailPage } from './pages/NavigationDetailPage.js'
import { NotificationRulesPage } from './pages/NotificationRulesPage.js'
import { PermissionDetailPage } from './pages/PermissionDetailPage.js'
import { PluginDetailPage } from './pages/PluginDetailPage.js'
import { PluginBundleDetailPage } from './pages/PluginBundleDetailPage.js'
import { PluginsPage } from './pages/PluginsPage.js'
import { RoutesPage } from './pages/RoutesPage.js'

import { ModelConnectionCreatePage } from './pages/ModelConnectionCreatePage.js'
import { ModelServicesPage } from './pages/ModelServicesPage.js'

export function reconcileManagerContentRoute(
  route: ManagerRoute,
  items: ManagerSnapshot['settingsNavigationItems'],
): ManagerRoute | undefined {
  if (route.kind !== 'manager-content') return undefined
  const item = items?.find(candidate => candidate.id === route.id)
  if (item === undefined) return { kind: 'primary', page: 'plugins' }
  if (item.permissionReview === undefined) return undefined
  return {
    kind: 'permission',
    pluginId: item.owner,
    capability: item.permissionReview.capability,
    fingerprint: item.permissionReview.fingerprint,
  }
}

function title(route: ManagerRoute, snapshot: ManagerSnapshot): string {
  const locale = snapshot.localization.locale
  if (route.kind === 'plugin') return snapshot.plugins.find(item => item.id === route.pluginId)?.name ?? route.pluginId
  if (route.kind === 'plugin-bundle') {
    return snapshot.pluginBundles?.bundles.find(item => item.id === route.bundleId)?.name ?? route.bundleId
  }
  if (route.kind === 'permission') return projectPermissionCapabilityName(route.capability, locale)
  if (route.kind === 'extension-point') {
    return snapshot.extensionPoints?.points.find(item => item.id === route.pointId)?.titleProjection.text
      ?? route.pointId
  }
  if (route.kind === 'route' || route.kind === 'page') return route.qualifiedId
  if (route.kind === 'marketplace-plugin') return productLocale(locale) === 'zh-CN' ? '插件详情' : 'Plugin details'
  if (route.kind === 'marketplace-source-edit') {
    return productLocale(locale) === 'zh-CN'
      ? (route.url ? '编辑来源' : '添加来源')
      : (route.url ? 'Edit source' : 'Add source')
  }
  if (route.kind === 'marketplace-sources') {
    return productLocale(locale) === 'zh-CN'
      ? '插件来源'
      : 'Marketplace sources'
  }
  if (route.kind === 'about-acknowledgements') return productLocale(locale) === 'zh-CN' ? '致谢' : 'Acknowledgements'
  if (route.kind === 'model-connection-create') return managerCopy(locale, 'catalog.addConnection')
  if (route.kind === 'notification-rules') {
    return productLocale(locale) === 'zh-CN' ? '通知规则' : 'Notification rules'
  }
  if (route.kind === 'manager-content') {
    return snapshot.settingsNavigationItems?.find(item => item.id === route.id)?.pageTitle ?? route.id
  }
  const keys = {
    plugins: 'manager.nav.plugins',
    'model-services': 'manager.nav.model-services',
    'plugin-bundles': 'manager.nav.plugins',
    'extension-points': 'manager.nav.extension-points',
    routes: 'manager.nav.routes',
    marketplace: 'manager.nav.marketplace',
    about: 'manager.nav.about',
  } as const
  return managerCopy(locale, keys[route.page])
}

function primaryIcon(route: ManagerRoute) {
  if (route.kind !== 'primary') return undefined
  if (route.page === 'plugins') return 'plugins' as const
  if (route.page === 'model-services') return 'settings' as const
  if (route.page === 'plugin-bundles') return 'plugins' as const
  if (route.page === 'extension-points') return 'outlets' as const
  if (route.page === 'routes') return 'routes' as const
  if (route.page === 'marketplace') return 'marketplace' as const
  return 'point-info' as const
}

function pluginFacetLabel(
  page: 'readme' | 'config' | 'permissions' | 'runtime' | 'logs' | 'extension-points' | 'routes',
  locale: string,
): string {
  const labels = productLocale(locale) === 'zh-CN'
    ? {
      readme: 'README',
      config: '配置管理',
      permissions: '权限',
      runtime: '运行状态',
      logs: '日志与诊断',
      'extension-points': '扩展点位',
      routes: '路由',
    }
    : {
      readme: 'README',
      config: 'Configuration',
      permissions: 'Permissions',
      runtime: 'Runtime',
      logs: 'Logs & diagnostics',
      'extension-points': 'Extension points',
      routes: 'Routes',
    }
  return labels[page]
}

function bundleFacetLabel(
  page: 'readme' | 'members' | 'permissions' | 'relations' | 'records',
  locale: string,
): string {
  const labels = productLocale(locale) === 'zh-CN'
    ? { readme: 'README', members: '成员', permissions: '权限', relations: '关联', records: '记录' }
    : { readme: 'README', members: 'Members', permissions: 'Permissions', relations: 'Relations', records: 'Records' }
  return labels[page]
}

function ManagerBreadcrumbs({ route, navigate, heading, model, snapshot }: {
  readonly route: ManagerRoute
  readonly navigate: ReturnType<typeof useManagerRouter>['navigate']
  readonly heading: string
  readonly model: ManagerModel
  readonly snapshot: ManagerSnapshot
}) {
  if (route.kind === 'primary') return <h2>{heading}</h2>
  if (route.kind === 'manager-content') {
    const item = snapshot.settingsNavigationItems?.find(candidate => candidate.id === route.id)
    const segments = projectManagerContentBreadcrumbs({
      current: route.reference,
      ...(item === undefined ? {} : { root: item.route }),
      rootLabel: heading,
      presentation: reference => model.managerContentPresentation?.(route.id, reference),
    })
    if (segments.length <= 1) return <h2>{heading}</h2>
    return (
      <HostBreadcrumbs
        segments={segments.map((segment, index): HostBreadcrumbSegment => ({
          key: `${segment.reference.id}:${index}`,
          label: segment.label,
          ...(index === segments.length - 1
            ? {}
            : { onActivate: () => navigate({ kind: 'manager-content', id: route.id, reference: segment.reference }) }),
        }))}
      />
    )
  }
  if (route.kind === 'plugin') {
    return (
      <HostBreadcrumbs
        segments={[
          {
            key: 'plugins',
            label: managerCopy(snapshot.localization.locale, 'manager.nav.plugins'),
            onActivate: () => navigate({ kind: 'primary', page: 'plugins' }),
          },
          {
            key: route.pluginId,
            label: heading,
            onActivate: () => navigate({ kind: 'plugin', pluginId: route.pluginId, page: 'readme' }),
          },
          { key: route.page, label: pluginFacetLabel(route.page, snapshot.localization.locale) },
        ]}
      />
    )
  }
  if (route.kind === 'plugin-bundle') {
    return (
      <HostBreadcrumbs
        segments={[
          {
            key: 'plugins',
            label: managerCopy(snapshot.localization.locale, 'manager.nav.plugins'),
            onActivate: () => navigate({ kind: 'primary', page: 'plugins' }),
          },
          {
            key: route.bundleId,
            label: heading,
            onActivate: () => navigate({ kind: 'plugin-bundle', bundleId: route.bundleId, page: 'readme' }),
          },
          { key: route.page, label: bundleFacetLabel(route.page, snapshot.localization.locale) },
        ]}
      />
    )
  }
  if (route.kind === 'about-acknowledgements') {
    const about = productLocale(snapshot.localization.locale) === 'zh-CN' ? '关于 CordisX' : 'About CordisX'
    return (
      <HostBreadcrumbs
        segments={[
          { key: 'about', label: about, onActivate: () => navigate({ kind: 'primary', page: 'about' }) },
          { key: 'acknowledgements', label: heading },
        ]}
      />
    )
  }
  if (route.kind === 'notification-rules') return <h2>{heading}</h2>
  if (route.kind === 'marketplace-source-edit') {
    return (
      <HostBreadcrumbs
        segments={[
          {
            key: 'marketplace',
            label: managerCopy(snapshot.localization.locale, 'manager.nav.marketplace'),
            onActivate: () => navigate({ kind: 'primary', page: 'marketplace' }),
          },
          {
            key: 'sources',
            label: productLocale(snapshot.localization.locale) === 'zh-CN' ? '插件来源' : 'Marketplace sources',
            onActivate: () => navigate({ kind: 'marketplace-sources' }),
          },
          { key: 'edit', label: heading },
        ]}
      />
    )
  }
  const parent = route.kind === 'extension-point'
    ? {
      label: managerCopy(snapshot.localization.locale, 'manager.nav.extension-points'),
      page: 'extension-points' as const,
    }
    : route.kind === 'route' || route.kind === 'page'
    ? { label: managerCopy(snapshot.localization.locale, 'manager.nav.routes'), page: 'routes' as const }
    : route.kind === 'model-connection-create'
    ? {
      label: managerCopy(snapshot.localization.locale, 'manager.nav.model-services'),
      page: 'model-services' as const,
    }
    : route.kind === 'marketplace-plugin' || route.kind === 'marketplace-sources'
    ? { label: managerCopy(snapshot.localization.locale, 'manager.nav.marketplace'), page: 'marketplace' as const }
    : { label: managerCopy(snapshot.localization.locale, 'manager.nav.plugins'), page: 'plugins' as const }
  return (
    <HostBreadcrumbs
      segments={[
        { key: parent.page, label: parent.label, onActivate: () => navigate({ kind: 'primary', page: parent.page }) },
        { key: heading, label: heading },
      ]}
    />
  )
}

function Content(
  {
    model,
    marketplace,
    snapshot,
    route,
    notificationCenter,
    pluginManagement,
    pluginManagementSnapshot,
    pluginManagementError,
  }: {
    readonly model: ManagerModel
    readonly marketplace: MarketplaceModel
    readonly snapshot: ManagerSnapshot
    readonly route: ReturnType<typeof useManagerRouter>
    readonly notificationCenter: NotificationCenter | undefined
    readonly pluginManagement: ManagerPluginManagementBinding | undefined
    readonly pluginManagementSnapshot: import('../../management/contracts.js').PluginManagementSnapshot | undefined
    readonly pluginManagementError: string | undefined
  },
) {
  const current = route.route
  if (current.kind === 'plugin') return <PluginDetailPage model={model} snapshot={snapshot} router={route} />
  if (current.kind === 'plugin-bundle') {
    return <PluginBundleDetailPage model={model} snapshot={snapshot} router={route} />
  }
  if (current.kind === 'permission') return <PermissionDetailPage model={model} snapshot={snapshot} router={route} />
  if (current.kind === 'extension-point') {
    return <ExtensionPointDetailPage model={model} snapshot={snapshot} router={route} />
  }
  if (current.kind === 'route' || current.kind === 'page') {
    return <NavigationDetailPage snapshot={snapshot} router={route} />
  }
  if (current.kind === 'marketplace-plugin') {
    return (
      <MarketplacePluginPage
        manager={model}
        marketplace={marketplace}
        snapshot={snapshot}
        router={route}
        pluginManagement={pluginManagement}
        pluginManagementSnapshot={pluginManagementSnapshot}
      />
    )
  }
  if (current.kind === 'marketplace-source-edit') {
    return (
      <MarketplaceSourceEditPage
        locale={snapshot.localization.locale}
        currentUrl={current.url}
        pluginManagement={pluginManagement}
        managementSnapshot={pluginManagementSnapshot}
        close={route.back}
      />
    )
  }
  if (current.kind === 'marketplace-sources') {
    return (
      <MarketplaceSourcesPage
        marketplace={marketplace}
        locale={snapshot.localization.locale}
        pluginManagement={pluginManagement}
        managementSnapshot={pluginManagementSnapshot}
        managementError={pluginManagementError}
        onEdit={source => route.navigate({ kind: 'marketplace-source-edit', ...(source ? { url: source.url } : {}) })}
      />
    )
  }
  if (current.kind === 'model-connection-create') {
    return (
      <ModelConnectionCreatePage
        registry={model.modelProviders}
        locale={snapshot.localization.locale}
        close={route.back}
        responsesOnly={snapshot.platform.hostId === 'codex-desktop'}
      />
    )
  }
  if (current.kind === 'about-acknowledgements') return <AcknowledgementsPage locale={snapshot.localization.locale} />
  if (current.kind === 'notification-rules') {
    return notificationCenter === undefined
      ? (
        <div className="cxr-empty">
          {productLocale(snapshot.localization.locale) === 'zh-CN' ? '通知不可用' : 'Notifications unavailable'}
        </div>
      )
      : <NotificationRulesPage center={notificationCenter} locale={snapshot.localization.locale} />
  }
  if (current.kind === 'manager-content') {
    if (snapshot.settingsNavigationItems?.find(item => item.id === current.id)?.permissionReview !== undefined) {
      return (
        <div className="cxr-notice" role="status" data-manager-permission-review-redirect="true">
          {managerCopy(snapshot.localization.locale, 'permission.review')}
        </div>
      )
    }
    return <ManagerContentPage model={model} router={route} locale={snapshot.localization.locale} />
  }
  if (current.page === 'plugins' || current.page === 'plugin-bundles') {
    return <PluginsPage model={model} snapshot={snapshot} router={route} />
  }
  if (current.page === 'marketplace') {
    return (
      <MarketplacePage
        marketplace={marketplace}
        manager={model}
        snapshot={snapshot}
        router={route}
        pluginManagement={pluginManagement}
        pluginManagementSnapshot={pluginManagementSnapshot}
      />
    )
  }
  if (current.page === 'model-services') {
    return (
      <ModelServicesPage
        registry={model.modelProviders}
        locale={snapshot.localization.locale}
        onCreate={() => route.navigate({ kind: 'model-connection-create' })}
      />
    )
  }
  if (current.page === 'extension-points') return <ExtensionPointsPage snapshot={snapshot} router={route} />
  if (current.page === 'routes') return <RoutesPage snapshot={snapshot} router={route} />
  return <AboutPage model={model} snapshot={snapshot} router={route} />
}

export interface ManagerAppProps {
  readonly model: ManagerModel
  readonly marketplace: MarketplaceModel
  readonly triggerSeat: HTMLElement
  readonly navigationSeat?: HTMLElement
  readonly titlebarSeat?: HTMLElement
  readonly navigationController?: HostManagerNavigationController
  readonly pluginManagement?: ManagerPluginManagementBinding
  readonly activatePane?: () => boolean
  readonly deactivatePane?: () => void
  readonly registerPaneLoss?: (handler: () => void) => void
  readonly nativeRouteHistory?: NativeRouteSource
  /** Host-owned presentation; workspace keeps its mounted route and draft while native navigation is active. */
  readonly presentationMode?: 'overlay' | 'workspace'
  readonly setWorkspaceVisible?: (visible: boolean) => void
}

function PlaygroundManagerTrigger({ seat, open, onToggle, locale }: {
  readonly seat: HTMLElement
  readonly open: boolean
  readonly onToggle: () => void
  readonly locale: string
}) {
  const control = useRef<SidebarItemControl | undefined>(undefined)
  const toggle = useRef(onToggle)
  toggle.current = onToggle
  useLayoutEffect(() => {
    const item = createSidebarItem(seat.ownerDocument, {
      id: 'host.manager',
      label: 'CordisX',
      secondary: 'UI Playground',
      iconElement: createBrandMarkElement(seat.ownerDocument, 'cxsi-brand-mark'),
      selected: open,
      onActivate: () => toggle.current(),
    })
    item.primary.dataset.cordisxManagerTrigger = 'true'
    item.primary.setAttribute('aria-label', managerCopy(locale, 'manager.trigger.manage'))
    item.primary.setAttribute('aria-haspopup', 'dialog')
    item.primary.setAttribute('aria-expanded', String(open))
    control.current = item
    seat.replaceChildren(item.element)
    return () => {
      item.element.remove()
      control.current = undefined
    }
  }, [locale, seat])
  useLayoutEffect(() => {
    const item = control.current
    if (item === undefined) return
    item.setSelected(open)
    item.primary.setAttribute('aria-expanded', String(open))
  }, [open])
  return null
}

export function ManagerApp(
  {
    model,
    marketplace,
    triggerSeat,
    navigationSeat,
    titlebarSeat,
    navigationController,
    pluginManagement,
    activatePane,
    deactivatePane,
    registerPaneLoss,
    nativeRouteHistory,
    presentationMode = 'overlay',
    setWorkspaceVisible,
  }: ManagerAppProps,
) {
  const snapshot = useManagerSnapshot(model)
  const management = usePluginManagementSnapshot(pluginManagement)
  const notificationCenter = notificationCenterForDocument(triggerSeat.ownerDocument)
  const unavailableFeedback = useMemo(() =>
    notificationCenter?.bind({
      key: 'host/manager-seat',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX' }),
    }), [notificationCenter])
  useEffect(() => () => unavailableFeedback?.dispose(), [unavailableFeedback])
  const playgroundStorage = useMemo(
    () =>
      triggerSeat.ownerDocument.querySelector('[data-cordisx-playground-manager-trigger]') === null
        ? undefined
        : triggerSeat.ownerDocument.defaultView?.sessionStorage,
    [triggerSeat],
  )
  const router = useManagerRouter(playgroundStorage)
  const workspaceMode = presentationMode === 'workspace' && playgroundStorage === undefined
    && activatePane !== undefined
  const [open, setOpen] = useState(() => playgroundStorage?.getItem('cordisx.playground.manager.open.v1') === 'true')
  const [workspaceVisited, setWorkspaceVisited] = useState(false)
  const [surface, setSurface] = useState<'pane' | 'modal'>('modal')
  const [seatUnavailable, setSeatUnavailable] = useState(false)
  const restoreTriggerFocus = useRef(true)
  const openManager = () => {
    restoreTriggerFocus.current = true
    if (playgroundStorage !== undefined || activatePane === undefined) {
      setSurface('modal')
      setOpen(true)
      return
    }
    if (
      (nativeRouteHistory === undefined || nativeRouteIdentity(nativeRouteHistory.snapshot()) !== undefined)
      && activatePane() && titlebarSeat !== undefined
    ) {
      setSeatUnavailable(false)
      setSurface('pane')
      if (workspaceMode) setWorkspaceVisited(true)
      setOpen(true)
    } else {
      deactivatePane?.()
      setOpen(false)
      setSeatUnavailable(true)
      unavailableFeedback?.api.show({
        kind: 'manager.seat-unavailable',
        type: 'warning',
        message: productLocale(snapshot.localization.locale) === 'zh-CN'
          ? '当前页面暂时无法打开 CordisX'
          : 'CordisX is unavailable on this page',
      })
    }
  }
  const closeManager = (restoreFocus = true) => {
    restoreTriggerFocus.current = restoreFocus
    setOpen(false)
  }
  const installer = useMarketplaceInstaller(model, snapshot, {
    failed: productLocale(snapshot.localization.locale) === 'zh-CN' ? '插件安装失败' : 'Plugin installation failed',
    succeeded: productLocale(snapshot.localization.locale) === 'zh-CN'
      ? '插件安装完成'
      : 'Plugin installation complete',
  }, { document: triggerSeat.ownerDocument, feedbackActive: open })
  const previousOpen = useRef(open)
  const managerMain = useRef<HTMLElement>(null)
  const heading = useMemo(() => title(router.route, snapshot), [router.route, snapshot])
  useLayoutEffect(() =>
    navigationController?.bind(request => {
      if ('contributionId' in request) {
        router.openDetail(
          { kind: 'manager-content', id: request.contributionId, reference: request.root },
          { kind: 'manager-content', id: request.contributionId, reference: request.target },
        )
      } else {
        router.navigate(request)
      }
      openManager()
    }), [navigationController, router.navigate, router.openDetail])
  useLayoutEffect(() =>
    navigationController?.bindReturnPort({
      capture: () => open ? router.capture() : [],
      restore: captured => {
        router.restore(captured)
        openManager()
      },
    }), [navigationController, open, router.capture, router.restore])
  useLayoutEffect(() =>
    notificationCenter?.bindManager(() => {
      router.navigate({ kind: 'notification-rules' })
      openManager()
    }), [notificationCenter, router.navigate])
  useLayoutEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (!workspaceMode && event.key === 'Escape' && !event.defaultPrevented) closeManager()
    }
    const disposeRouteObserver = surface === 'pane' && nativeRouteHistory !== undefined
      ? observeNativeRouteTransition(nativeRouteHistory, () => flushSync(() => closeManager(false)))
      : () => {}
    const disposeRailObserver = surface === 'pane'
      ? observeNativeRailActivation(triggerSeat.ownerDocument, () => flushSync(() => closeManager(false)))
      : () => {}
    window.addEventListener('keydown', onKey)
    queueMicrotask(() => managerMain.current?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('keydown', onKey)
      disposeRouteObserver()
      disposeRailObserver()
    }
  }, [nativeRouteHistory, open, surface, triggerSeat, workspaceMode])
  useLayoutEffect(() => {
    if (!open) deactivatePane?.()
  }, [deactivatePane, open])
  useLayoutEffect(() => {
    if (workspaceMode) setWorkspaceVisible?.(open)
  }, [open, setWorkspaceVisible, workspaceMode])
  useLayoutEffect(() => {
    registerPaneLoss?.(() => flushSync(() => closeManager(false)))
    return () => registerPaneLoss?.(() => {})
  }, [registerPaneLoss])
  useEffect(() => {
    playgroundStorage?.setItem('cordisx.playground.manager.open.v1', String(open))
  }, [open, playgroundStorage])
  useEffect(() => {
    if (previousOpen.current && !open) {
      if (restoreTriggerFocus.current) {
        triggerSeat.querySelector<HTMLElement>('[data-cordisx-manager-trigger]')?.focus({ preventScroll: true })
      }
    }
    previousOpen.current = open
  }, [open, triggerSeat])
  useEffect(() => {
    if (!open) return
    const replacement = reconcileManagerContentRoute(router.route, snapshot.settingsNavigationItems)
    if (replacement !== undefined) router.replace(replacement)
  }, [open, router.replace, router.route, snapshot.settingsNavigationItems])
  const attach = useMemo(
    () => () =>
      triggerSeat.ownerDocument.querySelector<HTMLElement>('[data-cordisx-react-manager]')
        ?? triggerSeat.ownerDocument.body,
    [triggerSeat],
  )
  const contributionId = router.route.kind === 'manager-content' ? router.route.id : undefined
  const contributionIcon = contributionId === undefined
    ? undefined
    : snapshot.settingsNavigationItems?.find(item => item.id === contributionId)?.icon
  const managerContentParent = router.route.kind === 'manager-content'
    ? model.managerContentPresentation?.(router.route.id, router.route.reference)?.parent
    : undefined
  const backRoute = managerHeaderBackRoute(router.route, managerContentParent, router.capture().at(-2))
  const onBack = () => {
    if (backRoute === undefined) return
    const previous = router.capture().at(-2)
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(backRoute)) router.back()
    else router.replace(backRoute)
  }
  const header = (
    <header className="cxr-header" data-manager-surface={surface}>
      <span className="cxr-header-seat">
        {backRoute !== undefined
          ? (
            <Button
              className="cxr-header-back"
              shape="square"
              variant="text"
              aria-label={managerCopy(snapshot.localization.locale, 'manager.back')}
              icon={<HostIcon token="back" />}
              onClick={onBack}
            />
          )
          : router.route.kind === 'primary'
          ? router.route.page === 'about'
            ? <BrandMark />
            : <HostIcon token={primaryIcon(router.route)!} />
          : contributionIcon !== undefined
          ? <HostBrandIcon icon={contributionIcon} />
          : <BrandMark />}
      </span>
      <div className="cxr-heading">
        <ManagerBreadcrumbs
          route={router.route}
          navigate={router.navigate}
          heading={heading}
          model={model}
          snapshot={snapshot}
        />
      </div>
      {!workspaceMode
        ? (
          <div className="cxr-titlebar-actions">
            <Button
              className="cxr-titlebar-action"
              shape="square"
              variant="text"
              aria-label={managerCopy(snapshot.localization.locale, 'manager.close')}
              icon={<HostIcon token="close" />}
              onClick={() => closeManager()}
            />
          </div>
        )
        : null}
    </header>
  )
  return (
    <ConfigProvider globalConfig={{ attach }}>
      {playgroundStorage === undefined
        ? createPortal(
          <Button
            className="cxr-trigger"
            type="button"
            shape="square"
            variant="text"
            data-cordisx-manager-trigger="true"
            aria-label={managerCopy(snapshot.localization.locale, 'manager.trigger.manage')}
            aria-description={seatUnavailable
              ? productLocale(snapshot.localization.locale) === 'zh-CN'
                ? '当前页面暂时无法打开 CordisX'
                : 'CordisX is unavailable on this page'
              : undefined}
            aria-expanded={open}
            aria-current={open && surface === 'pane' ? 'page' : undefined}
            title={managerCopy(snapshot.localization.locale, 'manager.trigger.manage')}
            icon={<BrandMark className="cxr-trigger-mark" />}
            onClick={() => flushSync(() => open ? closeManager() : openManager())}
          />,
          triggerSeat,
        )
        : (
          <PlaygroundManagerTrigger
            seat={triggerSeat}
            open={open}
            locale={snapshot.localization.locale}
            onToggle={() => flushSync(() => open ? closeManager() : openManager())}
          />
        )}
      {open && surface === 'pane' && navigationSeat !== undefined
        ? createPortal(
          <aside
            className="cxr-sidebar cxr-native-navigation"
            aria-label={managerCopy(snapshot.localization.locale, 'manager.dialog')}
          >
            <Navigation snapshot={snapshot} router={router} onSelect={route => router.restore([route])} />
          </aside>,
          navigationSeat,
        )
        : null}
      {open && surface === 'pane' && titlebarSeat !== undefined
        ? createPortal(header, titlebarSeat)
        : null}
      {open || (workspaceMode && workspaceVisited)
        ? (
          <div
            className={surface === 'pane' ? 'cxr-pane-layer' : 'cxr-backdrop'}
            data-cordisx-manager-pane={open && surface === 'pane' ? 'true' : undefined}
            data-cordisx-manager-modal={open && surface === 'modal' ? 'true' : undefined}
            data-cordisx-manager-workspace={workspaceMode ? 'true' : undefined}
            aria-hidden={open ? undefined : true}
            inert={!open}
            style={open ? undefined : { display: 'none' }}
            onMouseDown={event => {
              if (surface === 'modal' && event.target === event.currentTarget) closeManager()
            }}
          >
            <section
              className={surface === 'pane' ? 'cxr-pane-shell' : 'cxr-dialog'}
              role={surface === 'modal' ? 'dialog' : undefined}
              aria-modal={surface === 'modal' ? 'true' : undefined}
              aria-label={managerCopy(snapshot.localization.locale, 'manager.dialog')}
            >
              {surface === 'modal'
                ? (
                  <aside className="cxr-sidebar">
                    <Navigation snapshot={snapshot} router={router} />
                  </aside>
                )
                : null}
              <main ref={managerMain} className="cxr-main" tabIndex={-1}>
                {surface === 'modal' ? header : null}
                <div
                  className="cxr-content"
                  data-content-layout={(router.route.kind === 'model-connection-create'
                      || router.route.kind === 'marketplace-source-edit')
                    ? 'form'
                    : 'document'}
                >
                  <MarketplaceInstallerProvider installer={installer}>
                    <Content
                      model={model}
                      marketplace={marketplace}
                      snapshot={snapshot}
                      route={router}
                      notificationCenter={notificationCenter}
                      pluginManagement={pluginManagement}
                      pluginManagementSnapshot={management.snapshot}
                      pluginManagementError={management.error}
                    />
                  </MarketplaceInstallerProvider>
                </div>
              </main>
            </section>
          </div>
        )
        : null}
    </ConfigProvider>
  )
}
