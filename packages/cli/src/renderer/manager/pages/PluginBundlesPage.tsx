import { useMemo, useState } from 'react'
import { Button } from 'tdesign-react'
import type { CordisXPluginLifecycleResultV1 } from '../../../contracts.js'
import type {
  CordisXPluginBundleLifecycleResultV1,
  CordisXPluginBundlePolicy,
} from '../../../plugin-bundle-contracts.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { productLocale } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'
import { requestPluginAuthorizationV2, requestPluginAuthorizationV4 } from '../permission-review.js'

export type UnifiedLocalInspection =
  | { readonly kind: 'bundle'; readonly result: CordisXPluginBundleLifecycleResultV1 }
  | { readonly kind: 'plugin'; readonly result: CordisXPluginLifecycleResultV1 }

function fileUrl(value: string): string {
  if (value.startsWith('file:///')) return value
  return `file://${value.startsWith('/') ? '' : '/'}${encodeURI(value)}`
}

/** Bundle manifests have priority; only an explicit invalid-bundle result may fall through. */
export async function inspectUnifiedLocalPluginSource(
  model: Pick<ManagerModel, 'requestPluginBundleLifecycle' | 'requestPluginLifecycle'>,
  sourceDirectory: string,
): Promise<UnifiedLocalInspection> {
  if (model.requestPluginBundleLifecycle !== undefined) {
    const bundle = await model.requestPluginBundleLifecycle({
      kind: 'inspect-source',
      source: { kind: 'local-directory', location: fileUrl(sourceDirectory) },
    })
    if (bundle.error?.code !== 'invalid-bundle') return { kind: 'bundle', result: bundle }
    if (model.requestPluginLifecycle === undefined) return { kind: 'bundle', result: bundle }
  }
  if (model.requestPluginLifecycle === undefined) throw new Error('Plugin lifecycle service is unavailable')
  return {
    kind: 'plugin',
    result: await model.requestPluginLifecycle({ kind: 'inspect-local', sourceDirectory }),
  }
}

