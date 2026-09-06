import { sortManagerSettingsNavigationItems } from '.././manager-settings-navigation.js'
import { type MarketplaceModel, projectMarketplacePlugin, projectMarketplaceSource } from '.././marketplace.js'
import { managerCopy } from '.././ui-copy.js'
import { capabilityPresentation } from './authorization.js'
import {
  ExtensionPointDetailTab,
  LocalTabIcon,
  ManagerBreadcrumbSegment,
  ManagerModel,
  ManagerPageRoute,
  ManagerRouteState,
  ManagerSettingsNavigationItemSnapshot,
  ManagerSnapshot,
  ManagerTab,
  MarketplaceDetailTab,
  PluginDetailTab,
} from './model.js'
import {
  EXTENSION_POINT_DETAIL_TABS,
  LocalizedTab,
  MANAGER_SETTINGS_FALLBACK,
  MARKETPLACE_DETAIL_TABS,
  PLUGIN_DETAIL_TABS,
} from './presentation.js'

export interface RouteProjectionDependencies {
  routeState: ManagerRouteState
  localizeTabs: <T extends string>(
    items: readonly LocalizedTab<T>[],
  ) => readonly { readonly id: T; readonly label: string; readonly icon: LocalTabIcon }[]
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  marketplace: MarketplaceModel
  model: ManagerModel
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createRouteProjection(dependencies: RouteProjectionDependencies) {
  const activePrimary = (route: ManagerRouteState = dependencies.routeState): string => {
    if (route.kind === 'primary') return route.primary
    if (route.kind === 'manager-content') return `manager-content:${route.id}`
    if (route.kind === 'plugin' || route.kind === 'permission') return 'plugins'
    if (route.kind === 'extension-point') return 'extension-points'
    if (route.kind === 'route' || route.kind === 'page') return 'routes'
    if (route.kind === 'marketplace' || route.kind === 'marketplace-source') return 'marketplace'
    return 'plugins'
  }

  const currentSettingsTab = (): string =>
    dependencies.routeState.kind === 'settings'
      ? dependencies.routeState.tabId
      : MANAGER_SETTINGS_FALLBACK

  const settingsNavigationItems = (snapshot: ManagerSnapshot): readonly ManagerSettingsNavigationItemSnapshot[] => (
    sortManagerSettingsNavigationItems(snapshot.settingsNavigationItems ?? [])
  )

  const pluginFacet = (id: PluginDetailTab): ReturnType<typeof dependencies.localizeTabs>[number] => (
    dependencies.localizeTabs(PLUGIN_DETAIL_TABS).find(item => item.id === id)
      ?? dependencies.localizeTabs(PLUGIN_DETAIL_TABS)[0]!
  )
  const extensionPointFacet = (id: ExtensionPointDetailTab): ReturnType<typeof dependencies.localizeTabs>[number] => (
    dependencies.localizeTabs(EXTENSION_POINT_DETAIL_TABS).find(item => item.id === id)
      ?? dependencies.localizeTabs(EXTENSION_POINT_DETAIL_TABS)[0]!
  )
  const marketplaceFacet = (id: MarketplaceDetailTab): ReturnType<typeof dependencies.localizeTabs>[number] => (
    dependencies.localizeTabs(MARKETPLACE_DETAIL_TABS).find(item => item.id === id)
      ?? dependencies.localizeTabs(MARKETPLACE_DETAIL_TABS)[0]!
  )

  const resolvePageRoute = (snapshot: ManagerSnapshot): ManagerPageRoute => {
    const route = dependencies.routeState
    const primary = activePrimary()
    const primaryLabels: Readonly<Record<ManagerTab, string>> = {
      plugins: dependencies.copy('manager.nav.plugins'),
      'extension-points': dependencies.copy('manager.nav.extension-points'),
      routes: dependencies.copy('manager.nav.routes'),
      marketplace: dependencies.copy('manager.nav.marketplace'),
      settings: dependencies.copy('manager.nav.plugins'),
      about: dependencies.copy('manager.nav.about'),
    }
    const root = (id: ManagerTab): ManagerBreadcrumbSegment => ({
      id: `primary:${id}`,
      label: primaryLabels[id],
      target: { kind: 'primary', primary: id },
    })
    if (route.kind === 'primary') {
      return {
        id: `primary:${route.primary}`,
        primary,
        segments: [{ id: `primary:${route.primary}`, label: primaryLabels[route.primary] }],
      }
    }
    if (route.kind === 'plugin') {
      const plugin = snapshot.plugins.find(item => item.id === route.pluginId)
      const facet = pluginFacet(route.facet)
      return {
        id: `plugin:${route.pluginId}:${route.facet}`,
        primary,
        segments: [
          root('plugins'),
          {
            id: `plugin:${route.pluginId}`,
            label: plugin?.name ?? route.pluginId,
            target: { kind: 'plugin', pluginId: route.pluginId, facet: 'readme' },
          },
          { id: `plugin:${route.pluginId}:facet:${route.facet}`, label: facet.label },
        ],
      }
    }
    if (route.kind === 'permission') {
      const plugin = snapshot.plugins.find(item => item.id === route.pluginId)
      return {
        id: `plugin:${route.pluginId}:permission:${route.fingerprint}`,
        primary,
        segments: [
          root('plugins'),
          {
            id: `plugin:${route.pluginId}`,
            label: plugin?.name ?? route.pluginId,
            target: { kind: 'plugin', pluginId: route.pluginId, facet: 'readme' },
          },
          {
            id: `plugin:${route.pluginId}:facet:permissions`,
            label: pluginFacet('permissions').label,
            target: { kind: 'plugin', pluginId: route.pluginId, facet: 'permissions' },
          },
          {
            id: `plugin:${route.pluginId}:permission:${route.fingerprint}`,
            label: capabilityPresentation(route.capability).name,
          },
        ],
      }
    }
    if (route.kind === 'extension-point') {
      const point = snapshot.extensionPoints?.points.find(item => item.id === route.pointId)
      const facet = extensionPointFacet(route.facet)
      return {
        id: `extension-point:${route.pointId}:${route.facet}`,
        primary,
        segments: [
          root('extension-points'),
          {
            id: `extension-point:${route.pointId}`,
            label: point?.titleProjection.text ?? route.pointId,
            target: { kind: 'extension-point', pointId: route.pointId, facet: 'usage' },
          },
          { id: `extension-point:${route.pointId}:facet:${route.facet}`, label: facet.label },
        ],
      }
    }
    if (route.kind === 'route') {
      const routeSnapshot = snapshot.navigation.routes.find(item => item.qualifiedId === route.qualifiedId)
      return {
        id: `route:${route.qualifiedId}`,
        primary,
        segments: [root('routes'), {
          id: `route:${route.qualifiedId}`,
          label: routeSnapshot?.productMetadata.title ?? route.qualifiedId,
        }],
      }
    }
    if (route.kind === 'page') {
      const page = snapshot.navigation.pages.find(item => item.qualifiedId === route.qualifiedId)
      return {
        id: `page:${route.qualifiedId}`,
        primary,
        segments: [root('routes'), {
          id: `page:${route.qualifiedId}`,
          label: page?.productMetadata.title ?? route.qualifiedId,
        }],
      }
    }
    if (route.kind === 'marketplace') {
      const plugin = dependencies.marketplace.snapshot().plugins.find(item => item.identity === route.identity)
      const projection = plugin === undefined
        ? undefined
        : projectMarketplacePlugin(plugin, snapshot.localization.locale)
      const facet = marketplaceFacet(route.facet)
      return {
        id: `marketplace:${route.identity}:${route.facet}`,
        primary,
        segments: [
          root('marketplace'),
          {
            id: `marketplace:${route.identity}`,
            label: projection?.name ?? '已移除的插件',
            target: { kind: 'marketplace', identity: route.identity, facet: 'overview' },
          },
          { id: `marketplace:${route.identity}:facet:${route.facet}`, label: facet.label },
        ],
      }
    }
    if (route.kind === 'marketplace-source') {
      const source = route.url === undefined
        ? undefined
        : dependencies.marketplace.snapshot().sourceStates.find(item => item.url === route.url)
      const projection = source === undefined
        ? undefined
        : projectMarketplaceSource(source, snapshot.localization.locale)
      const sourceRoot: ManagerBreadcrumbSegment = {
        id: 'marketplace-sources',
        label: managerCopy(snapshot.localization.locale, 'marketplace.source.index-heading'),
        target: { kind: 'marketplace-source', page: 'index' },
      }
      if (route.page === 'index') {
        return {
          id: 'marketplace-sources',
          primary,
          segments: [root('marketplace'), { id: sourceRoot.id, label: sourceRoot.label }],
        }
      }
      if (route.page === 'create') {
        return {
          id: 'marketplace-source:create',
          primary,
          segments: [root('marketplace'), sourceRoot, {
            id: 'marketplace-source:create',
            label: managerCopy(snapshot.localization.locale, 'marketplace.source.create'),
          }],
        }
      }
      return {
        id: `marketplace-source:edit:${route.url ?? ''}`,
        primary,
        segments: [
          root('marketplace'),
          sourceRoot,
          {
            id: `marketplace-source:edit:${route.url ?? ''}`,
            label: projection?.name ?? managerCopy(snapshot.localization.locale, 'marketplace.source.edit-heading'),
          },
        ],
      }
    }
    if (route.kind === 'manager-content') {
      const item = settingsNavigationItems(snapshot).find(candidate => candidate.id === route.id)
      const projection = dependencies.model.managerContentPresentation?.(route.id, route.reference)
      return {
        id: `manager-content:${route.id}:${route.reference.id}`,
        primary,
        segments: [
          root('plugins'),
          {
            id: `manager-content:${route.id}`,
            label: item?.pageTitle ?? route.id,
            target: { kind: 'manager-content', id: route.id, reference: item?.route ?? route.reference },
          },
          ...(projection?.parent === undefined
            ? []
            : [{ id: `manager-content:${route.id}:${route.reference.id}`, label: projection.title }]),
        ],
      }
    }
    return { id: 'plugins', primary: 'plugins', segments: [{ id: 'primary:plugins', label: primaryLabels.plugins }] }
  }

  const normalizeRoute = (
    snapshot: ManagerSnapshot,
    candidate: ManagerRouteState = dependencies.routeState,
  ): ManagerRouteState => {
    if (candidate.kind === 'plugin' || candidate.kind === 'permission') {
      const plugin = snapshot.plugins.find(item => item.id === candidate.pluginId)
      if (plugin === undefined) return { kind: 'primary', primary: 'plugins' }
      if (candidate.kind === 'permission') {
        const declared = snapshot.permissions.some(item => (
          item.identity.id === plugin.id
          && item.identity.source === plugin.source
          && item.capability === candidate.capability
        ))
        if (!declared) return { kind: 'plugin', pluginId: plugin.id, facet: 'permissions' }
      }
    }
    if (
      candidate.kind === 'extension-point'
      && !snapshot.extensionPoints?.points.some(item => item.id === candidate.pointId)
    ) {
      return { kind: 'primary', primary: 'extension-points' }
    }
    if (
      candidate.kind === 'route' && !snapshot.navigation.routes.some(item => item.qualifiedId === candidate.qualifiedId)
    ) {
      return { kind: 'primary', primary: 'routes' }
    }
    if (
      candidate.kind === 'page' && !snapshot.navigation.pages.some(item => item.qualifiedId === candidate.qualifiedId)
    ) {
      return { kind: 'primary', primary: 'routes' }
    }
    if (candidate.kind === 'marketplace') {
      const marketplaceSnapshot = dependencies.marketplace.snapshot()
      if (
        !marketplaceSnapshot.loading && !marketplaceSnapshot.plugins.some(item => item.identity === candidate.identity)
      ) {
        return { kind: 'primary', primary: 'marketplace' }
      }
    }
    if (candidate.kind === 'marketplace-source') {
      if (candidate.page === 'edit') {
        if (
          candidate.url === undefined
          || !dependencies.marketplace.snapshot().sourceRecords.some(item => item.url === candidate.url)
        ) {
          return { kind: 'marketplace-source', page: 'index' }
        }
      } else if (candidate.url !== undefined) {
        return { kind: 'marketplace-source', page: candidate.page }
      }
    }
    if (candidate.kind === 'settings') return { kind: 'primary', primary: 'plugins' }
    if (
      candidate.kind === 'manager-content'
      && (!settingsNavigationItems(snapshot).some(item => item.id === candidate.id)
        || (dependencies.model.managerContentPresentation !== undefined
          && dependencies.model.managerContentPresentation(candidate.id, candidate.reference) === undefined))
    ) {
      return { kind: 'primary', primary: 'plugins' }
    }
    return candidate
  }

  const routeKey = (route: ManagerRouteState): string => JSON.stringify(route)
  return { activePrimary, currentSettingsTab, settingsNavigationItems, resolvePageRoute, normalizeRoute, routeKey }
}
