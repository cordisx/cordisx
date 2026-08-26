import fixture from 'virtual:cordisx-playground-fixture'

export interface FixtureSummaryProps {
  readonly plugins: readonly PlaygroundPluginSnapshot[]
}

export function FixtureSummary({ plugins }: FixtureSummaryProps) {
  const active = plugins.filter(plugin => plugin.status === 'active').length
  return (
    <section className="pg-fixture" aria-labelledby="pg-fixture-name">
      <strong id="pg-fixture-name">{fixture.name}</strong>
      <small>Fixture · {fixture.source}</small>
      <small>使用 <code>npm run dev:ui -- --config /path/to/cordisx.config.json</code> 切换组合。</small>
      <span>{active} / {plugins.length} 个插件已激活</span>
      <div className="pg-plugin-list">
        {plugins.map(plugin => <span className="pg-plugin" key={plugin.id}>{plugin.id} · {plugin.status}</span>)}
      </div>
    </section>
  )
}
