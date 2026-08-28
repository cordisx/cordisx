import type { PlaygroundFixtureMode } from './HostSeats.js'

export interface PlaygroundToolbarProps {
  readonly status: 'starting' | 'active' | 'failed'
  readonly fixtureMode: PlaygroundFixtureMode
  readonly error?: string
  readonly onToggleTheme: () => void
  readonly onToggleLocale: () => void
  readonly onFixtureMode: (mode: PlaygroundFixtureMode) => void
}

export function PlaygroundToolbar({ status, fixtureMode, error, onToggleTheme, onToggleLocale, onFixtureMode }: PlaygroundToolbarProps) {
  const reload = () => window.location.reload()
  const reset = async () => {
    await fetch('/api/reset', { method: 'POST' })
    localStorage.clear()
    window.location.reload()
  }
  return (
    <section className="pg-toolbar" aria-label="Playground controls">
      <div className="pg-tool-status"><strong>独立 Cordis runtime</strong><span className="pg-status" role="status" title={error}>{error === undefined ? status : `${status} · ${error}`}</span></div>
      <div className="pg-fixture-toggle" aria-label="Fixture state">
        <button type="button" aria-pressed={fixtureMode === 'conversation'} onClick={() => onFixtureMode('conversation')}>有会话</button>
        <button type="button" aria-pressed={fixtureMode === 'empty'} onClick={() => onFixtureMode('empty')}>空会话</button>
      </div>
      <div className="pg-toolbar-actions">
        <button type="button" onClick={onToggleTheme}>亮/暗</button>
        <button type="button" onClick={onToggleLocale}>中文/EN</button>
        <button type="button" onClick={reload}>重载插件</button>
        <button type="button" onClick={() => { void reset() }}>重置 fixture</button>
      </div>
    </section>
  )
}
