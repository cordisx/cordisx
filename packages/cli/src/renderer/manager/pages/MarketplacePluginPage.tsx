import { useEffect, useState } from 'react'
import { Button } from 'tdesign-react'
import { projectMarketplacePlugin, type MarketplaceModel } from '../../marketplace.js'
import { ManagerTabs, type ManagerTab } from '../components/ManagerTabs.js'
import { useMarketplaceSnapshot } from '../model/marketplace-store.js'
import type { ManagerRouter } from '../model/routes.js'

type MarketplaceDetailTab = 'overview' | 'authors-source'
const tabs: readonly ManagerTab<MarketplaceDetailTab>[] = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'authors-source', label: '作者与来源', icon: 'authors-source' },
]

export function MarketplacePluginPage({ marketplace, locale, router }: { readonly marketplace: MarketplaceModel; readonly locale: string; readonly router: ManagerRouter }) {
  const [tab, setTab] = useState<MarketplaceDetailTab>('overview')
  const route = router.route
  const snapshot = useMarketplaceSnapshot(marketplace)
  const identity = route.kind === 'marketplace-plugin' ? route.identity : undefined
  useEffect(() => { setTab('overview') }, [identity])
  if (identity === undefined) return null
  const plugin = snapshot.plugins.find(item => item.identity === identity)
  if (plugin === undefined) return <div className="cxr-empty">插件目录记录已不存在</div>
  const projection = projectMarketplacePlugin(plugin, locale)
  return <section className="cxr-page">
    <ManagerTabs label="插件商店详情" tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'overview' && <div className="cxr-grid"><section className="cxr-section cxr-item-full"><p>{projection.description}</p><p>{plugin.version}</p></section><section className="cxr-section"><h3>兼容性</h3><p>CordisX {plugin.compatibility.cordisx}</p><p>{plugin.license}</p></section><div className="cxr-actions cxr-item-full">{plugin.homepage === undefined ? null : <Button tag="a" href={plugin.homepage} target="_blank" variant="outline">项目主页</Button>}{plugin.commerce === undefined ? null : <Button tag="a" href={plugin.commerce.purchaseUrl} target="_blank" theme="primary">前往购买</Button>}</div></div>}
    {tab === 'authors-source' && <div className="cxr-grid"><section className="cxr-section"><h3>作者</h3>{projection.authors.map(item => <p key={item.name}>{item.name}</p>)}</section><section className="cxr-section"><h3>来源</h3><p>{projection.feedName}</p><code>{plugin.feedUrl}</code></section></div>}
  </section>
}
