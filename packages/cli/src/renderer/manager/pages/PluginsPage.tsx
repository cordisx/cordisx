import { useMemo, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../contracts.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import { SearchField } from '../../host-ui/SearchField.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from '../../manager.js'
import { managerCopy, productLocale } from '../../ui-copy.js'
import { PluginIdentityIcon } from '../components/PluginIdentityIcon.js'
import type { ManagerRouter } from '../model/routes.js'

function bundleProvenance(snapshot: ManagerSnapshot): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>()
  for (const bundle of snapshot.pluginBundles?.bundles ?? []) {
    for (const member of bundle.members) {
      if (!member.installedViaBundle) continue
      const values = result.get(member.pluginId) ?? []
      if (!values.includes(bundle.name)) values.push(bundle.name)
      result.set(member.pluginId, values)
    }
  }
  return result
}

export function PluginsPage(
  { model, snapshot, router }: {
    readonly model: ManagerModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
  },
) {
  const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
  const [query, setQuery] = useState('')
  const [busyPluginId, setBusyPluginId] = useState<string>()
  const normalized = query.trim().toLocaleLowerCase()
  const provenance = useMemo(() => bundleProvenance(snapshot), [snapshot])
  const plugins = useMemo(
    () =>
      snapshot.plugins.filter(plugin => {
        const bundles = provenance.get(plugin.id) ?? []
        return normalized === ''
          || `${plugin.name} ${plugin.id} ${plugin.description ?? ''} ${bundles.join(' ')}`
            .toLocaleLowerCase()
            .includes(normalized)
      }),
    [normalized, provenance, snapshot.plugins],
  )
  const packageLifecycleAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
  const empty = plugins.length === 0

  const run = async (plugin: ManagerPluginSnapshot, operation: CordisXPluginLifecycleOperationV1) => {
    if (model.requestPluginLifecycle === undefined) return
    setBusyPluginId(plugin.id)
    try {
      let result = await model.requestPluginLifecycle(operation)
      if (
        (operation.kind === 'disable' || operation.kind === 'uninstall') && result.outcome === 'planned'
        && result.impactToken !== undefined
      ) {
        const affected = result.affectedPluginIds.join(zh ? '、' : ', ') || plugin.name
        if (
          !window.confirm(zh ? `此操作会影响：${affected}。继续吗？` : `This action affects: ${affected}. Continue?`)
        ) {
          return
        }
        result = await model.requestPluginLifecycle({ ...operation, impactToken: result.impactToken })
      }
      if (result.error !== undefined) window.alert(result.error.message)
    } finally {
      setBusyPluginId(undefined)
    }
  }

  return (
    <section
      className="cxr-page"
      aria-label={managerCopy(snapshot.localization.locale, 'plugins.collection-label')}
      data-unified-plugins-page="true"
    >
      <div
        className="cxr-plugins-toolbar"
        role="search"
        aria-label={zh ? '搜索已安装插件' : 'Search installed plugins'}
      >
        <SearchField
          className="cxr-search"
          value={query}
          aria-label={managerCopy(snapshot.localization.locale, 'plugins.collection-search-label')}
          placeholder={managerCopy(snapshot.localization.locale, 'plugins.collection-search-placeholder')}
          onChange={setQuery}
        />
      </div>

      <div className="cxr-list cxr-plugins-results" role="list" data-installed-plugin-results="true">
        {plugins.map(plugin => {
          const bundleNames = provenance.get(plugin.id) ?? []
          return (
            <div
              key={`${plugin.source}\0${plugin.id}`}
              className="cxr-plugin-row"
              role="listitem"
              data-plugin-result-type="plugin"
              data-plugin-result-source="installed"
            >
              <button
                className="cxr-plugin-primary"
                type="button"
                data-plugin-id={plugin.id}
                aria-label={`${managerCopy(snapshot.localization.locale, 'plugins.open')} · ${plugin.name}`}
                onClick={() => router.navigate({ kind: 'plugin', pluginId: plugin.id, page: 'readme' })}
              >
                <PluginIdentityIcon
                  pluginId={plugin.id}
                  name={plugin.name}
                  icon={plugin.icon}
                  status={plugin.status}
                />
                <span className="cxr-card-body">
                  <span className="cxr-card-title">
                    {plugin.name}
                    <span className="cxr-badge" data-plugin-type-badge="plugin">
                      {zh ? '插件' : 'Plugin'}
                    </span>
                    {plugin.development === undefined
                      ? null
                      : (
                        <span className="cxr-badge" data-plugin-origin="local-dev">
                          {managerCopy(snapshot.localization.locale, 'plugins.local-development')}
                        </span>
                      )}
                    {bundleNames.map(name => (
                      <span className="cxr-badge" data-plugin-bundle-provenance={name} key={name}>
                        {zh ? `来自插件包：${name}` : `From bundle: ${name}`}
                      </span>
                    ))}
                    <span className="cxr-badge" data-plugin-status-badge={plugin.status}>
                      {plugin.status}
                    </span>
                  </span>
                  <span className="cxr-card-description">{plugin.description}</span>
                  <code className="cxr-card-code">{plugin.id}</code>
                </span>
              </button>
              <span className="cxr-plugin-actions">
                <IconButton
                  icon={plugin.status === 'configured-disabled' ? 'enable-plugin' : 'disable-plugin'}
                  label={managerCopy(
                    snapshot.localization.locale,
                    plugin.status === 'configured-disabled' ? 'plugins.enable' : 'plugins.disable',
                  )}
                  loading={busyPluginId === plugin.id}
                  disabled={!packageLifecycleAvailable || model.requestPluginLifecycle === undefined}
                  onClick={() =>
                    void run(
                      plugin,
                      plugin.status === 'configured-disabled'
                        ? { kind: 'enable', pluginId: plugin.id }
                        : { kind: 'disable', pluginId: plugin.id, impactToken: '' },
                    )}
                />
                <IconButton
                  icon="reload-plugin"
                  label={managerCopy(snapshot.localization.locale, 'plugins.reload')}
                  loading={busyPluginId === plugin.id}
                  disabled={model.requestPluginLifecycle === undefined
                    || (plugin.developmentReloadAvailable !== true && !packageLifecycleAvailable)
                    || plugin.status !== 'active'}
                  onClick={() => void run(plugin, { kind: 'reload', pluginId: plugin.id })}
                />
                <MoreMenu
                  label={`${plugin.name} · ${managerCopy(snapshot.localization.locale, 'plugins.more-actions')}`}
                  items={[
                    {
                      id: 'logs',
                      label: managerCopy(snapshot.localization.locale, 'plugin-tab.logs'),
                      icon: 'diagnostics',
                      onSelect: () => router.navigate({ kind: 'plugin', pluginId: plugin.id, page: 'logs' }),
                    },
                    {
                      id: 'uninstall',
                      label: managerCopy(snapshot.localization.locale, 'plugins.uninstall'),
                      icon: 'uninstall-plugin',
                      disabled: !packageLifecycleAvailable || model.requestPluginLifecycle === undefined,
                      onSelect: () => void run(plugin, { kind: 'uninstall', pluginId: plugin.id, impactToken: '' }),
                    },
                  ]}
                />
              </span>
            </div>
          )
        })}
        {empty
          ? <div className="cxr-empty">{managerCopy(snapshot.localization.locale, 'plugins.no-matches')}</div>
          : null}
      </div>
    </section>
  )
}
