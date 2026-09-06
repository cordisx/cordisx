import { type CordisXIconToken } from '../../contracts.js'
import {
  createHostCollection,
  type HostCollectionItem,
  type HostCollectionStatus,
  type HostCollectionView,
} from '.././host-collection.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { type MarketplaceCatalogPlugin, type MarketplaceModel, searchMarketplaceCatalog } from '.././marketplace.js'
import { HostTooltipController } from '.././tooltips.js'
import { managerCopy, productLocale } from '.././ui-copy.js'
import { PublisherGrantClient } from './bridges.js'
import { create } from './dom.js'
import type { ManagerMenuState } from './interaction-state.js'
import { ManagerActionMenuItem, ManagerModel, ManagerRouteState, ManagerSnapshot } from './model.js'
import { createPluginIcon, marketplaceRankingDescription } from './widgets.js'

export interface MarketplaceListDependencies {
  document: Document
  tooltips: HostTooltipController
  mountPortal: <Element extends HTMLElement>(portal: Element) => () => void
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  importMarketplaceSourceFromClipboard: () => Promise<void>
  publisherGrantStatuses: Map<string, string>
  publisherGrantClient: PublisherGrantClient
  renderContent: () => void
  marketplace: MarketplaceModel
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
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
  marketplaceCertifiedOnly: boolean
  marketplaceOfficialOnly: boolean
  marketplaceQuery: string
  model: ManagerModel
  rememberListScroll: () => void
  mountHostCollection: (
    target: HTMLElement,
    options: Parameters<typeof createHostCollection>[1],
    decorate?: (root: HTMLElement) => void,
  ) => HostCollectionView
  menuState: Pick<
    ManagerMenuState,
    'closePluginActionMenu' | 'pluginActionMenuOpen' | 'pluginActionMenuContainsEvent' | 'repositionPluginActionMenu'
  >
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createMarketplaceList(dependencies: MarketplaceListDependencies) {
  const createMarketplaceTrustBadge = (
    dimension: 'official' | 'certified',
    label: string,
    tooltip: string,
  ): HTMLSpanElement => {
    const badge = create(dependencies.document, 'span', 'cxm-marketplace-trust-badge')
    badge.dataset.trustDimension = dimension
    badge.setAttribute('role', 'img')
    badge.setAttribute('aria-label', tooltip)
    badge.append(
      createManagerIcon(
        dependencies.document,
        dimension === 'official' ? 'marketplace-official' : 'marketplace-certified',
      ),
      create(dependencies.document, 'span', undefined, label),
    )
    dependencies.tooltips.attach(badge, () => tooltip, 'top')
    return badge
  }

  const openManagerActionMenu = (
    trigger: HTMLButtonElement,
    label: string,
    items: readonly ManagerActionMenuItem[],
  ): void => {
    dependencies.menuState.closePluginActionMenu(false)
    dependencies.tooltips.hide()
    const popup = create(dependencies.document, 'div', 'cxm-plugin-menu-popup')
    popup.dataset.managerActionMenu = label
    popup.setAttribute('role', 'menu')
    popup.setAttribute('aria-label', label)
    for (const item of items) {
      const action = create(dependencies.document, 'button', 'cxm-plugin-menu-item')
      action.type = 'button'
      action.dataset.managerMenuAction = item.id
      action.setAttribute('role', 'menuitem')
      action.disabled = item.disabled === true
      action.append(
        createManagerIcon(dependencies.document, item.icon),
        create(dependencies.document, 'span', undefined, item.label),
      )
      action.addEventListener('click', () => {
        dependencies.menuState.closePluginActionMenu(true)
        void item.invoke()
      })
      popup.append(action)
    }
    const unmount = dependencies.mountPortal(popup)
    trigger.setAttribute('aria-expanded', 'true')
    const closeMenu = (restoreFocus = false): void => {
      dependencies.menuState.pluginActionMenuOpen = false
      dependencies.menuState.pluginActionMenuContainsEvent = () => false
      dependencies.menuState.repositionPluginActionMenu = () => {}
      trigger.setAttribute('aria-expanded', 'false')
      unmount()
      if (dependencies.menuState.closePluginActionMenu === closeMenu) {
        dependencies.menuState.closePluginActionMenu = () => {}
      }
      if (restoreFocus && trigger.isConnected) trigger.focus()
    }
    const enabledItems =
      (): HTMLButtonElement[] => [...popup.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const positionMenu = (): void => {
      if (!popup.isConnected || !trigger.isConnected) return closeMenu(false)
      const triggerRect = trigger.getBoundingClientRect()
      const popupRect = popup.getBoundingClientRect()
      const view = dependencies.document.defaultView
      const edge = 8
      const left = Math.min(
        Math.max(edge, triggerRect.right - popupRect.width),
        Math.max(
          edge,
          (view?.innerWidth ?? dependencies.document.documentElement.clientWidth) - popupRect.width - edge,
        ),
      )
      const below = triggerRect.bottom + 6
      const top =
        below + popupRect.height <= (view?.innerHeight ?? dependencies.document.documentElement.clientHeight) - edge
          ? below
          : Math.max(edge, triggerRect.top - popupRect.height - 6)
      popup.style.left = `${Math.round(left)}px`
      popup.style.top = `${Math.round(top)}px`
    }
    popup.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
        return
      }
      const enabled = enabledItems()
      const current = enabled.indexOf(dependencies.document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown'
        ? enabled[(current + 1 + enabled.length) % enabled.length]
        : event.key === 'ArrowUp'
        ? enabled[(current - 1 + enabled.length) % enabled.length]
        : event.key === 'Home'
        ? enabled[0]
        : event.key === 'End'
        ? enabled.at(-1)
        : undefined
      if (next === undefined) return
      event.preventDefault()
      event.stopPropagation()
      next.focus()
    })
    dependencies.menuState.closePluginActionMenu = closeMenu
    dependencies.menuState.pluginActionMenuOpen = true
    dependencies.menuState.pluginActionMenuContainsEvent = event =>
      event.composedPath().some(item => item === popup || item === trigger)
    dependencies.menuState.repositionPluginActionMenu = positionMenu
    positionMenu()
    enabledItems()[0]?.focus()
  }

