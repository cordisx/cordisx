import { Select } from 'tdesign-react'
import type { CordisXPermissionPolicy } from '../../../contracts.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import type { ManagerRouter } from '../model/routes.js'

const policyOptions = [{ label: '每次询问', value: 'ask' }, { label: '始终允许', value: 'allow' }, { label: '始终拒绝', value: 'deny' }]

export function PermissionDetailPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const route = router.route
  if (route.kind !== 'permission') return null
  const permission = snapshot.permissions.find(item => item.identity.id === route.pluginId && item.capability === route.capability)
  if (permission === undefined) return <div className="cxr-empty">权限记录已不存在</div>
  return <section className="cxr-page cxr-grid">
    <section className="cxr-section"><h3>授权策略</h3><p>{permission.reasonText}</p><Select value={permission.policy} options={policyOptions} onChange={value => void model.setPermissionPolicy(route.pluginId, route.capability, value as CordisXPermissionPolicy)} /></section>
    <section className="cxr-section"><h3>能力可用性</h3><p>{permission.availability.status}</p><p>{permission.availability.reasonText}</p></section>
    <section className="cxr-section cxr-item-full"><h3>提供方</h3>{permission.availability.providers.map(provider => <p key={provider.providerId}>{provider.providerNameText} · {provider.kind} · {provider.status}</p>)}{permission.availability.providers.length === 0 ? <p>Host 当前未发布提供方。</p> : null}</section>
  </section>
}
