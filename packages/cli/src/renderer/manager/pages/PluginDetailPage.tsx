import { useState } from 'react'
import { projectPermissionCapabilityName } from '../../../permission-locales.js'
import { Button } from 'tdesign-react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../contracts.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from '../../manager.js'
import { managerCopy, productLocale } from '../../ui-copy.js'
import { HostForm } from '../../host-ui/HostForm.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { PluginConsolePanel } from '../components/PluginConsolePanel.js'
import { MarkdownDocument } from '../components/MarkdownDocument.js'
import { ManagerTabs, type ManagerTab } from '../components/ManagerTabs.js'
import { PluginIdentityIcon } from '../components/PluginIdentityIcon.js'
import type { ManagerRouter, PluginDetailPage as PluginDetailTab } from '../model/routes.js'

function tabs(locale: string): readonly ManagerTab<PluginDetailTab>[] { return [
  { id: 'readme', label: 'README', icon: 'document' }, { id: 'config', label: managerCopy(locale, 'plugin-tab.configuration'), icon: 'configuration' }, { id: 'permissions', label: managerCopy(locale, 'plugin-tab.permissions'), icon: 'permissions' },
  { id: 'runtime', label: managerCopy(locale, 'plugin-tab.runtime'), icon: 'runtime' }, { id: 'logs', label: managerCopy(locale, 'plugin-tab.logs'), icon: 'diagnostics' }, { id: 'extension-points', label: managerCopy(locale, 'plugin-tab.extension-points'), icon: 'outlets' }, { id: 'routes', label: managerCopy(locale, 'plugin-tab.routes'), icon: 'routes' },
] }

