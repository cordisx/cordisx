import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { HostBreadcrumbs } from '../renderer/host-ui/HostBreadcrumbs.js'
import { HostIcon } from '../renderer/host-ui/HostIcon.js'
import { SearchToolbar } from '../renderer/host-ui/SearchToolbar.js'
import { HostThemeProjection } from '../renderer/host-theme.js'
import type { ManagerSettingsNavigationItemSnapshot, ManagerSnapshot } from '../renderer/manager.js'
import { Navigation } from '../renderer/manager/components/Navigation.js'
import { PluginIdentityIcon } from '../renderer/manager/components/PluginIdentityIcon.js'
import type { ManagerRoute, ManagerRouter } from '../renderer/manager/model/routes.js'

const destinations: readonly ManagerSettingsNavigationItemSnapshot[] = [
  {
    id: 'standalone.clients',
    owner: 'cordisx',
    group: 'after-settings',
    navigationGroup: 'resources',
    order: 10,
    disabled: false,
    title: '客户端连接',
    description: '',
    pageTitle: '客户端连接',
    pageDescription: '',
    icon: 'host:playground',
    route: { id: 'standalone.clients' },
  },
  {
    id: 'standalone.channel',
    owner: 'cordisx',
    group: 'after-settings',
    navigationGroup: 'collaboration',
    order: 10,
    disabled: false,
    title: '飞书 / Lark',
    description: '',
    pageTitle: '飞书 / Lark',
    pageDescription: '',
    icon: 'host:chat',
    route: { id: 'standalone.channel' },
  },
  {
    id: 'standalone.service-auth',
    owner: 'cordisx',
    group: 'after-settings',
    navigationGroup: 'external-accounts',
    order: 10,
    disabled: false,
    title: '插件服务登录',
    description: '',
    pageTitle: '插件服务登录',
    pageDescription: '',
    icon: 'host:key',
    route: { id: 'standalone.service-auth' },
  },
]

// Navigation reads only localization and contributed destination metadata.
const snapshot = {
  localization: { locale: 'zh-CN' },
  settingsNavigationItems: destinations,
} as unknown as ManagerSnapshot

type View = 'plugins' | 'model-services' | 'marketplace' | 'sources' | 'clients' | 'service-auth' | 'channel'

function viewFor(route: ManagerRoute): View {
  if (route.kind === 'marketplace-sources') return 'sources'
  if (route.kind === 'manager-content') {
    if (route.id === 'standalone.clients') return 'clients'
    if (route.id === 'standalone.service-auth') return 'service-auth'
    if (route.id === 'standalone.channel') return 'channel'
  }
  if (route.kind === 'primary' && (route.page === 'model-services' || route.page === 'marketplace')) {
    return route.page
  }
  return 'plugins'
}

const titles: Readonly<Record<View, string>> = {
  plugins: '插件',
  'model-services': '模型服务',
  marketplace: '插件商店',
  sources: '插件来源',
  clients: '客户端连接',
  'service-auth': '插件服务登录',
  channel: '飞书 / Lark',
}
const icons = {
  plugins: 'plugins',
  'model-services': 'settings',
  marketplace: 'marketplace',
  clients: 'overview',
  'service-auth': 'permissions',
  channel: 'routes',
} as const
const primaryPages = ['plugins', 'model-services', 'marketplace'] as const

