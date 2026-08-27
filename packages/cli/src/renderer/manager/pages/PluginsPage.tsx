import { useMemo, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../contracts.js'
import type { ManagerSnapshot } from '../../manager.js'
import type { ManagerModel, ManagerPluginSnapshot } from '../../manager.js'
import { managerCopy } from '../../ui-copy.js'
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
  const run = async (plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1) => {
    if (model.requestPluginLifecycle === undefined) return
    setBusyPluginId(plugin.id)
    try {
      let result = await model.requestPluginLifecycle(operation)
      if ((operation.kind === 'disable' || operation.kind === 'uninstall') && result.outcome === 'planned' && result.impactToken !== undefined) {
        if (!window.confirm(`此操作会影响：${result.affectedPluginIds.join('、') || plugin.name}。继续吗？`)) return
        result = await model.requestPluginLifecycle({ ...operation, impactToken: result.impactToken })
      }
      if (result.error !== undefined) window.alert(result.error.message)
    } finally { setBusyPluginId(undefined) }
  }
  return (
    <section className="cxr-page" aria-label={managerCopy(snapshot.localization.locale, 'plugins.heading')}>
      <SearchField className="cxr-search" value={query} aria-label={managerCopy(snapshot.localization.locale, 'plugins.search-label')} placeholder={managerCopy(snapshot.localization.locale, 'plugins.search-placeholder')} onChange={setQuery} />
      <div className="cxr-list" role="list">
        {plugins.map(plugin => (
          <div key={`${plugin.source}\0${plugin.id}`} className="cxr-plugin-row" role="listitem">
            <button className="cxr-plugin-primary" type="button" data-plugin-id={plugin.id} aria-label={`打开插件详情 · ${plugin.name}`} onClick={() => router.navigate({ kind: 'plugin', pluginId: plugin.id, page: 'readme' })}>
              <PluginIdentityIcon pluginId={plugin.id} name={plugin.name} icon={plugin.icon} status={plugin.status} />
              <span className="cxr-card-body"><span className="cxr-card-title">{plugin.name}</span><span className="cxr-card-description">{plugin.description}</span><code className="cxr-card-code">{plugin.id}</code></span>
            </button>
            <span className="cxr-plugin-actions">
              <IconButton icon={plugin.status === 'configured-disabled' ? 'enable-plugin' : 'disable-plugin'} label={plugin.status === 'configured-disabled' ? '启用' : '停用'} loading={busyPluginId === plugin.id} disabled={model.requestPluginLifecycle === undefined} onClick={() => void run(plugin, plugin.status === 'configured-disabled' ? { kind: 'enable', pluginId: plugin.id } : { kind: 'disable', pluginId: plugin.id, impactToken: '' })} />
              <IconButton icon="reload-plugin" label="重新加载" loading={busyPluginId === plugin.id} disabled={model.requestPluginLifecycle === undefined || plugin.status !== 'active'} onClick={() => void run(plugin, { kind: 'reload', pluginId: plugin.id })} />
              <MoreMenu label={`${plugin.name} 更多操作`} items={[
                { id: 'logs', label: '日志与诊断', icon: 'diagnostics', onSelect: () => router.navigate({ kind: 'plugin', pluginId: plugin.id, page: 'logs' }) },
                { id: 'uninstall', label: '卸载', icon: 'uninstall-plugin', disabled: model.requestPluginLifecycle === undefined, onSelect: () => void run(plugin, { kind: 'uninstall', pluginId: plugin.id, impactToken: '' }) },
              ]} />
            </span>
          </div>
        ))}
        {plugins.length === 0 ? <div className="cxr-empty">没有匹配的插件</div> : null}
      </div>
    </section>
  )
}
