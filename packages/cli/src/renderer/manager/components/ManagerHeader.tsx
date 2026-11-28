import { Button } from 'tdesign-react'
import { projectPermissionCapabilityName } from '../../../permission-locales.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { BrandMark } from '../../host-ui/BrandMark.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { HostBrandIcon } from '../../host-ui/HostBrandIcon.js'
import { HostBreadcrumbs, type HostBreadcrumbSegment } from '../../host-ui/HostBreadcrumbs.js'
import { managerCopy, productLocale } from '../../ui-copy.js'
import { ChatCreationDefaultsAction } from './ChatCreationDefaultsAction.js'
import { managerHeaderBackRoute } from '../model/header-navigation.js'
import { projectManagerContentBreadcrumbs } from '../model/manager-content-breadcrumbs.js'
import type { useManagerRouter } from '../hooks/useManagerRouter.js'
import type { ManagerRoute } from '../model/routes.js'
import type { ModelServicesSecondaryPage } from '../pages/model-catalog/ModelTransferPages.js'

function title(route: ManagerRoute, snapshot: ManagerSnapshot, unresolvedTitle?: string): string {
  const locale = snapshot.localization.locale
  if (route.kind === 'plugin') {
    return snapshot.plugins.find(item => item.id === route.pluginId)?.name ?? unresolvedTitle ?? route.pluginId
  }
  if (route.kind === 'plugin-bundle') {
    return snapshot.pluginBundles?.bundles.find(item => item.id === route.bundleId)?.name ?? unresolvedTitle
      ?? route.bundleId
  }
  if (route.kind === 'permission') return projectPermissionCapabilityName(route.capability, locale)
  if (route.kind === 'extension-point') {
    return snapshot.extensionPoints?.points.find(item => item.id === route.pointId)?.titleProjection.text
      ?? unresolvedTitle ?? route.pointId
  }
  if (route.kind === 'route' || route.kind === 'page') return unresolvedTitle ?? route.qualifiedId
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
  if (route.kind === 'chat-execution') {
    return productLocale(locale) === 'zh-CN'
      ? '新建对话默认配置'
      : 'New chat defaults'
  }
  if (route.kind === 'manager-content') {
    return snapshot.settingsNavigationItems?.find(item => item.id === route.id)?.pageTitle ?? unresolvedTitle
      ?? route.id
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
  readonly model: Pick<ManagerModel, 'managerContentPresentation'>
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
    : route.kind === 'model-connection-create' || route.kind === 'chat-execution'
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

/** Shared Host titlebar for the connected Manager and its starting surface. */
export function ManagerHeader({
  router,
  snapshot,
  model,
  modelServicesSecondaryPage,
  surface,
  standaloneMode,
  workspaceMode,
  setHeaderActionsSeat,
  onClose,
  actionsEnabled = true,
  unresolvedTitle,
}: {
  readonly router: ReturnType<typeof useManagerRouter>
  readonly snapshot: ManagerSnapshot
  readonly model: Pick<ManagerModel, 'managerContentPresentation'>
  readonly modelServicesSecondaryPage?: ModelServicesSecondaryPage | undefined
  readonly surface: 'pane' | 'modal'
  readonly standaloneMode: boolean
  readonly workspaceMode: boolean
  readonly setHeaderActionsSeat?: (element: HTMLElement | null) => void
  readonly onClose?: () => void
  readonly actionsEnabled?: boolean
  readonly unresolvedTitle?: string
}) {
  const heading = modelServicesSecondaryPage?.title ?? title(router.route, snapshot, unresolvedTitle)
  const contributionId = router.route.kind === 'manager-content' ? router.route.id : undefined
  const contributionIcon = contributionId === undefined
    ? undefined
    : snapshot.settingsNavigationItems?.find(item => item.id === contributionId)?.icon
  const managerContentParent = router.route.kind === 'manager-content'
    ? model.managerContentPresentation?.(router.route.id, router.route.reference)?.parent
    : undefined
  const backRoute = modelServicesSecondaryPage === undefined
    ? managerHeaderBackRoute(router.route, managerContentParent, router.capture().at(-2))
    : undefined
  const onBack = () => {
    if (backRoute === undefined) return
    const previous = router.capture().at(-2)
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(backRoute)) router.back()
    else router.replace(backRoute)
  }
  return (
    <header className="cxr-header" data-manager-surface={surface}>
      <span className="cxr-header-seat">
        {modelServicesSecondaryPage !== undefined
          ? (
            <Button
              className="cxr-header-back"
              shape="square"
              variant="text"
              aria-label={managerCopy(snapshot.localization.locale, 'manager.back')}
              icon={<HostIcon token="back" />}
              onClick={modelServicesSecondaryPage.back}
            />
          )
          : backRoute !== undefined
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
        {modelServicesSecondaryPage === undefined
          ? (
            <ManagerBreadcrumbs
              route={router.route}
              navigate={router.navigate}
              heading={heading}
              model={model}
              snapshot={snapshot}
            />
          )
          : (
            <HostBreadcrumbs
              segments={[
                {
                  key: 'model-services',
                  label: title({ kind: 'primary', page: 'model-services' }, snapshot),
                  onActivate: modelServicesSecondaryPage.back,
                },
                { key: modelServicesSecondaryPage.id, label: modelServicesSecondaryPage.title },
              ]}
            />
          )}
      </div>
      <div className="cxr-titlebar-actions">
        <div className="cxr-titlebar-actions" ref={setHeaderActionsSeat} data-manager-page-header-actions="true" />
        {actionsEnabled && router.route.kind === 'primary' && router.route.page === 'model-services'
            && modelServicesSecondaryPage === undefined
          ? <ChatCreationDefaultsAction router={router} locale={snapshot.localization.locale} />
          : null}
        {!standaloneMode && !workspaceMode && surface === 'modal'
          ? (
            <Button
              className="cxr-titlebar-action"
              shape="square"
              variant="text"
              aria-label={managerCopy(snapshot.localization.locale, 'manager.close')}
              icon={<HostIcon token="close" />}
              onClick={() => onClose?.()}
            />
          )
          : null}
      </div>
    </header>
  )
}
