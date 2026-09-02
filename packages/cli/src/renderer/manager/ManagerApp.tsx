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
import { HostBreadcrumbs, type HostBreadcrumbSegment } from '../host-ui/HostBreadcrumbs.js'
import { HostSurfaceIcon } from '../host-ui/HostSurfaceIcon.js'
import { createSidebarItem, type SidebarItemControl } from '../host-ui/SidebarItem.js'
import { managerCopy, productLocale } from '../ui-copy.js'
import { Navigation } from './components/Navigation.js'
import { useManagerRouter } from './hooks/useManagerRouter.js'
import { projectManagerContentBreadcrumbs } from './model/manager-content-breadcrumbs.js'
import { useManagerSnapshot } from './model/store.js'
import type { ManagerRoute } from './model/routes.js'
import { AboutPage } from './pages/AboutPage.js'
import { AcknowledgementsPage } from './pages/AcknowledgementsPage.js'
import { ExtensionPointDetailPage } from './pages/ExtensionPointDetailPage.js'
import { ExtensionPointsPage } from './pages/ExtensionPointsPage.js'
import { ManagerContentPage } from './pages/ManagerContentPage.js'
import { MarketplacePage } from './pages/MarketplacePage.js'
import { MarketplacePluginPage } from './pages/MarketplacePluginPage.js'
import { MarketplaceSourcesPage } from './pages/MarketplaceSourcesPage.js'
import { NavigationDetailPage } from './pages/NavigationDetailPage.js'
import { PermissionDetailPage } from './pages/PermissionDetailPage.js'
import { PluginDetailPage } from './pages/PluginDetailPage.js'
import { PluginsPage } from './pages/PluginsPage.js'
import { RoutesPage } from './pages/RoutesPage.js'

function title(route: ManagerRoute, snapshot: ManagerSnapshot): string {
  const locale = snapshot.localization.locale
  if (route.kind === 'plugin') return snapshot.plugins.find(item => item.id === route.pluginId)?.name ?? route.pluginId
  if (route.kind === 'permission') return projectPermissionCapabilityName(route.capability, locale)
  if (route.kind === 'extension-point') return snapshot.extensionPoints?.points.find(item => item.id === route.pointId)?.titleProjection.text ?? route.pointId
  if (route.kind === 'route' || route.kind === 'page') return route.qualifiedId
  if (route.kind === 'marketplace-plugin') return productLocale(locale) === 'zh-CN' ? '插件详情' : 'Plugin details'
  if (route.kind === 'marketplace-sources') return productLocale(locale) === 'zh-CN' ? '插件来源' : 'Marketplace sources'
  if (route.kind === 'about-acknowledgements') return productLocale(locale) === 'zh-CN' ? '致谢' : 'Acknowledgements'
  if (route.kind === 'manager-content') return snapshot.settingsNavigationItems?.find(item => item.id === route.id)?.pageTitle ?? route.id
  const keys = {
    plugins: 'manager.nav.plugins',
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
  if (route.page === 'extension-points') return 'outlets' as const
  if (route.page === 'routes') return 'routes' as const
  if (route.page === 'marketplace') return 'marketplace' as const
  return 'point-info' as const
}

function pluginFacetLabel(page: 'readme' | 'config' | 'permissions' | 'runtime' | 'logs' | 'extension-points' | 'routes', locale: string): string {
  const labels = productLocale(locale) === 'zh-CN' ? {
    readme: 'README', config: '配置管理', permissions: '权限', runtime: '运行状态', logs: '日志与诊断', 'extension-points': '扩展点位', routes: '路由',
  } : {
    readme: 'README', config: 'Configuration', permissions: 'Permissions', runtime: 'Runtime', logs: 'Logs & diagnostics', 'extension-points': 'Extension points', routes: 'Routes',
  }
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
    return <HostBreadcrumbs segments={segments.map((segment, index): HostBreadcrumbSegment => ({
      key: `${segment.reference.id}:${index}`,
      label: segment.label,
      ...(index === segments.length - 1 ? {} : { onActivate: () => navigate({ kind: 'manager-content', id: route.id, reference: segment.reference }) }),
    }))} />
  }
  if (route.kind === 'plugin') {
    return <HostBreadcrumbs segments={[
      { key: 'plugins', label: managerCopy(snapshot.localization.locale, 'manager.nav.plugins'), onActivate: () => navigate({ kind: 'primary', page: 'plugins' }) },
      { key: route.pluginId, label: heading, onActivate: () => navigate({ kind: 'plugin', pluginId: route.pluginId, page: 'readme' }) },
      { key: route.page, label: pluginFacetLabel(route.page, snapshot.localization.locale) },
    ]} />
  }
  if (route.kind === 'about-acknowledgements') {
    const about = productLocale(snapshot.localization.locale) === 'zh-CN' ? '关于 CordisX' : 'About CordisX'
    return <HostBreadcrumbs segments={[
      { key: 'about', label: about, onActivate: () => navigate({ kind: 'primary', page: 'about' }) },
      { key: 'acknowledgements', label: heading },
    ]} />
  }
  const parent = route.kind === 'extension-point'
    ? { label: managerCopy(snapshot.localization.locale, 'manager.nav.extension-points'), page: 'extension-points' as const }
    : route.kind === 'route' || route.kind === 'page'
      ? { label: managerCopy(snapshot.localization.locale, 'manager.nav.routes'), page: 'routes' as const }
      : route.kind === 'marketplace-plugin' || route.kind === 'marketplace-sources'
        ? { label: managerCopy(snapshot.localization.locale, 'manager.nav.marketplace'), page: 'marketplace' as const }
        : { label: managerCopy(snapshot.localization.locale, 'manager.nav.plugins'), page: 'plugins' as const }
  return <HostBreadcrumbs segments={[
    { key: parent.page, label: parent.label, onActivate: () => navigate({ kind: 'primary', page: parent.page }) },
    { key: heading, label: heading },
  ]} />
}