  const sourceMenuItems = (): readonly ManagerActionMenuItem[] => [
    {
      id: 'create',
      label: dependencies.copy('marketplace.source-menu.create'),
      icon: 'marketplace-source-add',
      invoke: () => dependencies.navigateRoute({ kind: 'marketplace-source', page: 'create' }),
    },
    {
      id: 'clipboard',
      label: dependencies.copy('marketplace.source-menu.clipboard'),
      icon: 'marketplace-source-copy',
      invoke: () => dependencies.importMarketplaceSourceFromClipboard(),
    },
    {
      id: 'manage',
      label: dependencies.copy('marketplace.source-menu.manage'),
      icon: 'marketplace-source-edit',
      invoke: () => dependencies.navigateRoute({ kind: 'marketplace-source', page: 'index' }),
    },
  ]

  const refreshPublisherGrantStatus = async (plugin: MarketplaceCatalogPlugin): Promise<void> => {
    if (plugin.commerce === undefined || dependencies.publisherGrantStatuses.get(plugin.identity) === 'loading') return
    dependencies.publisherGrantStatuses.set(plugin.identity, 'loading')
    try {
      const value = await dependencies.publisherGrantClient.request('status', {
        pluginId: plugin.id,
        version: plugin.version,
      }) as {
        status?: unknown
      }
      const status = typeof value?.status === 'string' ? value.status : 'unavailable'
      if (dependencies.publisherGrantStatuses.get(plugin.identity) !== status) {
        dependencies.publisherGrantStatuses.set(plugin.identity, status)
        dependencies.renderContent()
      }
    } catch {
      if (dependencies.publisherGrantStatuses.get(plugin.identity) !== 'unavailable') {
        dependencies.publisherGrantStatuses.set(plugin.identity, 'unavailable')
        dependencies.renderContent()
      }
    }
  }

