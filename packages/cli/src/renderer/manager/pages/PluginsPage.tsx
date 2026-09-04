import { useMemo, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../contracts.js'
import type { ManagerSnapshot } from '../../manager.js'
import type { ManagerModel, ManagerPluginSnapshot } from '../../manager.js'
import { managerCopy, productLocale } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { PluginIdentityIcon } from '../components/PluginIdentityIcon.js'

export function PluginsPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const [query, setQuery] = useState('')
  const [busyPluginId, setBusyPluginId] = useState<string>()
  const normalized = query.trim().toLocaleLowerCase()
  const plugins = useMemo(() => snapshot.plugins.filter(plugin => normalized === '' || `${plugin.name} ${plugin.id} ${plugin.description ?? ''}`.toLocaleLowerCase().includes(normalized)), [normalized, snapshot.plugins])
  const pendingDevelopment = useMemo(() => (snapshot.localDevelopment ?? []).filter(item => (
    !snapshot.plugins.some(plugin => plugin.id === item.pluginId)
    && (normalized === '' || `${item.pluginId} ${item.sourcePath} ${item.error ?? ''}`.toLocaleLowerCase().includes(normalized))
  )), [normalized, snapshot.localDevelopment, snapshot.plugins])
  const packageLifecycleAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
  const run = async (plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1) => {
    if (model.requestPluginLifecycle === undefined) return
    setBusyPluginId(plugin.id)
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
      if (result.error !== undefined) window.alert(result.error.message)
    } finally { setBusyPluginId(undefined) }
  }
  return (
    <section className="cxr-page" aria-label={managerCopy(snapshot.localization.locale, 'plugins.heading')}>
      <SearchField className="cxr-search" value={query} aria-label={managerCopy(snapshot.localization.locale, 'plugins.search-label')} placeholder={managerCopy(snapshot.localization.locale, 'plugins.search-placeholder')} onChange={setQuery} />
      <div className="cxr-list" role="list">
        {pendingDevelopment.map(item => <div key={item.sourcePath} className="cxr-local-development-source" role="listitem" data-plugin-origin="local-dev" data-development-state={item.state}>
          <span className="cxr-card-body"><span className="cxr-card-title">{item.pluginId}<span className="cxr-badge">{managerCopy(snapshot.localization.locale, 'plugins.local-development')}</span></span><code className="cxr-card-code">{item.sourcePath}</code>{item.error === undefined ? null : <span className="cxr-local-development-error" role="alert">{item.error}</span>}</span>
          <strong>{item.state}</strong>
        </div>)}
        {plugins.map(plugin => (
          <div key={`${plugin.source}\0${plugin.id}`} className="cxr-plugin-row" role="listitem">
            <button className="cxr-plugin-primary" type="button" data-plugin-id={plugin.id} aria-label={`${managerCopy(snapshot.localization.locale, 'plugins.open')} · ${plugin.name}`} onClick={() => router.navigate({ kind: 'plugin', pluginId: plugin.id, page: 'readme' })}>
              <PluginIdentityIcon pluginId={plugin.id} name={plugin.name} icon={plugin.icon} status={plugin.status} />
              <span className="cxr-card-body"><span className="cxr-card-title">{plugin.name}{plugin.development === undefined ? null : <span className="cxr-badge" data-plugin-origin="local-dev">{managerCopy(snapshot.localization.locale, 'plugins.local-development')}</span>}</span><span className="cxr-card-description">{plugin.description}</span><code className="cxr-card-code">{plugin.id}</code></span>
            </button>
            <span className="cxr-plugin-actions">
              <IconButton icon={plugin.status === 'configured-disabled' ? 'enable-plugin' : 'disable-plugin'} label={managerCopy(snapshot.localization.locale, plugin.status === 'configured-disabled' ? 'plugins.enable' : 'plugins.disable')} loading={busyPluginId === plugin.id} disabled={!packageLifecycleAvailable || model.requestPluginLifecycle === undefined} onClick={() => void run(plugin, plugin.status === 'configured-disabled' ? { kind: 'enable', pluginId: plugin.id } : { kind: 'disable', pluginId: plugin.id, impactToken: '' })} />
              <IconButton icon="reload-plugin" label={managerCopy(snapshot.localization.locale, 'plugins.reload')} loading={busyPluginId === plugin.id} disabled={model.requestPluginLifecycle === undefined || (plugin.developmentReloadAvailable !== true && !packageLifecycleAvailable) || plugin.status !== 'active'} onClick={() => void run(plugin, { kind: 'reload', pluginId: plugin.id })} />
              <MoreMenu label={`${plugin.name} · ${managerCopy(snapshot.localization.locale, 'plugins.more-actions')}`} items={[
                { id: 'logs', label: managerCopy(snapshot.localization.locale, 'plugin-tab.logs'), icon: 'diagnostics', onSelect: () => router.navigate({ kind: 'plugin', pluginId: plugin.id, page: 'logs' }) },
                { id: 'uninstall', label: managerCopy(snapshot.localization.locale, 'plugins.uninstall'), icon: 'uninstall-plugin', disabled: !packageLifecycleAvailable || model.requestPluginLifecycle === undefined, onSelect: () => void run(plugin, { kind: 'uninstall', pluginId: plugin.id, impactToken: '' }) },
              ]} />
            </span>
          </div>
        ))}
        {plugins.length === 0 && pendingDevelopment.length === 0 ? <div className="cxr-empty">{managerCopy(snapshot.localization.locale, 'plugins.no-matches')}</div> : null}
      </div>
    </section>
  )
}