function Content({ model, marketplace, snapshot, route }: { readonly model: ManagerModel; readonly marketplace: MarketplaceModel; readonly snapshot: ManagerSnapshot; readonly route: ReturnType<typeof useManagerRouter> }) {
  const current = route.route
  if (current.kind === 'plugin') return <PluginDetailPage model={model} snapshot={snapshot} router={route} />
  if (current.kind === 'permission') return <PermissionDetailPage model={model} snapshot={snapshot} router={route} />
  if (current.kind === 'extension-point') return <ExtensionPointDetailPage model={model} snapshot={snapshot} router={route} />
  if (current.kind === 'route' || current.kind === 'page') return <NavigationDetailPage snapshot={snapshot} router={route} />
  if (current.kind === 'marketplace-plugin') return <MarketplacePluginPage marketplace={marketplace} snapshot={snapshot} router={route} />
  if (current.kind === 'marketplace-sources') return <MarketplaceSourcesPage marketplace={marketplace} locale={snapshot.localization.locale} />
  if (current.kind === 'about-acknowledgements') return <AcknowledgementsPage locale={snapshot.localization.locale} />
  if (current.kind === 'manager-content') return <ManagerContentPage model={model} router={route} locale={snapshot.localization.locale} />
  if (current.page === 'plugins') return <PluginsPage model={model} snapshot={snapshot} router={route} />
  if (current.page === 'extension-points') return <ExtensionPointsPage snapshot={snapshot} router={route} />
  if (current.page === 'routes') return <RoutesPage snapshot={snapshot} router={route} />
  if (current.page === 'marketplace') return <MarketplacePage marketplace={marketplace} manager={model} snapshot={snapshot} router={route} />
  return <AboutPage model={model} snapshot={snapshot} router={route} />
}

export interface ManagerAppProps {
  readonly model: ManagerModel
  readonly marketplace: MarketplaceModel
  readonly triggerSeat: HTMLElement
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
    return () => { item.element.remove(); control.current = undefined }
  }, [locale, seat])
  useLayoutEffect(() => {
    const item = control.current
    if (item === undefined) return
    item.setSelected(open)
    item.primary.setAttribute('aria-expanded', String(open))
  }, [open])
  return null
}

