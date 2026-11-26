import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { flushSync } from 'react-dom'
import { Button, ConfigProvider } from 'tdesign-react'
import type { MarketplaceModel } from '../marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../manager.js'
import { BrandMark } from '../host-ui/BrandMark.js'
import { createBrandMarkElement } from '../host-ui/BrandMark.js'
import { createSidebarItem, type SidebarItemControl } from '../host-ui/SidebarItem.js'
import { observeNativeRailActivation } from '../adapter/native-rail-activation.js'
import { useWorkspacePaneActivation } from './use-workspace-pane-activation.js'
import { notificationCenterForDocument } from '../notifications/host.js'
import type { NotificationCenter } from '../notifications/model.js'
import { managerCopy, productLocale } from '../ui-copy.js'
import { Navigation } from './components/Navigation.js'
import { ManagerFrame } from './components/ManagerFrame.js'
import { ManagerHeader } from './components/ManagerHeader.js'
import { useManagerRouter } from './hooks/useManagerRouter.js'
import { useManagerSnapshot } from './model/store.js'
import { MarketplaceInstallerProvider, useMarketplaceInstaller } from './model/use-marketplace-installer.js'
import { type ManagerPluginManagementBinding, usePluginManagementSnapshot } from './model/plugin-management.js'
import { StandalonePluginLifecycleContext } from './model/standalone-plugin-lifecycle.js'
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
import { ChatExecutionPage } from './pages/ChatExecutionPage.js'
import { PermissionDetailPage } from './pages/PermissionDetailPage.js'
import { PluginDetailPage } from './pages/PluginDetailPage.js'
import { PluginBundleDetailPage } from './pages/PluginBundleDetailPage.js'
import { PluginsPage } from './pages/PluginsPage.js'
import { RoutesPage } from './pages/RoutesPage.js'

