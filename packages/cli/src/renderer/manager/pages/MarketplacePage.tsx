import { useMemo, useState } from 'react'
import { Input } from 'tdesign-react'
import type { PluginManagementSnapshot } from '../../../management/contracts.js'
import type { MarketplaceModel } from '../../marketplace.js'
import { searchMarketplaceCatalog } from '../../marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { useMarketplaceSnapshot } from '../model/marketplace-store.js'
import type { ManagerRouter } from '../model/routes.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import type { MoreMenuItem } from '../../host-ui/MoreMenu.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { readMarketplaceFavorites, writeMarketplaceFavorites } from '../model/marketplace-favorites.js'
import { useMarketplaceInstaller } from '../model/use-marketplace-installer.js'
import { MarketplaceTrustBadges, marketplaceTrustLabels } from '../components/MarketplaceTrustBadges.js'
import { productLocale } from '../../ui-copy.js'
import { usePluginLifecycleActions } from '../model/use-plugin-lifecycle-actions.js'
import type { ManagerPluginManagementBinding } from '../model/plugin-management.js'
import { usePluginManagementActions } from '../model/use-plugin-management-actions.js'

const COPY = {
  'zh-CN': {
    tools: '搜索和筛选商店插件',
    search: '搜索插件…',
    officialOnly: '仅官方',
    officialOn: '已启用官方插件筛选',
    officialOff: '仅显示官方插件',
    certifiedOnly: '仅认证',
    certifiedOn: '已启用认证插件筛选',
    certifiedOff: '仅显示认证插件',
    sources: '管理来源',
    sourcesDescription: '配置插件商店来源',
    open: '打开商店插件详情',
    install: '安装',
    update: '更新',
    installed: '已安装',
    installUnavailable: '当前 Host 尚未发布商店安装服务',
    artifactUnavailable: '该商店记录没有可安装制品',
    installing: '正在安装',
    cancelInstall: '取消安装',
    installFailed: '插件安装失败',
    installSucceeded: '插件安装完成',
    enable: '启用',
    disable: '停用',
    uninstall: '卸载',
    unfavorite: '取消收藏',
    favorite: '收藏',
    more: '更多操作',
    hide: '从商店隐藏',
    share: '分享',
    source: '打开来源',
    empty: '没有匹配的插件',
  },
  en: {
    tools: 'Search and filter Marketplace plugins',
    search: 'Search plugins…',
    officialOnly: 'Official only',
    officialOn: 'Official-only filter is enabled',
    officialOff: 'Show Official plugins only',
    certifiedOnly: 'Certified only',
    certifiedOn: 'Certified-only filter is enabled',
    certifiedOff: 'Show Certified plugins only',
    sources: 'Manage sources',
    sourcesDescription: 'Configure Marketplace sources',
    open: 'Open Marketplace plugin details',
    install: 'Install',
    update: 'Update',
    installed: 'Installed',
    installUnavailable: 'This Host has not published Marketplace installation yet',
    artifactUnavailable: 'This Marketplace record has no installable artifact',
    installing: 'Installing',
    cancelInstall: 'Cancel installation',
    installFailed: 'Plugin installation failed',
    installSucceeded: 'Plugin installation complete',
    enable: 'Enable',
    disable: 'Disable',
    uninstall: 'Uninstall',
    unfavorite: 'Remove favorite',
    favorite: 'Favorite',
    more: 'more actions',
    hide: 'Hide from Marketplace',
    share: 'Share',
    source: 'Open source',
    empty: 'No matching plugins',
  },
} as const