function seat(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing manager seat: ${id}`)
  return element
}

function useCollectionFilter(id: string, emptyId: string, query: string): void {
  useEffect(() => {
    const target = seat(id)
    const empty = seat(emptyId)
    const update = () => {
      const needle = query.trim().toLocaleLowerCase()
      const cards = [...target.querySelectorAll<HTMLElement>(':scope > .card')]
      let visible = 0
      for (const card of cards) {
        const model = (card as HTMLElement & {
          model?: { id?: string; codexModels?: string[]; claudeModels?: string[] }
        }).model
        const searchable = [card.textContent, model?.id, ...(model?.codexModels ?? []), ...(model?.claudeModels ?? [])]
          .join(' ').toLocaleLowerCase()
        const matches = needle === '' || searchable.includes(needle)
        card.hidden = !matches
        if (matches) visible++
      }
      empty.hidden = needle === '' || cards.length === 0 || visible !== 0
    }
    const observer = new MutationObserver(update)
    observer.observe(target, { childList: true, subtree: true, characterData: true })
    update()
    return () => observer.disconnect()
  }, [emptyId, id, query])
}

function usePluginIcons() {
  const [icons, setIcons] = useState<Array<{ element: HTMLElement; id: string; name: string }>>([])
  useEffect(() => {
    const target = seat('plugins')
    const update = () =>
      setIcons([...target.querySelectorAll<HTMLElement>('.manager-plugin-icon')].map(element => ({
        element,
        id: element.dataset.pluginId ?? '',
        name: element.dataset.pluginName ?? '',
      })))
    // Observe only direct children: React owns the content of each icon seat.
    const observer = new MutationObserver(update)
    observer.observe(target, { childList: true })
    update()
    return () => observer.disconnect()
  }, [])
  return icons
}

function ManagerShell() {
  const [route, setRoute] = useState<ManagerRoute>({ kind: 'primary', page: 'plugins' })
  const [pluginQuery, setPluginQuery] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const searchedMarketplace = useRef(false)
  const pluginIcons = usePluginIcons()
  const view = viewFor(route)
  const navigate = (next: ManagerRoute) => setRoute(next)
  const marketplace = () => navigate({ kind: 'primary', page: 'marketplace' })
  const router: ManagerRouter = {
    route,
    navigate,
    replace: navigate,
    openDetail: (_root, detail) => navigate(detail),
    back: marketplace,
  }
  useCollectionFilter('plugins', 'plugins-filter-empty', pluginQuery)
  useCollectionFilter('models', 'models-filter-empty', modelQuery)
  useLayoutEffect(() => {
    for (const panel of document.querySelectorAll<HTMLElement>('[data-manager-view]')) {
      panel.hidden = panel.dataset.managerView !== view
    }
    document.title = `${titles[view]} · CordisX`
    if (view === 'marketplace' && !searchedMarketplace.current) {
      searchedMarketplace.current = true
      const form = seat('market-search') as HTMLFormElement
      form.requestSubmit()
    }
  }, [view])
  useEffect(() => {
    const sources = seat('open-sources')
    const open = () => navigate({ kind: 'marketplace-sources' })
    sources.addEventListener('click', open)
    return () => sources.removeEventListener('click', open)
  }, [])
  const leading = view === 'sources'
    ? (
      <button type="button" className="manager-back" aria-label="返回插件商店" onClick={marketplace}>
        <HostIcon token="back" />
      </button>
    )
    : <HostIcon token={icons[view]} />
  const heading = view === 'sources'
    ? (
      <HostBreadcrumbs
        segments={[
          { key: 'marketplace', label: titles.marketplace, onActivate: marketplace },
          { key: 'sources', label: titles.sources },
        ]}
      />
    )
    : <h2>{titles[view]}</h2>
  return (
    <>
      <Navigation snapshot={snapshot} router={router} primaryPages={primaryPages} showFooter={false} />
      {pluginIcons.map(({ element, id, name }) =>
        createPortal(<PluginIdentityIcon pluginId={id} name={name} />, element, id)
      )}
      {createPortal(leading, seat('manager-leading'))}
      {createPortal(heading, seat('manager-heading'))}
      {createPortal(<HostIcon token="reload-plugin" />, seat('refresh-icon'))}
      {createPortal(<HostIcon token="search" />, seat('market-search-icon'))}
      {createPortal(
        <SearchToolbar
          value={pluginQuery}
          onChange={setPluginQuery}
          aria-label="搜索插件"
          placeholder="搜索插件"
          clearLabel="清除搜索"
        />,
        seat('plugins-toolbar'),
      )}
      {createPortal(
        <SearchToolbar
          value={modelQuery}
          onChange={setModelQuery}
          aria-label="搜索模型服务"
          placeholder="搜索模型服务"
          clearLabel="清除搜索"
        />,
        seat('models-toolbar'),
      )}
    </>
  )
}

const theme = new HostThemeProjection(document)
theme.attach(seat('manager-shell'))
createRoot(seat('manager-navigation')).render(<ManagerShell />)
