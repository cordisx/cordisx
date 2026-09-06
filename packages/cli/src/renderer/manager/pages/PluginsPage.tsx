import { useMemo, useState } from 'react'
import type { CordisXPluginLifecycleOperationV1 } from '../../../contracts.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import { SearchField } from '../../host-ui/SearchField.js'
import type { MarketplaceModel } from '../../marketplace.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from '../../manager.js'
import { managerCopy, productLocale } from '../../ui-copy.js'
import { PluginIdentityIcon } from '../components/PluginIdentityIcon.js'
import type { ManagerRouter } from '../model/routes.js'
import { MarketplacePage } from './MarketplacePage.js'
import { LocalPluginInstallSection, PluginBundlesPage } from './PluginBundlesPage.js'

export type UnifiedPluginSourceFilter = 'all' | 'installed' | 'marketplace'
export type UnifiedPluginTypeFilter = 'all' | 'plugin' | 'bundle'

export function unifiedPluginSections(
  source: UnifiedPluginSourceFilter,
  type: UnifiedPluginTypeFilter,
): { readonly plugins: boolean; readonly bundles: boolean; readonly marketplace: boolean } {
  const installed = source !== 'marketplace'
  return {
    plugins: installed && type !== 'bundle',
    bundles: installed && type !== 'plugin',
    marketplace: source !== 'installed' && type !== 'bundle',
  }
}

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
  { model, marketplace, snapshot, router }: {
    readonly model: ManagerModel
    readonly marketplace: MarketplaceModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
  },
) {
  const zh = productLocale(snapshot.localization.locale) === 'zh-CN'
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<UnifiedPluginSourceFilter>('all')
  const [typeFilter, setTypeFilter] = useState<UnifiedPluginTypeFilter>('all')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [certifiedOnly, setCertifiedOnly] = useState(false)
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
  const pendingDevelopment = useMemo(() =>
    (snapshot.localDevelopment ?? []).filter(item => (
      !snapshot.plugins.some(plugin => plugin.id === item.pluginId)
      && (normalized === ''
        || `${item.pluginId} ${item.sourcePath} ${item.error ?? ''}`.toLocaleLowerCase().includes(normalized))
    )), [normalized, snapshot.localDevelopment, snapshot.plugins])
  const packageLifecycleAvailable = snapshot.pluginLifecycle?.operationsAvailable === true
  const sections = unifiedPluginSections(sourceFilter, typeFilter)

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
        className="cxr-marketplace-tools"
        role="search"
        aria-label={zh ? '搜索和筛选插件' : 'Search and filter plugins'}
      >
        <SearchField
          className="cxr-search"
          value={query}
          aria-label={managerCopy(snapshot.localization.locale, 'plugins.collection-search-label')}
          placeholder={managerCopy(snapshot.localization.locale, 'plugins.collection-search-placeholder')}
          onChange={setQuery}
        />
        <label>
          <span className="cxr-sr-only">{zh ? '来源' : 'Source'}</span>
          <select
            aria-label={zh ? '插件来源' : 'Plugin source'}
            data-plugin-source-filter="true"
            value={sourceFilter}
            onChange={event => setSourceFilter(event.currentTarget.value as UnifiedPluginSourceFilter)}
          >
            <option value="all">{zh ? '全部来源' : 'All sources'}</option>
            <option value="installed">{zh ? '已安装' : 'Installed'}</option>
            <option value="marketplace">{zh ? '插件商店' : 'Marketplace'}</option>
          </select>
        </label>
        <label>
          <span className="cxr-sr-only">{zh ? '类型' : 'Type'}</span>
          <select
            aria-label={zh ? '插件类型' : 'Plugin type'}
            data-plugin-type-filter="true"
            value={typeFilter}
            onChange={event => setTypeFilter(event.currentTarget.value as UnifiedPluginTypeFilter)}
          >
            <option value="all">{zh ? '全部类型' : 'All types'}</option>
            <option value="plugin">{zh ? '插件' : 'Plugins'}</option>
            <option value="bundle">{zh ? '插件包' : 'Bundles'}</option>
          </select>
        </label>
        <span className="cxr-marketplace-tool-actions">
          <IconButton
            className="cxr-marketplace-filter"
            icon="marketplace-official"
            label={zh ? '插件商店：仅官方' : 'Marketplace: Official only'}
            description={zh ? '只筛选插件商店结果' : 'Filters Marketplace results only'}
            data-marketplace-official-filter="true"
            aria-pressed={officialOnly}
            disabled={!sections.marketplace}
            onClick={() => setOfficialOnly(value => !value)}
          />
          <IconButton
            className="cxr-marketplace-filter"
            icon="marketplace-certified"
            label={zh ? '插件商店：仅认证' : 'Marketplace: Certified only'}
            description={zh ? '只筛选插件商店结果' : 'Filters Marketplace results only'}
            data-marketplace-certified-filter="true"
            aria-pressed={certifiedOnly}
            disabled={!sections.marketplace}
            onClick={() => setCertifiedOnly(value => !value)}
          />
          <IconButton
            icon="marketplace-source-edit"
            label={zh ? '管理来源' : 'Manage sources'}
            onClick={() => router.navigate({ kind: 'marketplace-sources' })}
          />
        </span>
      </div>

      <LocalPluginInstallSection model={model} snapshot={snapshot} />

      <div data-unified-plugin-catalog="true">
        {sections.plugins
          ? (
            <div className="cxr-list" role="list" data-unified-plugin-results="installed-plugins">
              {pendingDevelopment.map(item => (
                <div
                  key={item.sourcePath}
                  className="cxr-local-development-source"
                  role="listitem"
                  data-plugin-origin="local-dev"
                  data-development-state={item.state}
                >
                  <span className="cxr-card-body">
                    <span className="cxr-card-title">
                      {item.pluginId}
                      <span className="cxr-badge">
                        {managerCopy(snapshot.localization.locale, 'plugins.local-development')}
                      </span>
                    </span>
                    <code className="cxr-card-code">{item.sourcePath}</code>
                    {item.error === undefined
                      ? null
                      : <span className="cxr-local-development-error" role="alert">{item.error}</span>}
                  </span>
                  <strong>{item.state}</strong>
                </div>
              ))}
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
                            onSelect: () =>
                              void run(plugin, { kind: 'uninstall', pluginId: plugin.id, impactToken: '' }),
                          },
                        ]}
                      />
                    </span>
                  </div>
                )
              })}
            </div>
          )
          : null}
        {sections.bundles ? <PluginBundlesPage snapshot={snapshot} router={router} query={query} /> : null}
        {sections.marketplace && typeof marketplace.snapshot === 'function'
          ? (
            <MarketplacePage
              marketplace={marketplace}
              manager={model}
              snapshot={snapshot}
              router={router}
              query={query}
              officialOnly={officialOnly}
              certifiedOnly={certifiedOnly}
            />
          )
          : null}
      </div>
    </section>
  )
}
