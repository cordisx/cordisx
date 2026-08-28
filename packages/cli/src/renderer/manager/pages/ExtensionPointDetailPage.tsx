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

function stableControlClaimKey(candidate: { readonly identity: { readonly source: string; readonly pluginId: string; readonly pointId: string }; readonly claimId: string; readonly mode: string }): string {
  return [candidate.identity.source, candidate.identity.pluginId, candidate.identity.pointId, candidate.claimId, candidate.mode]
    .map(value => encodeURIComponent(value)).join(':')
}

export function ExtensionPointDetailPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const [tab, setTab] = useState<ExtensionPointTab>('usage')
  const route = router.route
  const pointId = route.kind === 'extension-point' ? route.pointId : undefined
  useEffect(() => { setTab('usage') }, [pointId])
  if (pointId === undefined) return null
  const point = snapshot.extensionPoints?.points.find(item => item.id === pointId)
  if (point === undefined) return <div className="cxr-empty">扩展点已不存在</div>
  const options = [{ label: '继承', value: 'inherit' }, { label: '允许', value: 'allow' }, { label: '拒绝', value: 'deny' }]
  const controlSnapshot = snapshot.extensionPointControls
  const control = controlSnapshot?.points.find(item => item.id === pointId)
  return <section className="cxr-page">
    <ManagerTabs label="扩展点详情" tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'usage' && <div className="cxr-list">
      {point.plugins.map(plugin => <section className="cxr-card" key={`${plugin.identity.source}\0${plugin.identity.id}`}><span className="cxr-card-body"><span className="cxr-card-title">{plugin.name}</span><span className="cxr-card-description">{plugin.description}</span><code className="cxr-card-code">{plugin.identity.id}</code></span><Select className="cxr-policy-select" value={plugin.policy} options={options} disabled={model.setExtensionPointPolicy === undefined} onChange={value => void model.setExtensionPointPolicy?.(plugin.identity.source, plugin.identity.id, point.id, value as 'inherit' | 'allow' | 'deny')} /></section>)}
      {control === undefined ? null : <section className="cxr-section" data-cordisx-control-point={control.id}><h3>受控渲染</h3><p>{control.state} · {control.reason}</p></section>}
      {control?.groups.filter(group => group.selection === 'user').map(group => {
        const candidates = control.candidates.filter(candidate => candidate.exclusiveGroup === group.id && candidate.authorization === 'allowed')
        const value = group.policyChoice?.outcome === 'selected' && group.policyChoice.selectedClaim !== undefined
          ? stableControlClaimKey(group.policyChoice.selectedClaim)
          : 'native'
        const groupOptions = [
          ...(group.nativeFallback ? [{ label: '原生渲染', value: 'native' }] : []),
          ...candidates.map(candidate => ({ label: `${candidate.identity.pluginId} · ${candidate.mode}`, value: stableControlClaimKey(candidate) })),
        ]
        const groupKey = `${encodeURIComponent(pointId)}:${encodeURIComponent(group.id)}`
        return <section className="cxr-card" data-cordisx-control-group={groupKey} key={group.id}><span className="cxr-card-body"><span className="cxr-card-title">渲染模式 · {group.id}</span><span className="cxr-card-description">在互斥候选间切换，选择由 Host 策略保存。</span></span><span data-cordisx-control-group-select={groupKey}><Select key={`${groupKey}:${controlSnapshot!.policyRevision}:${value}`} className="cxr-policy-select" value={value} options={groupOptions} disabled={model.setExtensionPointControlGroupChoice === undefined} onChange={next => {
          const selected = candidates.find(candidate => stableControlClaimKey(candidate) === next)
          void model.setExtensionPointControlGroupChoice?.(controlSnapshot!.policyRevision, selected === undefined
            ? { pointId, groupId: group.id, outcome: 'native' }
            : { pointId, groupId: group.id, outcome: 'selected', selectedClaim: { principalHandle: selected.principalHandle, identity: selected.identity, claimId: selected.claimId, mode: selected.mode } })
        }} /></span></section>
      })}
      {control?.candidates.map(candidate => <section className="cxr-card" data-cordisx-control-candidate={stableControlClaimKey(candidate)} data-cordisx-control-source={candidate.identity.source} data-cordisx-control-plugin={candidate.identity.pluginId} data-cordisx-control-point={candidate.identity.pointId} data-cordisx-control-claim={candidate.claimId} data-cordisx-control-mode={candidate.mode} data-cordisx-control-state={candidate.state} key={`${candidate.principalHandle}\0${candidate.claimId}\0${candidate.mode}`}><span className="cxr-card-body"><span className="cxr-card-title">{candidate.identity.pluginId} · {candidate.mode}</span><span className="cxr-card-description">{candidate.state} · {candidate.reason}</span><code className="cxr-card-code">{candidate.claimId}</code></span><span data-cordisx-control-claim-select={stableControlClaimKey(candidate)}><Select className="cxr-policy-select" value={candidate.policy} options={options} disabled={model.setExtensionPointControlAuthorization === undefined} onChange={policy => void model.setExtensionPointControlAuthorization?.(controlSnapshot!.policyRevision, { principalHandle: candidate.principalHandle, source: candidate.identity.source, pluginId: candidate.identity.pluginId, pointId: candidate.identity.pointId, claimId: candidate.claimId, mode: candidate.mode }, policy as 'inherit' | 'allow' | 'deny')} /></span></section>)}
      {point.plugins.length === 0 && (control?.candidates.length ?? 0) === 0 ? <div className="cxr-empty">当前没有插件使用这个扩展点</div> : null}
    </div>}
    {tab === 'information' && <div className="cxr-grid"><section className="cxr-section"><h3>状态</h3><p>{point.available ? '可用' : point.availability}</p></section><section className="cxr-section"><h3>信息</h3><p>{point.descriptionProjection.text}</p><code>{point.id}</code></section></div>}
    {tab === 'diagnostics' && <><section className="cxr-section"><h3>可用性</h3><p>{point.availability}</p><p>{point.availabilityDetail}</p></section>{control?.suppression === undefined ? null : <section className="cxr-section"><h3>父级抑制</h3><p>{control.suppression.path.join(' → ')}</p><p>{control.suppression.reason}</p></section>}{snapshot.extensionPointControls?.diagnostics.filter(item => control?.candidates.some(candidate => candidate.contributionId === item.contributionId)).map(item => <section className="cxr-section" key={item.contributionId}><h3>{item.contributionId}</h3><p>{item.message}</p></section>)}</>}
  </section>
}
