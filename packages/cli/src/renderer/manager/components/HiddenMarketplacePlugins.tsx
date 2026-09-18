import { IconButton } from '../../host-ui/IconButton.js'

export interface HiddenMarketplacePluginView {
  readonly identity: { readonly sourceUrl: string; readonly pluginId: string }
  readonly name: string
  readonly description?: string
}

export function HiddenMarketplacePlugins({
  locale,
  plugins,
  busyIdentity,
  onUnhide,
}: {
  readonly locale: string
  readonly plugins: readonly HiddenMarketplacePluginView[]
  readonly busyIdentity?: string | undefined
  readonly onUnhide: (identity: HiddenMarketplacePluginView['identity']) => Promise<void>
}) {
  const zh = locale.toLowerCase().startsWith('zh')
  return (
    <section className="cxr-hidden-marketplace" aria-label={zh ? '已隐藏的商店插件' : 'Hidden Marketplace plugins'}>
      <div className="cxr-hidden-marketplace-heading">
        <strong>{zh ? '已隐藏' : 'Hidden'}</strong>
        <span className="cxr-badge" data-hidden-marketplace-count={plugins.length}>{plugins.length}</span>
      </div>
      <div className="cxr-list" role="list">
        {plugins.map(plugin => {
          const key = `${plugin.identity.sourceUrl}\0${plugin.identity.pluginId}`
          return (
            <div className="cxr-card" role="listitem" key={key} data-hidden-marketplace-plugin={key}>
              <span className="cxr-card-body">
                <span className="cxr-card-title">{plugin.name}</span>
                {plugin.description === undefined
                  ? null
                  : <span className="cxr-card-description">{plugin.description}</span>}
                <code className="cxr-card-code">{plugin.identity.sourceUrl} · {plugin.identity.pluginId}</code>
              </span>
              <IconButton
                icon="reset-configuration"
                label={zh ? `恢复 ${plugin.name}` : `Restore ${plugin.name}`}
                loading={busyIdentity === key}
                disabled={busyIdentity === key}
                onClick={() => void onUnhide(plugin.identity)}
              />
            </div>
          )
        })}
        {plugins.length === 0
          ? <div className="cxr-empty">{zh ? '没有已隐藏的插件' : 'No hidden plugins'}</div>
          : null}
      </div>
    </section>
  )
}
