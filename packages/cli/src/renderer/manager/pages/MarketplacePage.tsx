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

const FAVORITES_KEY = 'cordisx.manager.favoriteMarketplacePlugins.v1'

function readFavorites(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch { return new Set() }
}

export function MarketplacePage({ marketplace, manager, snapshot, router }: { readonly marketplace: MarketplaceModel; readonly manager: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const catalog = useMarketplaceSnapshot(marketplace)
  const [query, setQuery] = useState('')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [certifiedOnly, setCertifiedOnly] = useState(false)
  const [favorites, setFavorites] = useState(readFavorites)
  const results = useMemo(() => searchMarketplaceCatalog(catalog.plugins, {
    query, currentLocale: snapshot.localization.locale, officialOnly, certifiedOnly,
    ...(manager.marketplaceEligibility === undefined ? {} : { eligibility: manager.marketplaceEligibility }),
  }), [catalog.plugins, certifiedOnly, manager.marketplaceEligibility, officialOnly, query, snapshot.localization.locale])
  const toggleFavorite = (identity: string) => {
    setFavorites(current => {
      const next = new Set(current)
      if (next.has(identity)) next.delete(identity); else next.add(identity)
      try { window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next].sort())) } catch {}
      return next
    })
  }
  const share = async (name: string, href: string) => {
    if (navigator.share !== undefined) await navigator.share({ title: name, url: href })
    else await navigator.clipboard.writeText(href)
  }
  return <section className="cxr-page cxr-marketplace" data-marketplace-discovery-page="true">
    <div className="cxr-marketplace-tools" role="search" aria-label="搜索和筛选商店插件">
      <Input className="cxr-marketplace-search" value={query} placeholder="搜索插件…" clearable prefixIcon={<HostIcon token="search" />} onChange={setQuery} />
      <span className="cxr-marketplace-tool-actions">
        <IconButton className="cxr-marketplace-filter" icon="marketplace-official" label="仅官方" description={officialOnly ? '已启用官方插件筛选' : '仅显示官方插件'} aria-pressed={officialOnly} onClick={() => setOfficialOnly(value => !value)} />
        <IconButton className="cxr-marketplace-filter" icon="marketplace-certified" label="仅认证" description={certifiedOnly ? '已启用认证插件筛选' : '仅显示认证插件'} aria-pressed={certifiedOnly} onClick={() => setCertifiedOnly(value => !value)} />
        <IconButton icon="marketplace-source-edit" label="管理来源" description="配置插件商店来源" onClick={() => router.navigate({ kind: 'marketplace-sources' })} />
      </span>
    </div>
    <div className="cxr-marketplace-grid">{results.map(result => {
      const href = result.plugin.homepage ?? result.plugin.source
      const favorite = favorites.has(result.plugin.identity)
      return <div className="cxr-marketplace-card" key={result.plugin.identity}>
        <button type="button" className="cxr-marketplace-primary" aria-label={`打开商店插件详情 · ${result.projection.name}`} onClick={() => router.navigate({ kind: 'marketplace-plugin', identity: result.plugin.identity })}>
          <span className="cxr-card-icon">{result.plugin.icon === undefined ? result.projection.name.slice(0, 2).toLocaleUpperCase() : <img src={result.plugin.icon} alt="" referrerPolicy="no-referrer" />}</span>
          <span className="cxr-card-body"><span className="cxr-card-title">{result.projection.name}</span><span className="cxr-card-description">{result.projection.description}</span><span className="cxr-marketplace-meta">{result.plugin.version} · {result.projection.feedName}</span></span>
        </button>
        <span className="cxr-marketplace-actions">
          <IconButton icon="import-plugin" label="安装" disabled description="当前 Host 尚未发布商店安装服务" />
          <IconButton icon={favorite ? 'favorite-active' : 'favorite'} label={favorite ? '取消收藏' : '收藏'} onClick={() => toggleFavorite(result.plugin.identity)} />
          <MoreMenu label={`${result.projection.name} 更多操作`} items={[
            { id: 'block', label: '屏蔽（Host 能力不可用）', icon: 'disable-plugin', disabled: true, onSelect: () => {} },
            { id: 'share', label: '分享', icon: 'share-plugin', onSelect: () => void share(result.projection.name, href) },
            { id: 'source', label: '打开来源', icon: 'authors-source', onSelect: () => window.open(result.plugin.source, '_blank', 'noopener,noreferrer') },
          ]} />
        </span>
      </div>
    })}{results.length === 0 ? <div className="cxr-empty">没有匹配的插件</div> : null}</div>
  </section>
}