export function MarketplacePage(
  { marketplace, manager, snapshot, router, pluginManagement, pluginManagementSnapshot }: {
    readonly marketplace: MarketplaceModel
    readonly manager: ManagerModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
    readonly pluginManagement?: ManagerPluginManagementBinding | undefined
    readonly pluginManagementSnapshot?: PluginManagementSnapshot | undefined
  },
) {
  const copy = COPY[productLocale(snapshot.localization.locale)]
  const catalog = useMarketplaceSnapshot(marketplace)
  const [query, setQuery] = useState('')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [certifiedOnly, setCertifiedOnly] = useState(false)
  const [favorites, setFavorites] = useState(readMarketplaceFavorites)
  const installer = useMarketplaceInstaller(manager, snapshot, {
    failed: copy.installFailed,
    succeeded: copy.installSucceeded,
  })
  const lifecycle = usePluginLifecycleActions(manager, snapshot)
  const management = usePluginManagementActions(
    pluginManagement,
    pluginManagementSnapshot,
    snapshot.localization.locale,
  )
  const hidden = useMemo(
    () =>
      new Set(
        pluginManagementSnapshot?.hiddenCatalogEntries.map(item => `${item.sourceUrl}\0${item.pluginId}`) ?? [],
      ),
    [pluginManagementSnapshot],
  )
  const installed = useMemo(
    () => new Map(snapshot.plugins.map(plugin => [`${plugin.source}\0${plugin.id}`, plugin])),
    [snapshot.plugins],
  )
  const results = useMemo(
    () =>
      searchMarketplaceCatalog(catalog.plugins.filter(plugin => !hidden.has(`${plugin.feedUrl}\0${plugin.id}`)), {
        query,
        currentLocale: snapshot.localization.locale,
        officialOnly,
        certifiedOnly,
        ...(manager.marketplaceEligibility === undefined ? {} : { eligibility: manager.marketplaceEligibility }),
      }),
    [
      catalog.plugins,
      certifiedOnly,
      manager.marketplaceEligibility,
      hidden,
      officialOnly,
      query,
      snapshot.localization.locale,
    ],
  )
  const toggleFavorite = (identity: string) => {
    setFavorites(current => {
      const next = new Set(current)
      if (next.has(identity)) next.delete(identity)
      else next.add(identity)
      writeMarketplaceFavorites(next)
      return next
    })
  }
  const share = async (name: string, href: string) => {
    if (navigator.share !== undefined) await navigator.share({ title: name, url: href })
    else await navigator.clipboard.writeText(href)
  }
  return (
    <section className="cxr-page cxr-marketplace" data-marketplace-discovery-page="true">
      <div className="cxr-marketplace-tools" role="search" aria-label={copy.tools}>
        <Input
          className="cxr-marketplace-search"
          value={query}
          placeholder={copy.search}
          clearable
          prefixIcon={<HostIcon token="search" />}
          onChange={setQuery}
        />
        <span className="cxr-marketplace-tool-actions">
          <IconButton
            className="cxr-marketplace-filter"
            icon="marketplace-official"
            label={copy.officialOnly}
            description={officialOnly ? copy.officialOn : copy.officialOff}
            aria-pressed={officialOnly}
            onClick={() => setOfficialOnly(value => !value)}
          />
          <IconButton
            className="cxr-marketplace-filter"
            icon="marketplace-certified"
            label={copy.certifiedOnly}
            description={certifiedOnly ? copy.certifiedOn : copy.certifiedOff}
            aria-pressed={certifiedOnly}
            onClick={() => setCertifiedOnly(value => !value)}
          />
          <IconButton
            icon="marketplace-source-edit"
            label={copy.sources}
            description={copy.sourcesDescription}
            onClick={() => router.navigate({ kind: 'marketplace-sources' })}
          />
        </span>
      </div>
      <div className="cxr-marketplace-grid" role="list">
        {results.map(result => {
          const href = result.plugin.homepage ?? result.plugin.source
          const favorite = favorites.has(result.plugin.identity)
          const trustLabels = marketplaceTrustLabels(result.plugin, snapshot.localization.locale)
          const installedPlugin = installed.get(`${result.plugin.source}\0${result.plugin.id}`)
          const installedVersion = installedPlugin?.package?.version
          const unmanagedInstalled = installedPlugin !== undefined && installedVersion === undefined
          const exactVersionInstalled = installedVersion === result.plugin.version
          const installing = installer.installingIdentity === result.plugin.identity
          const installDisabled = unmanagedInstalled || exactVersionInstalled || result.plugin.artifact === undefined
            || !installer.available
          const installLabel = installing
            ? copy.cancelInstall
            : exactVersionInstalled || unmanagedInstalled
            ? copy.installed
            : installedVersion === undefined
            ? copy.install
            : copy.update
          const installDescription = installing
            ? copy.installing
            : exactVersionInstalled || unmanagedInstalled
            ? copy.installed
            : result.plugin.artifact === undefined
            ? copy.artifactUnavailable
            : installer.available
            ? installLabel
            : copy.installUnavailable
          const lifecycleItems: readonly MoreMenuItem[] = installedPlugin === undefined
            ? []
            : [{
              id: installedPlugin.status === 'configured-disabled' ? 'enable' : 'disable',
              label: installedPlugin.status === 'configured-disabled' ? copy.enable : copy.disable,
              icon: installedPlugin.status === 'configured-disabled' ? 'enable-plugin' : 'disable-plugin',
              disabled: !lifecycle.operationsAvailable || lifecycle.busyPluginId === installedPlugin.id,
              onSelect: () =>
                void lifecycle.run(
                  installedPlugin,
                  installedPlugin.status === 'configured-disabled'
                    ? { kind: 'enable', pluginId: installedPlugin.id }
                    : { kind: 'disable', pluginId: installedPlugin.id, impactToken: '' },
                ),
            }, {
              id: 'uninstall',
              label: copy.uninstall,
              icon: 'uninstall-plugin',
              disabled: !lifecycle.operationsAvailable || lifecycle.busyPluginId === installedPlugin.id,
              onSelect: () =>
                void lifecycle.run(installedPlugin, {
                  kind: 'uninstall',
                  pluginId: installedPlugin.id,
                  impactToken: '',
                }),
            }]
          return (
            <div
              className="cxr-marketplace-card"
              key={result.plugin.identity}
              role="listitem"
              data-marketplace-plugin={result.plugin.id}
            >
              <button
                type="button"
                className="cxr-marketplace-primary"
                aria-label={[copy.open, result.projection.name, ...trustLabels].join(' · ')}
                onClick={() => router.navigate({ kind: 'marketplace-plugin', identity: result.plugin.identity })}
              >
                <span className="cxr-card-icon">
                  {result.plugin.icon === undefined
                    ? result.projection.name.slice(0, 2).toLocaleUpperCase()
                    : <img src={result.plugin.icon} alt="" referrerPolicy="no-referrer" />}
                </span>
                <span className="cxr-card-body">
                  <span className="cxr-marketplace-title-row">
                    <span className="cxr-card-title">{result.projection.name}</span>
                    {installedPlugin !== undefined
                      ? <span className="cxr-badge" data-marketplace-installed="true">{copy.installed}</span>
                      : null}
                    <MarketplaceTrustBadges plugin={result.plugin} locale={snapshot.localization.locale} />
                  </span>
                  <span className="cxr-card-description">{result.projection.description}</span>
                  <span className="cxr-marketplace-meta">{result.plugin.version} · {result.projection.feedName}</span>
                </span>
              </button>
              <span className="cxr-marketplace-actions">
                <IconButton
                  icon={installing ? 'close' : 'import-plugin'}
                  label={installLabel}
                  disabled={!installing && (installDisabled || (
                    lifecycle.busyPluginId !== undefined && lifecycle.busyPluginId === installedPlugin?.id
                  ))}
                  description={installDescription}
                  aria-busy={installing}
                  onClick={event => {
                    event.stopPropagation()
                    if (installing) installer.cancel()
                    else void installer.run(result.plugin, result.projection.name)
                  }}
                />
                <IconButton
                  icon={favorite ? 'favorite-active' : 'favorite'}
                  label={favorite ? copy.unfavorite : copy.favorite}
                  onClick={() => toggleFavorite(result.plugin.identity)}
                />
                <MoreMenu
                  label={`${result.projection.name} ${copy.more}`}
                  items={[
                    ...lifecycleItems,
                    {
                      id: 'hide',
                      label: copy.hide,
                      icon: 'disable-plugin',
                      disabled: pluginManagementSnapshot === undefined || management.busyKey === result.plugin.identity,
                      onSelect: () =>
                        void management.mutate(result.plugin.identity, {
                          kind: 'catalog-hide',
                          identity: { sourceUrl: result.plugin.feedUrl, pluginId: result.plugin.id },
                        }).catch(() => undefined),
                    },
                    {
                      id: 'share',
                      label: copy.share,
                      icon: 'share-plugin',
                      onSelect: () => void share(result.projection.name, href),
                    },
                    {
                      id: 'source',
                      label: copy.source,
                      icon: 'authors-source',
                      onSelect: () => window.open(result.plugin.source, '_blank', 'noopener,noreferrer'),
                    },
                  ]}
                />
              </span>
            </div>
          )
        })}
        {results.length === 0 ? <div className="cxr-empty">{copy.empty}</div> : null}
      </div>
    </section>
  )
}
