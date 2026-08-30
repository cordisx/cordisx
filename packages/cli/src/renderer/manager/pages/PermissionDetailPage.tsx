import { Select } from 'tdesign-react'
import type { CordisXPermissionPolicy } from '../../../contracts.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import type { ManagerRouter } from '../model/routes.js'

const policyOptions = [{ label: '每次询问', value: 'ask' }, { label: '始终允许', value: 'allow' }, { label: '始终拒绝', value: 'deny' }]

export function PermissionDetailPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const route = router.route
  if (route.kind !== 'permission') return null
  const permission = snapshot.permissions.find(item => item.identity.id === route.pluginId && item.capability === route.capability && item.fingerprint === route.fingerprint)
  if (permission === undefined) return <div className="cxr-empty">权限记录已不存在</div>
  return <section className="cxr-page cxr-grid">
    <section className="cxr-section"><h3>授权策略</h3><p>{permission.reasonText}</p><Select value={permission.policy} options={policyOptions} onChange={value => void model.setPermissionPolicy(route.pluginId, route.capability, value as CordisXPermissionPolicy, permission.scope)} /></section>
    <section className="cxr-section"><h3>能力可用性</h3><p>{permission.availability.status}</p><p>{permission.availability.reasonText}</p></section>
    <section className="cxr-section"><h3>使用范围</h3><pre className="cxr-code">{JSON.stringify(permission.scope, null, 2)}</pre></section>
    {permission.authorizationOrigin === undefined ? null : <section className="cxr-section" data-permission-authorization-origin={permission.authorizationOrigin}>
      <h3>{permission.authorizationOrigin === 'certified-implicit' ? '认证自动批准的 DOM 权限' : '最近授权来源'}</h3>
      <p>{permission.authorizationReason ?? (permission.authorizationOrigin === 'certified-implicit' ? 'Host 根据精确制品认证投影自动批准。' : '由用户显式确认。')}</p>
      {permission.certification === undefined ? null : <dl className="cxr-facts">
        <div><dt>制品</dt><dd><code>{permission.certification.pluginId}@{permission.certification.version}</code></dd></div>
        <div><dt>完整性</dt><dd><code>{permission.certification.integrity}</code></dd></div>
        <div><dt>审核策略</dt><dd><code>{permission.certification.reviewPolicy.id}@{permission.certification.reviewPolicy.version}</code></dd></div>
        <div><dt>证据</dt><dd><a href={permission.certification.evidence.reference} target="_blank" rel="noopener noreferrer">{permission.certification.evidence.reference}</a></dd></div>
        <div><dt>Revision</dt><dd><code>{permission.certification.revision}</code></dd></div>
        <div><dt>Fingerprint</dt><dd><code>{permission.certification.fingerprint}</code></dd></div>
      </dl>}
    </section>}
    <section className="cxr-section cxr-item-full"><h3>提供方</h3>{permission.availability.providers.map(provider => <p key={provider.providerId}>{provider.providerNameText} · {provider.kind} · {provider.status}</p>)}{permission.availability.providers.length === 0 ? <p>Host 当前未发布提供方。</p> : null}</section>
  </section>
}
