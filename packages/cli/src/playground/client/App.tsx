import { useEffect, useState } from 'react'
import { FixtureSummary } from './components/FixtureSummary.js'
import { HostSeats } from './components/HostSeats.js'
import { PlaygroundToolbar } from './components/PlaygroundToolbar.js'
import { bootRuntime, useRuntimeState } from './runtime-store.js'

export function App() {
  const runtime = useRuntimeState()
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [locale, setLocale] = useState<'zh-CN' | 'en'>('zh-CN')

  useEffect(() => { void bootRuntime() }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
  }, [locale])

  return (
    <div className="pg-shell">
      <aside className="pg-sidebar">
        <h1>CordisX UI Playground</h1>
        <p>Vite + React Fast Refresh · 组件热更新已连接 · 本地 Host 模拟席位，不连接 Codex。</p>
        <FixtureSummary plugins={runtime.plugins} />
        <div className="pg-seat pg-manager-seat"><span>Manager</span><span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true" /></div>
        <div className="pg-seat">Host-only capability<br /><span data-pg-capability>unavailable · no Codex connection</span></div>
        <div className="pg-unavailable">这里的标准席位用于预览。Codex native anchor、真实会话与当前连接均不挂载。</div>
      </aside>
      <main className="pg-main">
        <PlaygroundToolbar
          status={runtime.status}
          {...(runtime.error === undefined ? {} : { error: runtime.error })}
          onToggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
          onToggleLocale={() => setLocale(value => value === 'zh-CN' ? 'en' : 'zh-CN')}
        />
        <HostSeats />
      </main>
    </div>
  )
}
