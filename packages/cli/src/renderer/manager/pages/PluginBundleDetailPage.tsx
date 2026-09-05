import { useEffect, useMemo, useState } from 'react'
import { Button } from 'tdesign-react'
import type {
  CordisXPluginBundleLifecycleOperationV1,
  CordisXPluginBundlePolicy,
} from '../../../plugin-bundle-contracts.js'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { productLocale } from '../../ui-copy.js'
import { type ManagerTab, ManagerTabs } from '../components/ManagerTabs.js'
import { MarkdownDocument } from '../components/MarkdownDocument.js'
import type { ManagerRouter, PluginBundleDetailPage as BundleTab } from '../model/routes.js'

function tabs(zh: boolean): readonly ManagerTab<BundleTab>[] {
  return [
    { id: 'readme', label: 'README', icon: 'document' },
    { id: 'members', label: zh ? '成员' : 'Members', icon: 'plugins' },
    { id: 'permissions', label: zh ? '权限' : 'Permissions', icon: 'permissions' },
    { id: 'relations', label: zh ? '关联' : 'Relations', icon: 'routes' },
    { id: 'records', label: zh ? '记录' : 'Records', icon: 'diagnostics' },
  ]
}

export function PluginBundleDetailPage(
  { model, snapshot, router }: {
    readonly model: ManagerModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
  },
) {
  const route = router.route
  if (route.kind !== 'plugin-bundle') return null
  const bundle = snapshot.pluginBundles?.bundles.find(item => item.id === route.bundleId)
  const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [query, setQuery] = useState('')
  const [bundlePolicies, setBundlePolicies] = useState<Record<string, CordisXPluginBundlePolicy>>({})
  const [overrides, setOverrides] = useState<Record<string, CordisXPluginBundlePolicy | 'inherit'>>({})
  const operationsAvailable = model.requestPluginBundleLifecycle !== undefined
    && snapshot.pluginBundles?.operationsAvailable === true
  useEffect(() => {
    if (bundle === undefined) return
    setBundlePolicies(Object.fromEntries(bundle.permissions.map(item => [item.permissionId, item.bundlePolicy])))
    setOverrides(
      Object.fromEntries(bundle.permissions.map(item => [item.permissionId, item.pluginOverride ?? 'inherit'])),
    )
  }, [bundle?.id, bundle?.updatedAt])
  if (bundle === undefined) return <div className="cxr-empty">{zh ? '插件包不存在。' : 'Plugin bundle not found.'}</div>

  const run = async (operation: CordisXPluginBundleLifecycleOperationV1) => {
    if (model.requestPluginBundleLifecycle === undefined) return
    setBusy(true)
    setMessage(undefined)
    try {
      let result = await model.requestPluginBundleLifecycle(operation)
      if (
        'impactToken' in operation && operation.impactToken === '' && result.outcome === 'planned'
        && result.impactToken !== undefined
      ) {
        const affected = result.affectedPluginIds.join(zh ? '、' : ', ') || bundle.name
        if (
          !window.confirm(zh ? `此操作会影响：${affected}。继续吗？` : `This action affects: ${affected}. Continue?`)
        ) return
        result = await model.requestPluginBundleLifecycle({ ...operation, impactToken: result.impactToken })
      }
      setMessage(result.error?.message ?? (zh ? `操作结果：${result.outcome}` : `Result: ${result.outcome}`))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const savePermissions = async () => {
    if (model.requestPluginBundleLifecycle === undefined) return
    const assignment = bundle.permissions.map(item => ({
      permissionId: item.permissionId,
      policy: bundlePolicies[item.permissionId] ?? 'ask',
    }))
    const pluginOverrides = bundle.permissions.flatMap(item =>
      overrides[item.permissionId] === 'inherit' || overrides[item.permissionId] === undefined
        ? []
        : [{
          pluginId: item.pluginId,
          permissionId: item.permissionId,
          policy: overrides[item.permissionId] as CordisXPluginBundlePolicy,
        }]
    )
    const clearPluginOverrides = bundle.permissions.flatMap(item =>
      item.pluginOverride !== undefined && overrides[item.permissionId] === 'inherit'
        ? [{ pluginId: item.pluginId, permissionId: item.permissionId }]
        : []
    )
    setBusy(true)
    setMessage(undefined)
    try {
      const preview = await model.requestPluginBundleLifecycle({
        kind: 'set-permissions',
        bundleId: bundle.id,
        bundlePermissions: assignment,
        pluginOverrides,
        clearPluginOverrides,
        impactToken: '',
      })
      if (preview.outcome !== 'planned' || preview.impactToken === undefined) {
        throw new Error(preview.error?.message ?? 'permission preview failed')
      }
      if (
        !window.confirm(
          zh
            ? '权限调整会影响共享此插件的所有插件包。继续吗？'
            : 'Permission changes affect every bundle sharing the plugin. Continue?',
        )
      ) return
      const applied = await model.requestPluginBundleLifecycle({
        kind: 'set-permissions',
        bundleId: bundle.id,
        bundlePermissions: assignment,
        pluginOverrides,
        clearPluginOverrides,
        impactToken: preview.impactToken,
      })
      if (applied.outcome !== 'applied') throw new Error(applied.error?.message ?? 'permission update failed')
      setMessage(zh ? '权限已更新。' : 'Permissions updated.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const normalized = query.trim().toLocaleLowerCase()
  const members = useMemo(
    () =>
      bundle.members.filter(item =>
        normalized === ''
        || `${item.name ?? ''} ${item.pluginId} ${item.state}`.toLocaleLowerCase().includes(normalized)
      ),
    [bundle.members, normalized],
  )
  return (
    <section className="cxr-page" data-plugin-bundle-detail={bundle.id}>
      <section
        className="cxr-plugin-identity cxr-bundle-identity"
        aria-label={zh ? '插件包信息与操作' : 'Bundle information and actions'}
      >
        <span className="cxr-card-icon">
          <HostIcon token="plugins" />
        </span>
        <span className="cxr-plugin-identity-copy">
          <strong>{bundle.name}</strong>
          <span className="cxr-plugin-identity-meta">
            <span>{bundle.status}</span>
            <span>{bundle.authors.join(', ')}</span>
            <span>{bundle.sourceLabel}</span>
            <span>{bundle.version}</span>
            <code>{bundle.digest}</code>
            <time dateTime={bundle.updatedAt}>{new Date(bundle.updatedAt).toLocaleString()}</time>
          </span>
        </span>
        <span className="cxr-plugin-identity-actions">
          <Button
            data-bundle-action="update"
            shape="square"
            variant="outline"
            title={zh ? '选择新版本' : 'Choose new version'}
            aria-label={zh ? '更新插件包' : 'Update bundle'}
            icon={<HostIcon token="reload-plugin" />}
            onClick={() => router.navigate({ kind: 'primary', page: 'plugin-bundles' })}
          />
          {bundle.enabled
            ? (
              <Button
                data-bundle-action="disable"
                shape="square"
                variant="outline"
                title={zh ? '停用' : 'Disable'}
                aria-label={zh ? '停用插件包' : 'Disable bundle'}
                icon={<HostIcon token="disable-plugin" />}
                loading={busy}
                disabled={!operationsAvailable}
                onClick={() => void run({ kind: 'disable', bundleId: bundle.id, impactToken: '' })}
              />
            )
            : (
              <Button
                data-bundle-action="enable"
                shape="square"
                theme="primary"
                title={zh ? '启用' : 'Enable'}
                aria-label={zh ? '启用插件包' : 'Enable bundle'}
                icon={<HostIcon token="enable-plugin" />}
                loading={busy}
                disabled={!operationsAvailable}
                onClick={() => void run({ kind: 'enable', bundleId: bundle.id, impactToken: '' })}
              />
            )}
          <Button
            data-bundle-action="repair"
            shape="square"
            variant="outline"
            title={zh ? '修复' : 'Repair'}
            aria-label={zh ? '修复插件包' : 'Repair bundle'}
            icon={<HostIcon token="diagnostics" />}
            loading={busy}
            disabled={!operationsAvailable || !bundle.availableOperations.includes('repair')}
            onClick={() => void run({ kind: 'enable', bundleId: bundle.id, impactToken: '' })}
          />
          <Button
            data-bundle-action="uninstall"
            shape="square"
            variant="outline"
            theme="danger"
            title={zh ? '卸载' : 'Uninstall'}
            aria-label={zh ? '卸载插件包' : 'Uninstall bundle'}
            icon={<HostIcon token="uninstall-plugin" />}
            loading={busy}
            disabled={!operationsAvailable}
            onClick={() => void run({ kind: 'uninstall', bundleId: bundle.id, impactToken: '' })}
          />
        </span>
      </section>
      {message === undefined ? null : <div className="cxr-notice" role="status">{message}</div>}
      <ManagerTabs
        label={zh ? '插件包详情' : 'Bundle details'}
        tabs={tabs(zh)}
        value={route.page}
        onChange={page => {
          setQuery('')
          router.navigate({ kind: 'plugin-bundle', bundleId: bundle.id, page })
        }}
      />
      {route.page === 'readme' && (
        <div role="tabpanel" aria-label="README" data-bundle-readme-only="true">
          <MarkdownDocument source={bundle.readme} />
        </div>
      )}
      {route.page === 'members' && (
        <div role="tabpanel" aria-label={zh ? '成员' : 'Members'}>
          <SearchField
            className="cxr-search"
            value={query}
            aria-label={zh ? '搜索成员' : 'Search members'}
            placeholder={zh ? '搜索成员' : 'Search members'}
            onChange={setQuery}
          />
          <div className="cxr-list">
            {members.map(member => (
              <div className="cxr-card" key={member.pluginId} data-bundle-member={member.pluginId}>
                <span className="cxr-card-body">
                  <span className="cxr-card-title">
                    {member.name ?? member.pluginId}
                    <span className="cxr-badge">
                      {member.required ? (zh ? '必需' : 'Required') : (zh ? '可选' : 'Optional')}
                    </span>
                  </span>
                  <span className="cxr-card-description">
                    {member.state} · {zh ? '要求' : 'requested'} {member.requestedVersion} ·{' '}
                    {zh ? '已安装' : 'installed'} {member.installedVersion ?? '—'}
                  </span>
                  <code className="cxr-card-code">
                    {member.pluginId}
                    {member.bundleIds.length > 1
                      ? ` · ${zh ? '共享于' : 'shared by'} ${member.bundleIds.join(', ')}`
                      : ''}
                  </code>
                </span>
                <span className="cxr-actions">
                  {member.directClaim
                    ? null
                    : (
                      <Button
                        size="small"
                        variant="outline"
                        onClick={() =>
                          void run({
                            kind: 'adopt-member',
                            bundleId: bundle.id,
                            pluginId: member.pluginId,
                            impactToken: '',
                          })}
                      >
                        {zh ? '保留为直接安装' : 'Keep directly'}
                      </Button>
                    )}
                  {member.required
                    ? null
                    : (
                      <Button
                        size="small"
                        variant="outline"
                        onClick={() =>
                          void run({
                            kind: 'set-optional-member',
                            bundleId: bundle.id,
                            pluginId: member.pluginId,
                            enabled: !member.enabled,
                            impactToken: '',
                          })}
                      >
                        {member.enabled ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}
                      </Button>
                    )}
                </span>
              </div>
            ))}
            {members.length === 0
              ? <div className="cxr-empty">{zh ? '没有匹配的成员。' : 'No matching members.'}</div>
              : null}
          </div>
        </div>
      )}
      {route.page === 'permissions' && (
        <div role="tabpanel" aria-label={zh ? '权限' : 'Permissions'} className="cxr-bundle-permissions">
          <div className="cxr-notice">
            {zh
              ? '插件包策略统一管理；单插件覆盖对所有共享该插件的插件包生效。运行时仍按具体插件身份授权。'
              : 'Bundle policy manages defaults; a plugin override affects every bundle sharing that plugin. Runtime authority remains plugin-scoped.'}
          </div>
          {bundle.permissions.map(permission => (
            <div className="cxr-card cxr-bundle-permission-editor" key={permission.permissionId}>
              <span className="cxr-card-body">
                <span className="cxr-card-title">
                  {permission.capability}
                  <span className="cxr-badge">
                    {permission.required ? (zh ? '必需' : 'Required') : (zh ? '可选' : 'Optional')}
                  </span>
                </span>
                <span className="cxr-card-description">{permission.pluginId} · {permission.scopeLabel}</span>
                <code className="cxr-card-code">
                  {zh ? '当前有效' : 'Effective'}: {permission.effectivePolicy} ({permission.effectiveSource})
                </code>
              </span>
              <label>
                <span>{zh ? '插件包' : 'Bundle'}</span>
                <select
                  disabled={!operationsAvailable}
                  value={bundlePolicies[permission.permissionId] ?? 'ask'}
                  onChange={event =>
                    setBundlePolicies(current => ({
                      ...current,
                      [permission.permissionId]: event.currentTarget.value as CordisXPluginBundlePolicy,
                    }))}
                >
                  <option value="ask">ask</option>
                  <option value="allow">allow</option>
                  <option value="deny">deny</option>
                </select>
              </label>
              <label>
                <span>{zh ? '单插件覆盖' : 'Plugin override'}</span>
                <select
                  disabled={!operationsAvailable}
                  value={overrides[permission.permissionId] ?? 'inherit'}
                  onChange={event =>
                    setOverrides(current => ({
                      ...current,
                      [permission.permissionId]: event.currentTarget.value as CordisXPluginBundlePolicy | 'inherit',
                    }))}
                >
                  <option value="inherit">{zh ? '继承' : 'Inherit'}</option>
                  <option value="ask">ask</option>
                  <option value="allow">allow</option>
                  <option value="deny">deny</option>
                </select>
              </label>
            </div>
          ))}
          <div className="cxr-actions">
            <Button
              theme="primary"
              loading={busy}
              disabled={!operationsAvailable}
              onClick={() =>
                void savePermissions()}
            >
              {zh ? '保存权限' : 'Save permissions'}
            </Button>
          </div>
        </div>
      )}
      {route.page === 'relations' && (
        <div role="tabpanel" aria-label={zh ? '关联' : 'Relations'} className="cxr-grid">
          <section className="cxr-section">
            <h3>{zh ? '安装声明' : 'Ownership claims'}</h3>
            <div className="cxr-list">
              {bundle.claims.map((claim, index) => (
                <div className="cxr-card" key={`${claim.pluginId}:${claim.kind}:${claim.claimantId}:${index}`}>
                  <span className="cxr-card-body">
                    <span className="cxr-card-title">{claim.pluginId}</span>
                    <span className="cxr-card-description">{claim.kind} · {claim.claimantId}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="cxr-section">
            <h3>{zh ? '运行依赖' : 'Runtime dependencies'}</h3>
            <div className="cxr-list">
              {bundle.dependencies.map(edge => (
                <div className="cxr-card" key={`${edge.pluginId}:${edge.dependencyId}`}>
                  <span className="cxr-card-body">
                    <span className="cxr-card-title">{edge.pluginId} → {edge.dependencyId}</span>
                    <span className="cxr-card-description">{edge.version}</span>
                  </span>
                </div>
              ))}
              {bundle.dependencies.length === 0
                ? <div className="cxr-empty">{zh ? '无成员依赖。' : 'No member dependencies.'}</div>
                : null}
            </div>
          </section>
        </div>
      )}
      {route.page === 'records' && (
        <div role="tabpanel" aria-label={zh ? '记录' : 'Records'} className="cxr-list">
          {bundle.records.map(record => (
            <div className="cxr-card" key={record.recordId}>
              <span className="cxr-card-body">
                <span className="cxr-card-title">{record.kind} · {record.outcome}</span>
                <span className="cxr-card-description">{record.message}</span>
                <code className="cxr-card-code">
                  {new Date(record.at).toLocaleString()} · {record.pluginIds.join(', ')}
                </code>
              </span>
            </div>
          ))}
          {bundle.records.length === 0
            ? <div className="cxr-empty">{zh ? '暂无记录。' : 'No records yet.'}</div>
            : null}
        </div>
      )}
    </section>
  )
}
