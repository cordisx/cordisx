import type { PluginManagementSnapshot } from '../../../management/contracts.js'
import {
  type MarketplaceModel,
  normalizeMarketplaceSource,
  projectMarketplacePlugin,
  projectMarketplaceSource,
} from '../../marketplace.js'
import { HiddenMarketplacePlugins } from '../components/HiddenMarketplacePlugins.js'
import { type MarketplaceSourceInput, MarketplaceSourceManager } from '../components/MarketplaceSourceManager.js'
import type { ManagerPluginManagementBinding } from '../model/plugin-management.js'
import { useMarketplaceSnapshot } from '../model/marketplace-store.js'
import { usePluginManagementActions } from '../model/use-plugin-management-actions.js'

export function MarketplaceSourcesPage({
  marketplace,
  locale,
  pluginManagement,
  managementSnapshot,
  managementError,
}: {
  readonly marketplace: MarketplaceModel
  readonly locale: string
  readonly pluginManagement?: ManagerPluginManagementBinding | undefined
  readonly managementSnapshot?: PluginManagementSnapshot | undefined
  readonly managementError?: string | undefined
}) {
  const catalog = useMarketplaceSnapshot(marketplace)
  const actions = usePluginManagementActions(pluginManagement, managementSnapshot, locale)
  const zh = locale.toLowerCase().startsWith('zh')
  if (managementError !== undefined) {
    return (
      <div className="cxr-notice cxr-danger" role="alert" data-plugin-management-error="true">
        {zh ? `无法读取插件管理配置：${managementError}` : `Unable to load plugin management: ${managementError}`}
      </div>
    )
  }
  if (pluginManagement === undefined || managementSnapshot === undefined) {
    return <div className="cxr-empty">{zh ? '当前 Host 未提供插件管理服务' : 'Plugin management is unavailable'}</div>
  }
  const sources = managementSnapshot.sources.map(source => {
    const state = catalog.sourceStates.find(item => item.url === source.url)
    const projection = projectMarketplaceSource(
      {
        ...(state ?? {
          url: source.url,
          enabled: source.enabled,
          official: source.official,
          status: 'loading',
          phase: 'idle',
          stale: false,
          revalidating: false,
          attempts: 0,
        }),
        ...(source.local === undefined ? {} : { local: source.local }),
      },
      locale,
    )
    return {
      url: source.url,
      enabled: source.enabled,
      name: projection.name,
      ...(projection.description === undefined ? {} : { description: projection.description }),
      ...(state?.error === undefined ? {} : { error: state.error }),
      official: source.official,
      removable: source.removable,
      refreshing: state?.revalidating === true,
      ...(source.local === undefined ? {} : { local: source.local }),
    }
  })
  const hidden = managementSnapshot.hiddenCatalogEntries.map(identity => {
    const plugin = catalog.plugins.find(item => item.feedUrl === identity.sourceUrl && item.id === identity.pluginId)
    const projection = plugin === undefined ? undefined : projectMarketplacePlugin(plugin, locale)
    return {
      identity,
      name: projection?.name ?? identity.pluginId,
      ...(projection?.description === undefined ? {} : { description: projection.description }),
    }
  })
  const save = async (currentUrl: string | undefined, source: MarketplaceSourceInput) => {
    const normalized = { ...source, url: normalizeMarketplaceSource(source.url) }
    await actions.mutate(
      currentUrl ?? normalized.url,
      currentUrl === undefined
        ? { kind: 'source-add', source: normalized }
        : { kind: 'source-edit', url: currentUrl, source: normalized },
      false,
    )
  }
  const settle = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch { /* standard Host notification owns operation feedback */ }
  }
  const refresh = async (url: string) => {
    try {
      await marketplace.reloadSource(url)
    } catch (error) {
      actions.notifyFailure('source-refresh', error)
    }
  }
  return (
    <section className="cxr-page cxr-source-management-page">
      <MarketplaceSourceManager
        locale={locale}
        sources={sources}
        busyUrl={actions.busyKey}
        onSave={save}
        onSetEnabled={(url, enabled) => settle(actions.mutate(url, { kind: 'source-set-enabled', url, enabled }))}
        onRemove={url => settle(actions.mutate(url, { kind: 'source-remove', url }))}
        onRefresh={refresh}
      />
      <HiddenMarketplacePlugins
        locale={locale}
        plugins={hidden}
        busyIdentity={actions.busyKey}
        onUnhide={identity =>
          settle(actions.mutate(`${identity.sourceUrl}\0${identity.pluginId}`, {
            kind: 'catalog-unhide',
            identity,
          }))}
      />
    </section>
  )
}
