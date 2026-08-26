import { useEffect, useState } from 'react'
import { Select } from 'tdesign-react'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { ManagerTabs, type ManagerTab } from '../components/ManagerTabs.js'
import type { ManagerRouter } from '../model/routes.js'

type ExtensionPointTab = 'usage' | 'information' | 'diagnostics'
const tabs: readonly ManagerTab<ExtensionPointTab>[] = [
  { id: 'usage', label: '使用情况', icon: 'plugins' },
  { id: 'information', label: '信息', icon: 'point-info' },
  { id: 'diagnostics', label: '诊断', icon: 'diagnostics' },
]

export function ExtensionPointDetailPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const [tab, setTab] = useState<ExtensionPointTab>('usage')
  const route = router.route
  const pointId = route.kind === 'extension-point' ? route.pointId : undefined
  useEffect(() => { setTab('usage') }, [pointId])
  if (pointId === undefined) return null
  const point = snapshot.extensionPoints?.points.find(item => item.id === pointId)
  if (point === undefined) return <div className="cxr-empty">扩展点已不存在</div>
  const options = [{ label: '继承', value: 'inherit' }, { label: '允许', value: 'allow' }, { label: '拒绝', value: 'deny' }]
  return <section className="cxr-page">
    <ManagerTabs label="扩展点详情" tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'usage' && <div className="cxr-list">{point.plugins.map(plugin => <section className="cxr-card" key={`${plugin.identity.source}\0${plugin.identity.id}`}><span className="cxr-card-body"><span className="cxr-card-title">{plugin.name}</span><span className="cxr-card-description">{plugin.description}</span><code className="cxr-card-code">{plugin.identity.id}</code></span><Select className="cxr-policy-select" value={plugin.policy} options={options} disabled={model.setExtensionPointPolicy === undefined} onChange={value => void model.setExtensionPointPolicy?.(plugin.identity.source, plugin.identity.id, point.id, value as 'inherit' | 'allow' | 'deny')} /></section>)}{point.plugins.length === 0 ? <div className="cxr-empty">当前没有插件使用这个扩展点</div> : null}</div>}
    {tab === 'information' && <div className="cxr-grid"><section className="cxr-section"><h3>状态</h3><p>{point.available ? '可用' : point.availability}</p></section><section className="cxr-section"><h3>信息</h3><p>{point.descriptionProjection.text}</p><code>{point.id}</code></section></div>}
    {tab === 'diagnostics' && <section className="cxr-section"><h3>可用性</h3><p>{point.availability}</p><p>{point.availabilityDetail}</p></section>}
  </section>
}
