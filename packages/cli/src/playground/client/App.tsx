import { useEffect, useState } from 'react'
import { BrandMark } from '../../renderer/host-ui/BrandMark.js'
import { FixtureSummary } from './components/FixtureSummary.js'
import { HostSeats, type PlaygroundFixtureMode } from './components/HostSeats.js'
import { PlaygroundToolbar } from './components/PlaygroundToolbar.js'
import { bootRuntime, useRuntimeState } from './runtime-store.js'

export function App() {
  const runtime = useRuntimeState()
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [locale, setLocale] = useState<'zh-CN' | 'en'>('zh-CN')
  const [fixtureMode, setFixtureMode] = useState<PlaygroundFixtureMode>('conversation')

  useEffect(() => { void bootRuntime() }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
  }, [locale])

  return (
    <div className="pg-shell" data-pg-fixture-mode={fixtureMode}>
      <aside className="pg-sidebar" aria-label="Playground navigation">
        <div className="pg-brand-row">
          <span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true">
            <BrandMark className="pg-brand-mark" />
          </span>
          <span className="pg-brand-copy"><strong>CordisX</strong><small>UI Playground</small></span>
        </div>
        <button className="pg-new-task" type="button" onClick={() => setFixtureMode('empty')}>
          <span aria-hidden="true">＋</span> 新任务
        </button>
        <nav className="pg-primary-navigation" aria-label="Plugin navigation">
          <button type="button" className="pg-native-nav-item"><span aria-hidden="true">⌂</span> Playground</button>
          <div className="pg-surface-seat pg-navigation-seat" data-cordisx-playground-surface="sidebar.navigation.items" data-pg-seat-label="sidebar.navigation.items" />
        </nav>
        <div className="pg-session-heading"><span>最近任务</span><small>fixture</small></div>
        <div className="pg-session-list">
          <button type="button" className={fixtureMode === 'conversation' ? 'is-active' : ''} onClick={() => setFixtureMode('conversation')}>
            <strong>调试插件组合</strong><span>验证页面与插槽贡献</span>
          </button>
          <button type="button" className={fixtureMode === 'empty' ? 'is-active' : ''} onClick={() => setFixtureMode('empty')}>
            <strong>空会话</strong><span>检查无上下文状态</span>
          </button>
        </div>
        <footer className="pg-sidebar-footer">
          <div className="pg-footer-surface" data-cordisx-playground-surface="sidebar.footer.before-control" />
          <button type="button" className="pg-sidebar-control" data-cordisx-playground-template="sidebar.footer" aria-label="Playground tools">•••</button>
          <div className="pg-footer-surface" data-cordisx-playground-surface="sidebar.footer.after-control" />
        </footer>
      </aside>

      <HostSeats mode={fixtureMode} />

      <details className="pg-devtools">
        <summary aria-label="Open Playground developer tools"><span aria-hidden="true">⚙</span><span>开发工具</span></summary>
        <div className="pg-devtools-panel">
          <PlaygroundToolbar
            status={runtime.status}
            fixtureMode={fixtureMode}
            {...(runtime.error === undefined ? {} : { error: runtime.error })}
            onToggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
            onToggleLocale={() => setLocale(value => value === 'zh-CN' ? 'en' : 'zh-CN')}
            onFixtureMode={setFixtureMode}
          />
          <FixtureSummary plugins={runtime.plugins} />
          <p className="pg-capability-note"><span data-pg-capability>Host connection unavailable</span> · 本页不启动或连接真实 Codex。</p>
        </div>
      </details>
    </div>
  )
}