export function LocalPluginInstallSection({ model, snapshot }: {
  readonly model: ManagerModel
  readonly snapshot: ManagerSnapshot
}) {
  const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
  const [source, setSource] = useState('')
  const [candidate, setCandidate] = useState<UnifiedLocalInspection>()
  const [policies, setPolicies] = useState<Record<string, CordisXPluginBundlePolicy>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const inspect = async () => {
    if (source.trim() === '') return
    setBusy(true)
    setMessage(undefined)
    setCandidate(undefined)
    try {
      const result = await inspectUnifiedLocalPluginSource(model, source.trim())
      setCandidate(result)
      if (result.kind === 'bundle') {
        setPolicies(Object.fromEntries(
          (result.result.plan?.permissionRequests ?? []).map(item => [item.permissionId, 'ask']),
        ))
      } else setPolicies({})
      setMessage(result.result.error?.message)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const installBundle = async (inspection: CordisXPluginBundleLifecycleResultV1) => {
    if (
      model.requestPluginBundleLifecycle === undefined || inspection.candidateId === undefined
      || inspection.impactToken === undefined || inspection.plan === undefined
    ) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await model.requestPluginBundleLifecycle({
        kind: (snapshot.pluginBundles?.bundles ?? []).some(item => item.id === inspection.bundleId)
          ? 'update'
          : 'install',
        candidateId: inspection.candidateId,
        impactToken: inspection.impactToken,
        bundlePermissions: inspection.plan.permissionRequests.map(item => ({
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
  const installPlugin = async (inspection: CordisXPluginLifecycleResultV1) => {
    if (
      model.requestPluginLifecycle === undefined || inspection.candidateId === undefined
      || inspection.package === undefined || (inspection.operation !== 'install' && inspection.operation !== 'update')
    ) return
    setBusy(true)
    setMessage(undefined)
    try {
      const target = { kind: 'candidate' as const, candidateId: inspection.candidateId }
      const planV4 = await model.permissionLifecycleReviewPlanV4?.(target)
      const planV2 = planV4 === undefined ? await model.permissionLifecycleReviewPlanV2?.(target) : undefined
      let result: CordisXPluginLifecycleResultV1 | undefined
      if (planV4 !== undefined) {
        if (model.applyPermissionLifecycleReviewV4 === undefined) {
          throw new Error('Plugin permission review v4 is unavailable')
        }
        const decision = await requestPluginAuthorizationV4(
          document,
          {
            id: inspection.package.id,
            name: inspection.package.name ?? inspection.package.id,
            source: planV4.identity.source,
          },
          planV4,
          snapshot.permissions.filter(item => item.identity.id === inspection.package!.id),
        )
        if (decision !== undefined) result = await model.applyPermissionLifecycleReviewV4(decision)
      } else if (planV2 !== undefined) {
        if (model.applyPermissionLifecycleReviewV2 === undefined) {
          throw new Error('Plugin permission review v2 is unavailable')
        }
        const decision = await requestPluginAuthorizationV2(
          document,
          {
            id: inspection.package.id,
            name: inspection.package.name ?? inspection.package.id,
            source: planV2.identity.source,
          },
          planV2,
          snapshot.permissions.filter(item => item.identity.id === inspection.package!.id),
        )
        if (decision !== undefined) result = await model.applyPermissionLifecycleReviewV2(decision)
      } else {
        throw new Error(
          zh
            ? '当前插件只提供旧版权限计划；Host 不会绕过现代权限审查安装。'
            : 'This plugin exposes only a legacy permission plan; the Host will not bypass modern review.',
        )
      }
      if (result === undefined) return
      setMessage(result.error?.message ?? (zh ? `操作结果：${result.outcome}` : `Result: ${result.outcome}`))
      if (result.outcome === 'applied') {
        setCandidate(undefined)
        setSource('')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const bundle = candidate?.kind === 'bundle' ? candidate.result : undefined
  const plugin = candidate?.kind === 'plugin' ? candidate.result : undefined
  const bundleReady = bundle?.plan?.permissionRequests.every(
    item => !item.required || policies[item.permissionId] === 'allow',
  ) ?? false
  return (
    <section className="cxr-section cxr-bundle-import" data-unified-local-install="true">
      <h3>{zh ? '从本地安装' : 'Install from local path'}</h3>
      <p>
        {zh
          ? '输入插件或插件包目录。Host 会识别清单并在任何安装前显示成员与权限审查。'
          : 'Enter a plugin or bundle directory. The Host identifies its manifest and reviews members and permissions before installation.'}
      </p>
      <div className="cxr-bundle-source-row">
        <input
          data-local-plugin-source="true"
          value={source}
          aria-label={zh ? '插件或插件包目录' : 'Plugin or bundle directory'}
          placeholder={zh ? '/绝对路径/到/插件或插件包' : '/absolute/path/to/plugin-or-bundle'}
          onChange={event => setSource(event.currentTarget.value)}
        />
        <Button
          data-local-plugin-inspect="true"
          theme="primary"
          loading={busy}
          disabled={source.trim() === ''
            || (model.requestPluginBundleLifecycle === undefined && model.requestPluginLifecycle === undefined)}
          onClick={() => void inspect()}
        >
          {zh ? '预检' : 'Inspect'}
        </Button>
      </div>
      {bundle?.plan === undefined
        ? null
        : (
          <div className="cxr-bundle-plan" data-local-candidate-kind="bundle">
            <strong>{bundle.plan.bundle.name} · {bundle.plan.bundle.version}</strong>
            <div className="cxr-list">
              {bundle.plan.memberActions.map(item => (
                <div className="cxr-card" key={item.pluginId}>
                  <span className="cxr-card-body">
                    <span className="cxr-card-title">{item.pluginId}</span>
                    <span className="cxr-card-description">{item.action} · {item.reason}</span>
                  </span>
                  <code>{item.version}</code>
                </div>
              ))}
            </div>
            {bundle.plan.permissionRequests.map(item => (
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
            <Button
              data-local-bundle-install="true"
              theme="primary"
              loading={busy}
              disabled={bundle.outcome !== 'planned' || !bundleReady}
              onClick={() => void installBundle(bundle)}
            >
              {zh ? '安装插件包' : 'Install bundle'}
            </Button>
          </div>
        )}
      {plugin?.package === undefined
        ? null
        : (
          <div className="cxr-bundle-plan" data-local-candidate-kind="plugin">
            <strong>{plugin.package.name ?? plugin.package.id} · {plugin.package.version}</strong>
            <p>
              {zh
                ? '下一步将打开现有 Host 权限审查。取消审查不会安装。'
                : 'The existing Host permission review opens next. Cancelling it does not install.'}
            </p>
            <Button
              data-local-plugin-install="true"
              theme="primary"
              loading={busy}
              disabled={plugin.outcome !== 'planned'}
              onClick={() => void installPlugin(plugin)}
            >
              {zh ? '审查权限并安装' : 'Review permissions and install'}
            </Button>
          </div>
        )}
      {message === undefined ? null : <div className="cxr-notice" role="status">{message}</div>}
    </section>
  )
}

export interface PluginBundlesPageProps {
  readonly snapshot: ManagerSnapshot
  readonly router: ManagerRouter
  readonly query: string
}

/** Bundle carriers are projected beside ordinary plugins; they never execute. */
export function PluginBundlesPage({ snapshot, router, query }: PluginBundlesPageProps) {
  const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
  const normalized = query.trim().toLocaleLowerCase()
  const bundles = useMemo(() =>
    (snapshot.pluginBundles?.bundles ?? []).filter(bundle => (
      normalized === ''
      || [bundle.name, bundle.id, bundle.description, bundle.sourceLabel, ...bundle.members.map(item => item.pluginId)]
        .filter((value): value is string => value !== undefined)
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized)
    )), [normalized, snapshot.pluginBundles?.bundles])
  return (
    <div
      className="cxr-list"
      role="list"
      aria-label={zh ? '已安装插件包' : 'Installed plugin bundles'}
      data-unified-plugin-results="bundles"
      data-plugin-bundles-page="true"
    >
      {bundles.map(bundle => (
        <button
          type="button"
          className="cxr-plugin-row cxr-bundle-row"
          role="listitem"
          key={bundle.id}
          data-plugin-bundle-id={bundle.id}
          data-plugin-result-type="bundle"
          data-plugin-result-source="installed"
          onClick={() => router.navigate({ kind: 'plugin-bundle', bundleId: bundle.id, page: 'readme' })}
        >
          <span className="cxr-card-icon">
            <HostIcon token="plugins" />
          </span>
          <span className="cxr-card-body">
            <span className="cxr-card-title">
              {bundle.name}
              <span className="cxr-badge">{zh ? '插件包' : 'Bundle'}</span>
            </span>
            <span className="cxr-card-description">{bundle.description}</span>
            <code className="cxr-card-code">
              {bundle.id} · {bundle.members.length} {zh ? '个成员' : 'members'} · {bundle.sourceLabel}
            </code>
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
        ? <div className="cxr-empty">{zh ? '没有匹配的插件包。' : 'No matching plugin bundles.'}</div>
        : null}
    </div>
  )
}
