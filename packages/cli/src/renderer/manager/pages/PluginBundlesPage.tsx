import { useState } from 'react'
import { Button } from 'tdesign-react'
import type {
  CordisXPluginBundleLifecycleResultV1,
  CordisXPluginBundlePolicy,
} from '../../../plugin-bundle-contracts.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { productLocale } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'

function fileUrl(value: string): string {
  if (value.startsWith('file:///')) return value
  return `file://${value.startsWith('/') ? '' : '/'}${encodeURI(value)}`
}

export function PluginBundlesPage(
  { model, snapshot, router }: {
    readonly model: ManagerModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
  },
) {
  const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
  const bundles = snapshot.pluginBundles?.bundles ?? []
  const [source, setSource] = useState('')
  const [candidate, setCandidate] = useState<CordisXPluginBundleLifecycleResultV1>()
  const [policies, setPolicies] = useState<Record<string, CordisXPluginBundlePolicy>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const inspect = async () => {
    if (model.requestPluginBundleLifecycle === undefined || source.trim() === '') return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await model.requestPluginBundleLifecycle({
        kind: 'inspect-source',
        source: { kind: 'local-directory', location: fileUrl(source.trim()) },
      })
      setCandidate(result)
      setPolicies(Object.fromEntries((result.plan?.permissionRequests ?? []).map(item => [item.permissionId, 'ask'])))
      setMessage(result.error?.message)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const install = async () => {
    if (
      model.requestPluginBundleLifecycle === undefined || candidate?.candidateId === undefined
      || candidate.impactToken === undefined || candidate.plan === undefined
    ) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await model.requestPluginBundleLifecycle({
        kind: bundles.some(item => item.id === candidate.bundleId) ? 'update' : 'install',
        candidateId: candidate.candidateId,
        impactToken: candidate.impactToken,
        bundlePermissions: candidate.plan.permissionRequests.map(item => ({
          permissionId: item.permissionId,
          policy: policies[item.permissionId] ?? 'ask',
        })),
        pluginOverrides: [],
      })
      setMessage(result.error?.message ?? (zh ? `操作结果：${result.outcome}` : `Result: ${result.outcome}`))
      if (result.outcome === 'applied') {
        setCandidate(undefined)
        setSource('')
        setPolicies({})
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const requiredReady =
    candidate?.plan?.permissionRequests.every(item => !item.required || policies[item.permissionId] === 'allow')
      ?? false
  return (
    <section className="cxr-page" data-plugin-bundles-page="true">
      <section className="cxr-section cxr-bundle-import">
        <h3>{zh ? '安装本地插件包' : 'Install a local plugin bundle'}</h3>
        <p>
          {zh
            ? '选择包含 cordisx-bundle.json 的目录。Host 会先预检全部成员和权限，再允许安装。'
            : 'Choose a directory containing cordisx-bundle.json. The Host reviews every member and permission before install.'}
        </p>
        <div className="cxr-bundle-source-row">
          <input
            data-bundle-source="true"
            value={source}
            aria-label={zh ? '插件包目录' : 'Bundle directory'}
            placeholder={zh ? '/绝对路径/到/插件包' : '/absolute/path/to/bundle'}
            onChange={event => setSource(event.currentTarget.value)}
          />
          <Button
            data-bundle-inspect="true"
            theme="primary"
            loading={busy}
            disabled={model.requestPluginBundleLifecycle === undefined || source.trim() === ''}
            onClick={() => void inspect()}
          >
            {zh ? '预检' : 'Inspect'}
          </Button>
        </div>
        {candidate?.plan === undefined
          ? null
          : (
            <div className="cxr-bundle-plan" data-bundle-install-plan={candidate.bundleId}>
              <strong>{candidate.plan.bundle.name} · {candidate.plan.bundle.version}</strong>
              <div className="cxr-list">
                {candidate.plan.memberActions.map(item => (
                  <div className="cxr-card" key={item.pluginId}>
                    <span className="cxr-card-body">
                      <span className="cxr-card-title">{item.pluginId}</span>
                      <span className="cxr-card-description">{item.action} · {item.reason}</span>
                    </span>
                    <code>{item.version}</code>
                  </div>
                ))}
              </div>
              {candidate.plan.permissionRequests.length === 0 ? null : (
                <section className="cxr-section">
                  <h4>{zh ? '统一权限' : 'Unified permissions'}</h4>
                  <p>
                    {zh
                      ? '新增权限默认询问；必需权限必须明确允许后才能安装。'
                      : 'New permissions default to ask; required permissions need an explicit allow.'}
                  </p>
                  {candidate.plan.permissionRequests.map(item => (
                    <label className="cxr-bundle-permission-row" key={item.permissionId}>
                      <span>
                        <strong>{item.capability}</strong>
                        <small>{item.pluginId} · {item.scopeLabel}</small>
                      </span>
                      <select
                        data-bundle-policy-id={item.permissionId}
                        value={policies[item.permissionId] ?? 'ask'}
                        onChange={event =>
                          setPolicies(current => ({
                            ...current,
                            [item.permissionId]: event.currentTarget.value as CordisXPluginBundlePolicy,
                          }))}
                      >
                        <option value="ask">{zh ? '询问' : 'Ask'}</option>
                        <option value="allow">{zh ? '允许' : 'Allow'}</option>
                        <option value="deny">{zh ? '拒绝' : 'Deny'}</option>
                      </select>
                    </label>
                  ))}
                </section>
              )}
              <Button
                data-bundle-install="true"
                theme="primary"
                loading={busy}
                disabled={candidate.outcome !== 'planned' || !requiredReady}
                onClick={() => void install()}
              >
                {zh ? '安装插件包' : 'Install bundle'}
              </Button>
            </div>
          )}
        {message === undefined ? null : <div className="cxr-notice" role="status">{message}</div>}
      </section>
      <div className="cxr-list" role="list" aria-label={zh ? '已安装插件包' : 'Installed plugin bundles'}>
        {bundles.map(bundle => (
          <button
            type="button"
            className="cxr-plugin-row cxr-bundle-row"
            role="listitem"
            key={bundle.id}
            data-plugin-bundle-id={bundle.id}
            onClick={() => router.navigate({ kind: 'plugin-bundle', bundleId: bundle.id, page: 'readme' })}
          >
            <span className="cxr-card-icon">
              <HostIcon token="plugins" />
            </span>
            <span className="cxr-card-body">
              <span className="cxr-card-title">{bundle.name}</span>
              <span className="cxr-card-description">{bundle.description}</span>
              <code className="cxr-card-code">{bundle.id} · {bundle.members.length} {zh ? '个成员' : 'members'}</code>
            </span>
            <span
              className="cxr-status"
              data-tone={bundle.status.includes('conflict') || bundle.status.includes('failed') ? 'danger' : undefined}
            >
              {bundle.status}
            </span>
          </button>
        ))}
        {bundles.length === 0
          ? <div className="cxr-empty">{zh ? '还没有安装插件包。' : 'No plugin bundles installed.'}</div>
          : null}
      </div>
    </section>
  )
}