import { ModelConnectionCreatePage } from './pages/ModelConnectionCreatePage.js'
import { ModelServicesPage } from './pages/ModelServicesPage.js'
import type { ModelServicesSecondaryPage } from './pages/model-catalog/ModelTransferPages.js'

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
    onModelServicesSecondaryPageChange,
    headerActionsSeat,
  }: {
    readonly model: ManagerModel
    readonly marketplace: MarketplaceModel
    readonly snapshot: ManagerSnapshot
    readonly route: ReturnType<typeof useManagerRouter>
    readonly notificationCenter: NotificationCenter | undefined
    readonly pluginManagement: ManagerPluginManagementBinding | undefined
    readonly pluginManagementSnapshot: import('../../management/contracts.js').PluginManagementSnapshot | undefined
    readonly pluginManagementError: string | undefined
    readonly headerActionsSeat: HTMLElement | null
    readonly onModelServicesSecondaryPageChange: (page: ModelServicesSecondaryPage | undefined) => void
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
  if (current.kind === 'chat-execution') {
    return (
      <ChatExecutionPage
        model={model}
        locale={snapshot.localization.locale}
        {...(notificationCenter === undefined ? {} : { notifications: notificationCenter })}
      />
    )
  }
  if (current.kind === 'manager-content') {
    if (snapshot.settingsNavigationItems?.find(item => item.id === current.id)?.permissionReview !== undefined) {
      return (
        <div className="cxr-notice" role="status" data-manager-permission-review-redirect="true">
          {managerCopy(snapshot.localization.locale, 'permission.review')}
        </div>
      )
    }
    return (
      <ManagerContentPage
        model={model}
        router={route}
        locale={snapshot.localization.locale}
        headerActionsSeat={headerActionsSeat}
      />
    )
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
        onSecondaryPageChange={onModelServicesSecondaryPageChange}
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
  readonly allowModalFallback?: () => boolean
  readonly deactivatePane?: () => void
  readonly registerPaneLoss?: (handler: () => void) => void
  readonly nativeRouteHistory?: NativeRouteSource
  /** Host-owned presentation; workspace keeps its mounted route and draft while native navigation is active. */
  readonly presentationMode?: 'overlay' | 'workspace' | 'standalone'
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
    allowModalFallback,
    deactivatePane,
    registerPaneLoss,
    nativeRouteHistory,
    presentationMode = 'overlay',
    setWorkspaceVisible,
  }: ManagerAppProps,
) {
  const standaloneMode = presentationMode === 'standalone'
  const snapshot = useManagerSnapshot(model)
  const management = usePluginManagementSnapshot(
    pluginManagement,
    standaloneMode ? snapshot.pluginLifecycle?.revision : undefined,
  )
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
      standaloneMode || triggerSeat.ownerDocument.querySelector('[data-cordisx-playground-manager-trigger]') === null
        ? undefined
        : triggerSeat.ownerDocument.defaultView?.sessionStorage,
    [standaloneMode, triggerSeat],
  )
  const standaloneStorage = useMemo(() => {
    if (!standaloneMode) return undefined
    try {
      return triggerSeat.ownerDocument.defaultView?.sessionStorage
    } catch {
      return undefined
    }
  }, [standaloneMode, triggerSeat])
  const router = useManagerRouter(playgroundStorage, standaloneStorage)
  const workspaceMode = presentationMode === 'workspace' && playgroundStorage === undefined
    && activatePane !== undefined
  const [open, setOpen] = useState(() =>
    standaloneMode || playgroundStorage?.getItem('cordisx.playground.manager.open.v1') === 'true'
  )
  const [workspaceVisited, setWorkspaceVisited] = useState(false)
  const [surface, setSurface] = useState<'pane' | 'modal'>('modal')
  const [seatUnavailable, setSeatUnavailable] = useState(false)
  const [headerActionsSeat, setHeaderActionsSeat] = useState<HTMLElement | null>(null)
  const [modelServicesSecondaryPage, setModelServicesSecondaryPage] = useState<ModelServicesSecondaryPage>()
  const restoreTriggerFocus = useRef(true)
  const showSeatUnavailable = () => {
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
  const workspaceActivation = useWorkspacePaneActivation({
    document: triggerSeat.ownerDocument,
    ...(nativeRouteHistory === undefined ? {} : { route: nativeRouteHistory }),
    ...(activatePane === undefined ? {} : { activatePane }),
    ...(titlebarSeat === undefined ? {} : { titlebarSeat }),
    onOpened: () => {
      setSeatUnavailable(false)
      setSurface('pane')
      setWorkspaceVisited(true)
      setOpen(true)
    },
    onUnavailable: showSeatUnavailable,
  })
  const openManager = () => {
    restoreTriggerFocus.current = true
    if (playgroundStorage !== undefined || activatePane === undefined) {
      setSurface('modal')
      setOpen(true)
      return
    }
    if (workspaceMode) {
      workspaceActivation.open()
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
    } else if (allowModalFallback?.()) {
      deactivatePane?.()
      setSeatUnavailable(false)
      setSurface('modal')
      setOpen(true)
    } else {
      showSeatUnavailable()
    }
  }
  const closeManager = (restoreFocus = true) => {
    if (standaloneMode) return
    workspaceActivation.cancel()
    restoreTriggerFocus.current = restoreFocus
    setOpen(false)
  }
  const installer = useMarketplaceInstaller(model, snapshot, {
    failed: productLocale(snapshot.localization.locale) === 'zh-CN' ? '插件安装失败' : 'Plugin installation failed',
    succeeded: productLocale(snapshot.localization.locale) === 'zh-CN'
      ? '插件安装完成'
      : 'Plugin installation complete',
  }, {
    document: triggerSeat.ownerDocument,
    feedbackActive: open,
    ...(standaloneMode && pluginManagement
      ? { standalone: { binding: pluginManagement, snapshot: management.snapshot } }
      : {}),
  })
  const previousOpen = useRef(open)
  const managerMain = useRef<HTMLElement>(null)
  useEffect(() => {
    if (router.route.kind !== 'primary' || router.route.page !== 'model-services') {
      setModelServicesSecondaryPage(undefined)
    }
  }, [router.route])
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
      if (!standaloneMode && !workspaceMode && event.key === 'Escape' && !event.defaultPrevented) closeManager()
    }
    const disposeRouteObserver = surface === 'pane' && !workspaceMode && nativeRouteHistory !== undefined
      ? observeNativeRouteTransition(nativeRouteHistory, () => flushSync(() => closeManager(false)))
      : () => {}
    const disposeRailObserver = surface === 'pane' && !workspaceMode
      ? observeNativeRailActivation(triggerSeat.ownerDocument, () => flushSync(() => closeManager(false)))
      : () => {}
    window.addEventListener('keydown', onKey)
    queueMicrotask(() => managerMain.current?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('keydown', onKey)
      disposeRouteObserver()
      disposeRailObserver()
    }
  }, [nativeRouteHistory, open, standaloneMode, surface, triggerSeat, workspaceMode])
  useLayoutEffect(() => {
    if (!workspaceMode) return
    return observeNativeRailActivation(triggerSeat.ownerDocument, () => {
      if (workspaceActivation.pending() || open) flushSync(() => closeManager(false))
    })
  }, [open, triggerSeat, workspaceMode])
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
  const header = (
    <ManagerHeader
      router={router}
      snapshot={snapshot}
      model={model}
      modelServicesSecondaryPage={modelServicesSecondaryPage}
      surface={surface}
      standaloneMode={standaloneMode}
      workspaceMode={workspaceMode}
      setHeaderActionsSeat={setHeaderActionsSeat}
      onClose={closeManager}
    />
  )
  return (
    <ConfigProvider globalConfig={{ attach }}>
      {standaloneMode ? null : playgroundStorage === undefined
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
            onClick={() => flushSync(() => open || workspaceActivation.pending() ? closeManager() : openManager())}
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
          <ManagerFrame
            standaloneMode={standaloneMode}
            workspaceMode={workspaceMode}
            open={open}
            surface={surface}
            locale={snapshot.localization.locale}
            sidebar={<Navigation snapshot={snapshot} router={router} />}
            header={header}
            mainRef={managerMain}
            onClose={closeManager}
          >
            <div
              className="cxr-content"
              data-content-layout={router.route.kind === 'manager-content'
                  && model.managerContentPresentation?.(router.route.id, router.route.reference)?.contentInset
                    === 'none'
                ? 'embedded'
                : (modelServicesSecondaryPage !== undefined
                    || router.route.kind === 'model-connection-create'
                    || router.route.kind === 'marketplace-source-edit')
                ? 'form'
                : 'document'}
            >
              <MarketplaceInstallerProvider installer={installer}>
                <StandalonePluginLifecycleContext.Provider
                  value={standaloneMode && pluginManagement
                    ? { binding: pluginManagement, snapshot: management.snapshot }
                    : undefined}
                >
                  <Content
                    model={model}
                    marketplace={marketplace}
                    snapshot={snapshot}
                    route={router}
                    notificationCenter={notificationCenter}
                    pluginManagement={pluginManagement}
                    pluginManagementSnapshot={management.snapshot}
                    pluginManagementError={management.error}
                    headerActionsSeat={headerActionsSeat}
                    onModelServicesSecondaryPageChange={setModelServicesSecondaryPage}
                  />
                </StandalonePluginLifecycleContext.Provider>
              </MarketplaceInstallerProvider>
            </div>
          </ManagerFrame>
        )
        : null}
    </ConfigProvider>
  )
}
