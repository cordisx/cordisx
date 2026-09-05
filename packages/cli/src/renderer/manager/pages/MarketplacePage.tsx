import { useMemo, useState } from 'react'
import { Input } from 'tdesign-react'
import type { MarketplaceModel } from '../../marketplace.js'
import { searchMarketplaceCatalog } from '../../marketplace.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { useMarketplaceSnapshot } from '../model/marketplace-store.js'
import type { ManagerRouter } from '../model/routes.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { readMarketplaceFavorites, writeMarketplaceFavorites } from '../model/marketplace-favorites.js'
import { MarketplaceTrustBadges, marketplaceTrustLabels } from '../components/MarketplaceTrustBadges.js'
import { productLocale } from '../../ui-copy.js'

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
    installUnavailable: '当前 Host 尚未发布商店安装服务',
    unfavorite: '取消收藏',
    favorite: '收藏',
    more: '更多操作',
    block: '屏蔽（Host 能力不可用）',
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
    installUnavailable: 'This Host has not published Marketplace installation yet',
    unfavorite: 'Remove favorite',
    favorite: 'Favorite',
    more: 'more actions',
    block: 'Block (Host capability unavailable)',
    share: 'Share',
    source: 'Open source',
    empty: 'No matching plugins',
  },
} as const

export function MarketplacePage(
  { marketplace, manager, snapshot, router }: {
    readonly marketplace: MarketplaceModel
    readonly manager: ManagerModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
  },
) {
  const copy = COPY[productLocale(snapshot.localization.locale)]
  const catalog = useMarketplaceSnapshot(marketplace)
  const [query, setQuery] = useState('')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [certifiedOnly, setCertifiedOnly] = useState(false)
  const [favorites, setFavorites] = useState(readMarketplaceFavorites)
  const results = useMemo(() =>
    searchMarketplaceCatalog(catalog.plugins, {
      query,
      currentLocale: snapshot.localization.locale,
      officialOnly,
      certifiedOnly,
      ...(manager.marketplaceEligibility === undefined ? {} : { eligibility: manager.marketplaceEligibility }),
    }), [
    catalog.plugins,
    certifiedOnly,
    manager.marketplaceEligibility,
    officialOnly,
    query,
    snapshot.localization.locale,
  ])
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
      <div className="cxr-marketplace-grid">
        {results.map(result => {
          const href = result.plugin.homepage ?? result.plugin.source
          const favorite = favorites.has(result.plugin.identity)
          const trustLabels = marketplaceTrustLabels(result.plugin, snapshot.localization.locale)
          return (
            <div className="cxr-marketplace-card" key={result.plugin.identity}>
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
                    <MarketplaceTrustBadges plugin={result.plugin} locale={snapshot.localization.locale} />
                  </span>
                  <span className="cxr-card-description">{result.projection.description}</span>
                  <span className="cxr-marketplace-meta">{result.plugin.version} · {result.projection.feedName}</span>
                </span>
              </button>
              <span className="cxr-marketplace-actions">
                <IconButton icon="import-plugin" label={copy.install} disabled description={copy.installUnavailable} />
                <IconButton
                  icon={favorite ? 'favorite-active' : 'favorite'}
                  label={favorite ? copy.unfavorite : copy.favorite}
                  onClick={() => toggleFavorite(result.plugin.identity)}
                />
                <MoreMenu
                  label={`${result.projection.name} ${copy.more}`}
                  items={[
                    { id: 'block', label: copy.block, icon: 'disable-plugin', disabled: true, onSelect: () => {} },
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