export function ManagerApp({ model, marketplace, triggerSeat }: ManagerAppProps) {
  const snapshot = useManagerSnapshot(model)
  const playgroundStorage = useMemo(() => triggerSeat.ownerDocument.querySelector('[data-cordisx-playground-manager-trigger]') === null ? undefined : triggerSeat.ownerDocument.defaultView?.sessionStorage, [triggerSeat])
  const router = useManagerRouter(playgroundStorage)
  const [open, setOpen] = useState(() => playgroundStorage?.getItem('cordisx.playground.manager.open.v1') === 'true')
  const previousOpen = useRef(open)
  const dialog = useRef<HTMLElement>(null)
  const heading = useMemo(() => title(router.route, snapshot), [router.route, snapshot])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    queueMicrotask(() => dialog.current?.focus())
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  useEffect(() => { playgroundStorage?.setItem('cordisx.playground.manager.open.v1', String(open)) }, [open, playgroundStorage])
  useEffect(() => {
    if (previousOpen.current && !open) triggerSeat.querySelector<HTMLElement>('[data-cordisx-manager-trigger]')?.focus({ preventScroll: true })
    previousOpen.current = open
  }, [open, triggerSeat])
  useEffect(() => {
    const route = router.route
    if (!open || route.kind !== 'manager-content') return
    if (snapshot.settingsNavigationItems?.some(item => item.id === route.id) === true) return
    router.navigate({ kind: 'primary', page: 'plugins' })
  }, [open, router.navigate, router.route, snapshot.settingsNavigationItems])
  const attach = useMemo(() => () => triggerSeat.ownerDocument.querySelector<HTMLElement>('[data-cordisx-react-manager]') ?? triggerSeat.ownerDocument.body, [triggerSeat])
  const contributionId = router.route.kind === 'manager-content' ? router.route.id : undefined
  const contributionIcon = contributionId === undefined ? undefined : snapshot.settingsNavigationItems?.find(item => item.id === contributionId)?.icon
  const managerContentParent = router.route.kind === 'manager-content'
    ? model.managerContentPresentation?.(router.route.id, router.route.reference)?.parent
    : undefined
  const managerContentBackRoute = router.route.kind === 'manager-content' && managerContentParent !== undefined
    ? { kind: 'manager-content' as const, id: router.route.id, reference: managerContentParent }
    : undefined
  return <ConfigProvider globalConfig={{ attach }}>
    {playgroundStorage === undefined
      ? createPortal(<Button className="cxr-trigger" type="button" shape="square" variant="text" data-cordisx-manager-trigger="true" aria-label={managerCopy(snapshot.localization.locale, 'manager.trigger.manage')} aria-haspopup="dialog" aria-expanded={open} title={managerCopy(snapshot.localization.locale, 'manager.trigger.manage')} icon={<BrandMark className="cxr-trigger-mark" />} onClick={() => flushSync(() => setOpen(true))} />, triggerSeat)
      : <PlaygroundManagerTrigger seat={triggerSeat} open={open} locale={snapshot.localization.locale} onToggle={() => flushSync(() => setOpen(value => !value))} />}
    {open ? <div className="cxr-backdrop" data-cordisx-manager-modal="true" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section ref={dialog} className="cxr-dialog" role="dialog" aria-modal="true" aria-label={managerCopy(snapshot.localization.locale, 'manager.dialog')} tabIndex={-1}>
        <aside className="cxr-sidebar"><Navigation snapshot={snapshot} router={router} /></aside>
        <main className="cxr-main">
          <header className="cxr-header">
            <span className="cxr-header-seat">{router.route.kind === 'primary'
              ? router.route.page === 'about' ? <BrandMark /> : <HostIcon token={primaryIcon(router.route)!} />
              : managerContentBackRoute !== undefined
                ? <Button shape="square" variant="text" aria-label={managerCopy(snapshot.localization.locale, 'manager.back')} icon={<HostIcon token="back" />} onClick={() => router.navigate(managerContentBackRoute)} />
                : contributionIcon !== undefined
                  ? <HostSurfaceIcon token={contributionIcon} />
                  : <Button shape="square" variant="text" aria-label={managerCopy(snapshot.localization.locale, 'manager.back')} icon={<HostIcon token="back" />} onClick={router.back} />}</span>
            <div className="cxr-heading"><ManagerBreadcrumbs route={router.route} navigate={router.navigate} heading={heading} model={model} snapshot={snapshot} /></div>
            <Button shape="square" variant="text" aria-label={managerCopy(snapshot.localization.locale, 'manager.close')} icon={<HostIcon token="close" />} onClick={() => setOpen(false)} />
          </header>
          <div className="cxr-content"><Content model={model} marketplace={marketplace} snapshot={snapshot} route={router} /></div>
        </main>
      </section>
    </div> : null}
  </ConfigProvider>
}