function RuntimePanel({ model, plugin, permissionCount, pointCount, routeCount, locale }: { readonly model: ManagerModel; readonly plugin: ManagerPluginSnapshot; readonly permissionCount: number; readonly pointCount: number; readonly routeCount: number; readonly locale: string }) {
  const consoleEntries = model.pluginConsole?.(plugin.id).entries ?? []
  const consoleMetrics = [
    [managerCopy(locale, 'plugins.metric.requests'), consoleEntries.filter(entry => entry.kind === 'invocation').length],
    [managerCopy(locale, 'plugins.metric.successes'), consoleEntries.filter(entry => entry.status === 'success').length],
    [managerCopy(locale, 'plugins.metric.failures'), consoleEntries.filter(entry => entry.status === 'failure').length],
    [managerCopy(locale, 'plugins.metric.denials'), consoleEntries.filter(entry => entry.status === 'denied').length],
  ] as const
  const metrics = [
    [managerCopy(locale, 'plugins.metric.status'), plugin.status],
    [managerCopy(locale, 'plugins.metric.permissions'), String(permissionCount)],
    [managerCopy(locale, 'plugins.metric.extension-points'), String(pointCount)],
    [managerCopy(locale, 'plugins.metric.routes'), String(routeCount)],
    [managerCopy(locale, 'plugins.metric.injected-capabilities'), String(plugin.inject.length)],
    [managerCopy(locale, 'plugins.metric.dependencies'), String(plugin.package?.dependencies.length ?? 0)],
  ] as const
  return <div className="cxm-runtime-overview">
    {plugin.development === undefined ? null : <section className="cxr-section" data-plugin-development={plugin.development.state}>
      <h3>{managerCopy(locale, 'plugins.local-development')}</h3>
      <dl className="cxr-facts">
        <div><dt>{managerCopy(locale, 'plugins.source-path')}</dt><dd><code>{plugin.development.sourcePath}</code></dd></div>
        <div><dt>{managerCopy(locale, 'plugins.build-status')}</dt><dd>{plugin.development.state}</dd></div>
        {plugin.development.lastSuccessfulAt === undefined ? null : <div><dt>{managerCopy(locale, 'plugins.last-success')}</dt><dd>{plugin.development.lastSuccessfulAt}</dd></div>}
      </dl>
      {plugin.development.error === undefined ? null : <div className="cxr-notice cxr-danger" role="alert">{plugin.development.error}</div>}
    </section>}
    <section data-plugin-runtime-status={plugin.id}><strong>{plugin.status}</strong>{plugin.error === undefined ? null : <span>{plugin.error}</span>}</section>
    <div className="cxr-metrics">{metrics.map(([label, value]) => <section className="cxr-metric" key={label}><span>{label}</span><strong>{value}</strong></section>)}</div>
    <section className="cxm-runtime-console-summary" data-runtime-console-summary={plugin.id}>{consoleMetrics.map(([label, value]) => <div className="cxm-runtime-console-metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}</section>
    {plugin.error === undefined ? null : <div className="cxr-notice cxr-danger" role="alert">{plugin.error}</div>}
    <section className="cxr-section" style={{ marginTop: 10 }}><h3>{managerCopy(locale, 'plugins.injected-capabilities')}</h3><div className="cxr-token-list">{plugin.inject.map(item => <code key={item}>{item}</code>)}{plugin.inject.length === 0 ? <span>{managerCopy(locale, 'plugins.none')}</span> : null}</div></section>
  </div>
}

export function PluginDetailPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const route = router.route
  if (route.kind !== 'plugin') return null
  const plugin = snapshot.plugins.find(item => item.id === route.pluginId)
  if (plugin === undefined) return <div className="cxr-empty">{managerCopy(snapshot.localization.locale, 'plugins.missing')}</div>
  const permissions = snapshot.permissions.filter(item => item.identity.id === plugin.id && item.identity.source === plugin.source)
  const pointUsage = (snapshot.extensionPoints?.points ?? []).filter(point => point.plugins.some(item => item.identity.id === plugin.id && item.identity.source === plugin.source))
  const routes = snapshot.navigation.routes.filter(item => item.owner === plugin.id)
  const normalized = query.trim().toLocaleLowerCase()
  const visiblePoints = pointUsage.filter(point => `${point.titleProjection.text} ${point.descriptionProjection.text} ${point.id}`.toLocaleLowerCase().includes(normalized))
  const visibleRoutes = routes.filter(item => `${item.productMetadata.title ?? ''} ${item.productMetadata.description ?? ''} ${item.qualifiedId} ${item.definition.path}`.toLocaleLowerCase().includes(normalized))
  const run = async (operation: CordisXPluginLifecycleOperationV1) => {
    if (model.requestPluginLifecycle === undefined) return
    setBusy(true); setMessage(undefined)
    try {
      let result = await model.requestPluginLifecycle(operation)
      if ((operation.kind === 'disable' || operation.kind === 'uninstall') && result.outcome === 'planned' && result.impactToken !== undefined) {
        const affected = result.affectedPluginIds.join(productLocale(snapshot.localization.locale) === 'zh-CN' ? '、' : ', ') || plugin.name
        const prompt = productLocale(snapshot.localization.locale) === 'zh-CN'
          ? `此操作会影响：${affected}。继续吗？`
          : `This action affects: ${affected}. Continue?`
        if (!window.confirm(prompt)) return
        result = await model.requestPluginLifecycle({ ...operation, impactToken: result.impactToken })
      }
      setMessage(result.error?.message ?? `${managerCopy(snapshot.localization.locale, 'plugins.operation-result')}: ${result.outcome}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const sourceLink = plugin.package?.canonicalSource
  const packageLifecycleAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
  return <section className="cxr-page" data-plugin-detail={plugin.id}>
    <section className="cxr-plugin-identity" aria-label={managerCopy(snapshot.localization.locale, 'plugins.details-actions')}>
      <PluginIdentityIcon pluginId={plugin.id} name={plugin.name} icon={plugin.icon} status={plugin.status} />
      <span className="cxr-plugin-identity-copy"><strong>{plugin.name}</strong><span className="cxr-plugin-identity-meta"><span>{plugin.development === undefined ? plugin.package?.version ?? managerCopy(snapshot.localization.locale, 'plugins.development') : managerCopy(snapshot.localization.locale, 'plugins.local-development')}</span><code>{plugin.id}</code>{sourceLink === undefined ? null : <a href={sourceLink} target="_blank" rel="noopener noreferrer">{managerCopy(snapshot.localization.locale, 'plugins.project-link')}</a>}</span></span>
      <span className="cxr-plugin-identity-actions">
        <Button shape="square" variant="outline" aria-label={managerCopy(snapshot.localization.locale, 'plugins.reload')} title={managerCopy(snapshot.localization.locale, 'plugins.reload')} data-plugin-lifecycle-action="reload" icon={<HostIcon token="reload-plugin" />} loading={busy} disabled={model.requestPluginLifecycle === undefined || (plugin.developmentReloadAvailable !== true && !packageLifecycleAvailable) || plugin.status !== 'active'} onClick={() => void run({ kind: 'reload', pluginId: plugin.id })} />
        {plugin.status === 'configured-disabled'
          ? <Button shape="square" theme="primary" aria-label={managerCopy(snapshot.localization.locale, 'plugins.enable')} title={managerCopy(snapshot.localization.locale, 'plugins.enable')} data-plugin-lifecycle-action="enable" icon={<HostIcon token="enable-plugin" />} loading={busy} disabled={!packageLifecycleAvailable} onClick={() => void run({ kind: 'enable', pluginId: plugin.id })} />
          : <Button shape="square" variant="outline" aria-label={managerCopy(snapshot.localization.locale, 'plugins.disable')} title={managerCopy(snapshot.localization.locale, 'plugins.disable')} data-plugin-lifecycle-action="disable" icon={<HostIcon token="disable-plugin" />} loading={busy} disabled={!packageLifecycleAvailable} onClick={() => void run({ kind: 'disable', pluginId: plugin.id, impactToken: '' })} />}
        <Button shape="square" variant="outline" theme="danger" aria-label={managerCopy(snapshot.localization.locale, 'plugins.uninstall')} title={managerCopy(snapshot.localization.locale, 'plugins.uninstall')} data-plugin-lifecycle-action="uninstall" icon={<HostIcon token="uninstall-plugin" />} loading={busy} disabled={!packageLifecycleAvailable} onClick={() => void run({ kind: 'uninstall', pluginId: plugin.id, impactToken: '' })} />
      </span>
    </section>
    {message === undefined ? null : <div className="cxr-notice" role="status">{message}</div>}
    <ManagerTabs label={managerCopy(snapshot.localization.locale, 'plugins.details-tabs')} tabs={tabs(snapshot.localization.locale)} value={route.page} onChange={page => { setQuery(''); router.navigate({ kind: 'plugin', pluginId: plugin.id, page }) }} />
    {route.page === 'readme' && <div role="tabpanel" aria-label="README"><MarkdownDocument source={plugin.readme ?? plugin.description ?? managerCopy(snapshot.localization.locale, 'plugins.no-readme')} /></div>}
    {route.page === 'config' && <div className="cxr-plugin-config-panel" role="tabpanel" aria-label={managerCopy(snapshot.localization.locale, 'plugin-tab.configuration')}><HostForm model={model} plugin={plugin} /></div>}
    {route.page === 'permissions' && <div className="cxr-list">{permissions.map(item => <button className="cxr-card" type="button" key={item.fingerprint} onClick={() => router.navigate({ kind: 'permission', pluginId: plugin.id, capability: item.capability, fingerprint: item.fingerprint })}><span className="cxr-card-body"><span className="cxr-card-title">{projectPermissionCapabilityName(item.capability, snapshot.localization.locale)}</span><span className="cxr-card-description">{item.reasonText}</span><code className="cxr-card-code">{item.capability}</code></span><span className="cxr-status">{item.policy}</span></button>)}{permissions.length === 0 ? <div className="cxr-empty">{managerCopy(snapshot.localization.locale, 'plugins.no-permissions')}</div> : null}</div>}
    {route.page === 'runtime' && <RuntimePanel model={model} plugin={plugin} permissionCount={permissions.length} pointCount={pointUsage.length} routeCount={routes.length} locale={snapshot.localization.locale} />}
    {route.page === 'logs' && <PluginConsolePanel model={model} pluginId={plugin.id} pluginSource={plugin.source} locale={snapshot.localization.locale} />}
    {route.page === 'extension-points' && <><SearchField className="cxr-search" value={query} aria-label={managerCopy(snapshot.localization.locale, 'plugins.search-extension-points')} placeholder={managerCopy(snapshot.localization.locale, 'plugins.search-extension-points-placeholder')} onChange={setQuery} /><div className="cxr-list">{visiblePoints.map(point => <button type="button" className="cxr-card" key={point.id} onClick={() => router.navigate({ kind: 'extension-point', pointId: point.id })}><span className="cxr-card-body"><span className="cxr-card-title">{point.titleProjection.text}</span><span className="cxr-card-description">{point.descriptionProjection.text}</span><code className="cxr-card-code">{point.id}</code></span></button>)}{visiblePoints.length === 0 ? <div className="cxr-empty">{managerCopy(snapshot.localization.locale, pointUsage.length === 0 ? 'plugins.no-extension-points' : 'plugins.no-matching-extension-points')}</div> : null}</div></>}
    {route.page === 'routes' && <><SearchField className="cxr-search" value={query} aria-label={managerCopy(snapshot.localization.locale, 'plugins.search-routes')} placeholder={managerCopy(snapshot.localization.locale, 'plugins.search-routes-placeholder')} onChange={setQuery} /><div className="cxr-list">{visibleRoutes.map(item => <button type="button" className="cxr-card" key={item.qualifiedId} onClick={() => router.navigate({ kind: 'route', qualifiedId: item.qualifiedId })}><span className="cxr-card-body"><span className="cxr-card-title">{item.productMetadata.title ?? item.qualifiedId}</span><span className="cxr-card-description">{item.productMetadata.description}</span><code className="cxr-card-code">{item.definition.path}</code></span></button>)}{visibleRoutes.length === 0 ? <div className="cxr-empty">{managerCopy(snapshot.localization.locale, routes.length === 0 ? 'plugins.no-routes' : 'plugins.no-matching-routes')}</div> : null}</div></>}
  </section>
}
