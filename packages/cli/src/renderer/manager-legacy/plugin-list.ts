import { type CordisXIconToken } from '../../contracts.js'
import {
  createHostCollection,
  type HostCollectionAction,
  type HostCollectionItem,
  type HostCollectionView,
} from '.././host-collection.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { managerCopy } from '.././ui-copy.js'
import { create } from './dom.js'
import type { ManagerMenuState } from './interaction-state.js'
import {
  ManagerModel,
  ManagerPluginSnapshot,
  ManagerPluginStatus,
  ManagerRouteState,
  ManagerSnapshot,
} from './model.js'
import { createPluginIcon, pluginCollectionStatus } from './widgets.js'

export interface PluginListDependencies {
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  content: HTMLDivElement
  managerIconAction: (
    icon: ManagerIconToken,
    label: string,
    options?: {
      readonly className?: string
      readonly disabled?: boolean
      readonly description?: string
      readonly pressed?: boolean
    },
  ) => HTMLButtonElement
  lifecycleInstallBusy: boolean
  lifecycleBusy: Map<string, ManagerPluginStatus>
  model: ManagerModel
  runLocalPackageInstall: (invoker?: HTMLElement) => Promise<void>
  favoritePlugins: (snapshot: ManagerSnapshot) => Set<string>
  packageOperationUnavailableReason: (snapshot: ManagerSnapshot, plugin: ManagerPluginSnapshot) => string | undefined
  sourceUnavailableReason: (plugin: ManagerPluginSnapshot) => string | undefined
  document: Document
  runPluginLifecycle: (
    snapshot: ManagerSnapshot,
    plugin: ManagerPluginSnapshot,
    operation: 'enable' | 'disable' | 'reload' | 'uninstall',
    restoreMenuFocus?: boolean,
  ) => Promise<void>
  setFavorite: (snapshot: ManagerSnapshot, pluginId: string, favorite: boolean) => void
  renderContent: () => void
  sharePlugin: (plugin: ManagerPluginSnapshot) => Promise<void>
  operationError: string | undefined
  openPluginSource: (plugin: ManagerPluginSnapshot) => void
  rememberListScroll: () => void
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  mountHostCollection: (
    target: HTMLElement,
    options: Parameters<typeof createHostCollection>[1],
    decorate?: (root: HTMLElement) => void,
  ) => HostCollectionView
  pluginQuery: string
  favoritePluginIds: Set<string>
  menuState: Pick<ManagerMenuState, 'pendingPluginActionFocus' | 'pendingPluginMenuFocus'>
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createPluginList(dependencies: PluginListDependencies) {
  const renderPluginList = (snapshot: ManagerSnapshot): void => {
    dependencies.setHeading(dependencies.copy('manager.nav.plugins'), snapshot, { icon: 'plugins' })
    dependencies.content.dataset.managerListPage = 'true'
    const install = dependencies.managerIconAction(
      'import-plugin',
      dependencies.lifecycleInstallBusy
        ? dependencies.copy('plugins.install-checking')
        : dependencies.copy('plugins.install'),
      {
        className: 'cxm-toolbar-icon-action',
        disabled: dependencies.lifecycleInstallBusy
          || dependencies.lifecycleBusy.size > 0
          || snapshot.pluginLifecycle?.operationsAvailable !== true
          || dependencies.model.requestPluginLifecycle === undefined,
      },
    )
    install.dataset.installLocalPlugin = 'true'
    install.dataset.importLocalPlugin = 'true'
    install.addEventListener('click', () => {
      void dependencies.runLocalPackageInstall(install)
    })

    const favorites = dependencies.favoritePlugins(snapshot)
    const plugins = [...snapshot.plugins].sort((left, right) =>
      Number(favorites.has(right.id)) - Number(favorites.has(left.id))
    )
    const demoDescriptionKeys: Readonly<Partial<Record<string, Parameters<typeof managerCopy>[1]>>> = {
      'slot-showcase': 'plugins.demo.slot-showcase-description',
      'hello-toolbar': 'plugins.demo.hello-toolbar-description',
      'form-schema-gallery': 'plugins.demo.form-schema-gallery-description',
    }
    const items: HostCollectionItem[] = plugins.map(plugin => {
      const status = dependencies.lifecycleBusy.get(plugin.id) ?? plugin.status
      const packageOperationReason = dependencies.packageOperationUnavailableReason(snapshot, plugin)
      const managed = packageOperationReason === undefined
      const reloadManaged = managed || plugin.developmentReloadAvailable === true
      const globallyBusy = dependencies.lifecycleInstallBusy || dependencies.lifecycleBusy.size > 0
      const enable = plugin.status === 'configured-disabled'
      const toggleLabel = enable ? dependencies.copy('plugins.enable') : dependencies.copy('plugins.disable')
      const toggleDisabled = !managed || globallyBusy || (plugin.status !== 'active' && !enable)
      const sourceReason = dependencies.sourceUnavailableReason(plugin)
      const sourceActionReason = sourceReason === undefined ? undefined : dependencies.copy('status.unavailable')
      const favorite = favorites.has(plugin.id)
      const toggleReason = toggleDisabled
        ? (!managed
          ? dependencies.copy('status.unavailable')
          : globallyBusy
          ? dependencies.copy('plugins.operation-busy')
          : dependencies.copy(enable ? 'plugins.enable-unavailable' : 'plugins.disable-unavailable'))
        : undefined
      const reloadReason = !reloadManaged
        ? dependencies.copy('status.unavailable')
        : globallyBusy
        ? dependencies.copy('plugins.operation-busy')
        : plugin.status === 'active'
        ? undefined
        : dependencies.copy('plugins.reload-unavailable')
      const uninstallReason = !managed
        ? dependencies.copy('status.unavailable')
        : (globallyBusy ? dependencies.copy('plugins.operation-busy') : undefined)
      const actions: HostCollectionAction[] = [
        {
          id: enable ? 'enable' : 'disable',
          label: toggleLabel,
          placement: 'direct',
          priority: 1,
          icon: () => createManagerIcon(dependencies.document, enable ? 'enable-plugin' : 'disable-plugin'),
          disabled: toggleDisabled,
          ...(toggleReason === undefined ? {} : { unavailableReason: toggleReason }),
          onInvoke: () => {
            void dependencies.runPluginLifecycle(snapshot, plugin, enable ? 'enable' : 'disable')
          },
        },
        {
          id: 'favorite',
          label: favorite ? dependencies.copy('plugins.unfavorite') : dependencies.copy('plugins.favorite'),
          placement: 'direct',
          priority: 2,
          icon: () => createManagerIcon(dependencies.document, favorite ? 'favorite-active' : 'favorite'),
          onInvoke: () => {
            dependencies.menuState.pendingPluginActionFocus = { pluginId: plugin.id, actionId: 'favorite' }
            dependencies.setFavorite(snapshot, plugin.id, !favorite)
            dependencies.renderContent()
          },
        },
        {
          id: 'reload',
          label: dependencies.copy('plugins.reload'),
          placement: 'direct',
          priority: 3,
          icon: () => createManagerIcon(dependencies.document, 'reload-plugin'),
          disabled: !reloadManaged || globallyBusy || plugin.status !== 'active',
          ...(reloadReason === undefined ? {} : { unavailableReason: reloadReason }),
          onInvoke: () => {
            void dependencies.runPluginLifecycle(snapshot, plugin, 'reload')
          },
        },
        {
          id: 'share',
          label: sourceReason === undefined
            ? dependencies.copy('plugins.share')
            : dependencies.copy('plugins.share-unavailable'),
          placement: 'overflow',
          icon: () => createManagerIcon(dependencies.document, 'share-plugin'),
          disabled: sourceReason !== undefined,
          ...(sourceActionReason === undefined ? {} : { unavailableReason: sourceActionReason }),
          onInvoke: () => {
            void dependencies.sharePlugin(plugin)
              .catch(error => {
                dependencies.operationError = error instanceof Error ? error.message : String(error)
              })
              .finally(() => {
                dependencies.menuState.pendingPluginMenuFocus = plugin.id
                dependencies.renderContent()
                queueMicrotask(() => {
                  const card = [...dependencies.content.querySelectorAll<HTMLElement>('[data-plugin-card]')]
                    .find(candidate => candidate.dataset.pluginCard === plugin.id)
                  card?.querySelector<HTMLElement>('.cxc-menu-trigger')?.focus()
                })
              })
          },
        },
        {
          id: 'source',
          label: sourceReason === undefined
            ? dependencies.copy('plugins.open-source')
            : dependencies.copy('plugins.open-source-unavailable'),
          placement: 'overflow',
          icon: () => createManagerIcon(dependencies.document, 'authors-source'),
          disabled: sourceReason !== undefined,
          ...(sourceActionReason === undefined ? {} : { unavailableReason: sourceActionReason }),
          onInvoke: () => {
            dependencies.openPluginSource(plugin)
          },
        },
        {
          id: 'diagnostics',
          label: dependencies.copy('plugins.diagnostics'),
          placement: 'overflow',
          icon: () => createManagerIcon(dependencies.document, 'diagnostics'),
          onInvoke: () => {
            dependencies.rememberListScroll()
            void dependencies.navigateRoute({ kind: 'plugin', pluginId: plugin.id, facet: 'logs' })
          },
        },
        {
          id: 'uninstall',
          label: managed ? dependencies.copy('plugins.uninstall') : dependencies.copy('plugins.uninstall-unavailable'),
          placement: 'overflow',
          tone: 'danger',
          icon: () => createManagerIcon(dependencies.document, 'uninstall-plugin'),
          disabled: !managed || globallyBusy,
          ...(uninstallReason === undefined ? {} : { unavailableReason: uninstallReason }),
          onInvoke: () => {
            void dependencies.runPluginLifecycle(snapshot, plugin, 'uninstall', true)
          },
        },
      ]
      const visibleActions = actions.filter(action => action.placement === 'direct' || action.disabled !== true)
      const registrations = snapshot.registrations.filter(item => item.owner === plugin.id)
      const demoDescriptionKey = demoDescriptionKeys[plugin.id]
      return {
        id: plugin.id,
        title: plugin.name,
        description: demoDescriptionKey === undefined
          ? plugin.description ?? dependencies.copy('plugins.local-description')
          : dependencies.copy(demoDescriptionKey),
        machineId: plugin.id,
        searchText: [plugin.source, ...plugin.inject, ...registrations.flatMap(item => [item.surface, item.id])],
        icon: () => createPluginIcon(dependencies.document, plugin.name, plugin.icon),
        ...(plugin.icon === undefined ? {} : { iconKind: 'artwork' as const }),
        status: pluginCollectionStatus(plugin, status, snapshot.localization.locale),
        actions: visibleActions,
        openLabel: `${dependencies.copy('plugins.open')} · ${plugin.name}`,
        onOpen: () => {
          dependencies.rememberListScroll()
          dependencies.operationError = undefined
          void dependencies.navigateRoute({ kind: 'plugin', pluginId: plugin.id, facet: 'readme' })
        },
      }
    })
    const view = dependencies.mountHostCollection(dependencies.content, {
      id: 'plugins',
      label: dependencies.copy('plugins.collection-label'),
      items,
      search: {
        label: dependencies.copy('plugins.search-label'),
        placeholder: dependencies.copy('plugins.search-placeholder'),
        clearLabel: dependencies.copy('plugins.search-clear'),
        query: dependencies.pluginQuery,
        onQueryChange: value => {
          dependencies.pluginQuery = value
        },
      },
      emptyLabel: dependencies.copy('plugins.empty'),
      noMatchesLabel: dependencies.copy('plugins.no-matches'),
      moreLabel: dependencies.copy('plugins.more-actions'),
    }, root => {
      for (const item of root.querySelectorAll<HTMLElement>('[data-collection-item]')) {
        const pluginId = item.dataset.collectionItem
        if (pluginId === undefined) continue
        item.dataset.pluginCard = pluginId
        item.dataset.pluginMenu = pluginId
        const primary = item.querySelector<HTMLButtonElement>('[data-collection-open]')
        if (primary !== null) {
          primary.dataset.pluginId = pluginId
          primary.dataset.pluginPrimary = pluginId
        }
        for (const action of item.querySelectorAll<HTMLButtonElement>('.cxc-action[data-collection-action]')) {
          action.dataset.pluginAction = action.dataset.collectionAction
        }
        const favorite = item.querySelector<HTMLButtonElement>('[data-collection-action="favorite"]')
        if (favorite !== null) {
          favorite.setAttribute('aria-pressed', String(dependencies.favoritePluginIds.has(pluginId)))
        }
      }
    })
    view.element.classList.add('cxm-fixed-list-collection')
    const search = view.element.querySelector<HTMLElement>('.cxc-search')
    if (search !== null) {
      const toolbar = create(dependencies.document, 'div', 'cxm-toolbar')
      search.replaceWith(toolbar)
      toolbar.append(search, install)
    }
    if (dependencies.operationError !== undefined) {
      view.element.before(create(dependencies.document, 'div', 'cxm-error', dependencies.operationError))
    }
    if (dependencies.menuState.pendingPluginMenuFocus !== undefined) {
      const pluginId = dependencies.menuState.pendingPluginMenuFocus
      dependencies.menuState.pendingPluginMenuFocus = undefined
      const card = [...view.element.querySelectorAll<HTMLElement>('[data-plugin-card]')]
        .find(candidate => candidate.dataset.pluginCard === pluginId)
      card?.querySelector<HTMLElement>('.cxc-menu-trigger')?.focus()
    }
    if (dependencies.menuState.pendingPluginActionFocus !== undefined) {
      const focus = dependencies.menuState.pendingPluginActionFocus
      dependencies.menuState.pendingPluginActionFocus = undefined
      const card = [...view.element.querySelectorAll<HTMLElement>('[data-plugin-card]')]
        .find(candidate => candidate.dataset.pluginCard === focus.pluginId)
      const action = [...(card?.querySelectorAll<HTMLElement>('[data-collection-action]') ?? [])]
        .find(candidate => candidate.dataset.collectionAction === focus.actionId)
      action?.focus()
    }
  }
  return { renderPluginList }
}
