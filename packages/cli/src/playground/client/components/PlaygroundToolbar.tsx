export interface PlaygroundToolbarProps {
  readonly status: 'starting' | 'active' | 'failed'
  readonly error?: string
  readonly onToggleTheme: () => void
  readonly onToggleLocale: () => void
}

export function PlaygroundToolbar({ status, error, onToggleTheme, onToggleLocale }: PlaygroundToolbarProps) {
  const reload = () => window.location.reload()
  const reset = async () => {
    await fetch('/api/reset', { method: 'POST' })
    localStorage.clear()
    window.location.reload()
  }
  return (
    <header className="pg-toolbar">
      <strong>独立 Cordis runtime</strong>
      <span className="pg-status" role="status" title={error}>{error === undefined ? status : `${status} · ${error}`}</span>
      <span className="pg-toolbar-actions">
        <button type="button" onClick={onToggleTheme}>亮/暗</button>
        <button type="button" onClick={onToggleLocale}>中文/EN</button>
        <button type="button" onClick={reload}>重载插件</button>
        <button type="button" onClick={() => { void reset() }}>重置 fixture</button>
      </span>
    </header>
  )
}