  const renderMarketplaceList = (managerSnapshot: ManagerSnapshot): void => {
    const snapshot = dependencies.marketplace.snapshot()
    dependencies.setHeading(dependencies.copy('marketplace.heading'), managerSnapshot, { icon: 'marketplace' })
    dependencies.content.dataset.marketplaceDiscovery = 'true'
    const page = create(dependencies.document, 'section', 'cxm-marketplace-discovery')
    page.dataset.marketplaceDiscoveryPage = 'true'
    const tools = create(dependencies.document, 'div', 'cxm-marketplace-discovery-tools')
    const toolbar = create(dependencies.document, 'div', 'cxm-toolbar')
    const sourceMenu = dependencies.managerIconAction(
      'marketplace-source-add',
      dependencies.copy('marketplace.source-menu-label'),
      {
        className: 'cxm-toolbar-icon-action',
        description: dependencies.copy('marketplace.source-menu-description'),
      },
    )
    sourceMenu.dataset.marketplaceSourceMenu = 'true'
    sourceMenu.setAttribute('aria-haspopup', 'menu')
    sourceMenu.setAttribute('aria-expanded', 'false')
    sourceMenu.addEventListener('click', event => {
      event.stopPropagation()
      if (sourceMenu.getAttribute('aria-expanded') === 'true') dependencies.menuState.closePluginActionMenu(true)
      else openManagerActionMenu(sourceMenu, dependencies.copy('marketplace.source-menu-label'), sourceMenuItems())
    })
    const certifiedFilter = create(dependencies.document, 'button', 'cxm-marketplace-filter')
    certifiedFilter.type = 'button'
    certifiedFilter.dataset.marketplaceCertifiedOnly = 'true'
    certifiedFilter.setAttribute('aria-pressed', String(dependencies.marketplaceCertifiedOnly))
    certifiedFilter.setAttribute(
      'aria-label',
      dependencies.marketplaceCertifiedOnly
        ? dependencies.copy('marketplace.filter-all')
        : dependencies.copy('marketplace.filter-certified'),
    )
    certifiedFilter.append(
      createManagerIcon(dependencies.document, 'marketplace-certified', undefined, {
        state: dependencies.marketplaceCertifiedOnly ? 'active' : 'default',
      }),
      create(dependencies.document, 'span', undefined, dependencies.copy('marketplace.filter-certified-only')),
    )
    certifiedFilter.addEventListener('click', () => {
      dependencies.marketplaceCertifiedOnly = !dependencies.marketplaceCertifiedOnly
      dependencies.renderContent()
      dependencies.content.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')?.focus()
    })
    const officialFilter = create(dependencies.document, 'button', 'cxm-marketplace-filter')
    officialFilter.type = 'button'
    officialFilter.dataset.marketplaceOfficialOnly = 'true'
    officialFilter.setAttribute('aria-pressed', String(dependencies.marketplaceOfficialOnly))
    officialFilter.setAttribute(
      'aria-label',
      dependencies.marketplaceOfficialOnly
        ? dependencies.copy('marketplace.filter-all')
        : dependencies.copy('marketplace.filter-official'),
    )
    officialFilter.append(
      createManagerIcon(dependencies.document, 'marketplace-official', undefined, {
        state: dependencies.marketplaceOfficialOnly ? 'active' : 'default',
      }),
      create(dependencies.document, 'span', undefined, dependencies.copy('marketplace.filter-official-only')),
    )
    officialFilter.addEventListener('click', () => {
      dependencies.marketplaceOfficialOnly = !dependencies.marketplaceOfficialOnly
      dependencies.renderContent()
      dependencies.content.querySelector<HTMLButtonElement>('[data-marketplace-official-only]')?.focus()
    })
    const ranked = searchMarketplaceCatalog(snapshot.plugins, {
      query: dependencies.marketplaceQuery,
      currentLocale: managerSnapshot.localization.locale,
      certifiedOnly: dependencies.marketplaceCertifiedOnly,
      officialOnly: dependencies.marketplaceOfficialOnly,
      ...(dependencies.model.marketplaceEligibility === undefined
        ? {}
        : { eligibility: plugin => dependencies.model.marketplaceEligibility!(plugin) }),
    })
    const results = create(dependencies.document, 'div', 'cxm-marketplace-results')
    results.dataset.marketplaceResultsScroll = 'true'
    const items: HostCollectionItem[] = ranked.map(({ plugin, projection: metadata, ranking }) => {
      const trustLabels = [
        ...(plugin.official === undefined ? [] : [dependencies.copy('marketplace.official')]),
        ...(plugin.certification === undefined ? [] : [dependencies.copy('marketplace.certified')]),
      ]
      const status: HostCollectionStatus | undefined = trustLabels.length === 0
        ? undefined
        : {
          label: trustLabels.join('、'),
          tone: plugin.certification === undefined ? 'neutral' : 'success',
          detail: trustLabels.join('、'),
        }
      return {
        id: plugin.identity,
        title: metadata.name,
        description: metadata.description,
        machineId: plugin.id,
        searchText: [
          plugin.version,
          metadata.feedName,
          plugin.identity,
          plugin.license,
          ...metadata.keywords,
          ...metadata.authors.map(author => author.name),
        ],
        icon: () => createPluginIcon(dependencies.document, metadata.name, plugin.icon),
        ...(plugin.icon === undefined ? {} : { iconKind: 'artwork' as const }),
        ...(status === undefined ? {} : { status }),
        openLabel: `${dependencies.copy('marketplace.open')} · ${metadata.name}`,
        onOpen: () => {
          dependencies.rememberListScroll()
          void dependencies.navigateRoute({ kind: 'marketplace', identity: plugin.identity, facet: 'overview' })
        },
      }
    })
    const view = dependencies.mountHostCollection(results, {
      id: 'marketplace',
      label: dependencies.copy('marketplace.collection-label'),
      items,
      search: {
        label: dependencies.copy('marketplace.search-label'),
        placeholder: dependencies.copy('marketplace.search-placeholder'),
        clearLabel: dependencies.copy('marketplace.search-clear'),
        query: dependencies.marketplaceQuery,
        onQueryChange: value => {
          dependencies.marketplaceQuery = value
          dependencies.renderContent()
          const replacement = dependencies.content.querySelector<HTMLInputElement>(
            '[data-collection-search="marketplace"]',
          )
          replacement?.focus()
          replacement?.setSelectionRange(value.length, value.length)
        },
      },
      emptyLabel: snapshot.sources.length === 0
        ? dependencies.copy('marketplace.empty-no-sources')
        : dependencies.copy('marketplace.no-plugins'),
      noMatchesLabel: dependencies.copy('marketplace.no-matches'),
    }, root => {
      for (const item of root.querySelectorAll<HTMLElement>('[data-collection-item]')) {
        const rankedItem = ranked.find(entry => entry.plugin.identity === item.dataset.collectionItem)
        if (rankedItem === undefined) continue
        const { plugin, ranking } = rankedItem
        item.dataset.marketplacePlugin = plugin.id
        item.dataset.marketplaceOfficial = String(plugin.official !== undefined)
        item.dataset.marketplaceCertified = String(plugin.certification !== undefined)
        item.dataset.marketplaceRankingTier = ranking.textTier
        item.dataset.marketplaceRankingOfficialPriority = String(ranking.officialPriority)
        item.dataset.marketplaceRankingExplanation = marketplaceRankingDescription(ranking)
        const title = item.querySelector<HTMLElement>('.cxc-title')
        if (title !== null && (plugin.official !== undefined || plugin.certification !== undefined)) {
          const titleRow = create(dependencies.document, 'span', 'cxm-marketplace-title-row')
          const badges = create(dependencies.document, 'span', 'cxm-marketplace-trust-badges')
          if (plugin.official !== undefined) {
            badges.append(createMarketplaceTrustBadge(
              'official',
              dependencies.copy('marketplace.official'),
              productLocale(managerSnapshot.localization.locale) === 'zh-CN'
                ? 'CordisX 官方发布者身份；只影响 Marketplace 身份、筛选与排序，不改变权限。'
                : 'CordisX Official publisher identity. It affects Marketplace identity, filtering, and ordering only, never permissions.',
            ))
          }
          if (plugin.certification !== undefined) {
            badges.append(createMarketplaceTrustBadge(
              'certified',
              dependencies.copy('marketplace.certified'),
              productLocale(managerSnapshot.localization.locale) === 'zh-CN'
                ? 'CordisX 已审核当前版本的明确制品；不参与排序，也不代表绝对安全。'
                : 'CordisX reviewed this exact versioned artifact. It does not affect ordering or guarantee absolute safety.',
            ))
          }
          title.replaceWith(titleRow)
          titleRow.append(title, badges)
        }
      }
    })
    const search = view.element.querySelector<HTMLElement>('.cxc-search')
    if (search !== null) toolbar.append(search)
    toolbar.append(sourceMenu)
    const filters = create(dependencies.document, 'div', 'cxm-marketplace-filter-row')
    filters.setAttribute('aria-label', '插件商店筛选')
    filters.append(officialFilter, certifiedFilter)
    tools.append(toolbar, filters)
    page.append(tools, results)
    dependencies.content.append(page)
  }
  return { refreshPublisherGrantStatus, renderMarketplaceList }
}
