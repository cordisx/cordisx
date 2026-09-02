import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HostMenu, type HostMenuItem } from '../../renderer/host-ui/HostMenu.js'
import { createSidebarItem, type SidebarItemControl } from '../../renderer/host-ui/SidebarItem.js'
import { FixtureSummary } from './components/FixtureSummary.js'
import { HostSeats, type PlaygroundFixtureMode } from './components/HostSeats.js'
import { playgroundEnvironment, usePlaygroundEnvironment } from './environment.js'
import fixture from 'virtual:cordisx-playground-fixture'
import { activatePlaygroundReviewNavigation, authorizePlaygroundReviewNavigation } from './review-navigation.js'
import { bootRuntime, useRuntimeState } from './runtime-store.js'
import { MockAgentTaskPage } from './components/MockAgentTaskPage.js'
import { ScenarioLabPage } from './components/ScenarioLabPage.js'

const RESET_MARKER = 'cordisx.playground.reset/v1'

interface SidebarItemProps {
  readonly id: string
  readonly label: string
  readonly ariaLabel?: string
  readonly secondary?: string
  readonly icon: string
  readonly selected?: boolean
  readonly onActivate: () => void
}

function SidebarItem(props: SidebarItemProps) {
  const host = useRef<HTMLDivElement>(null)
  const control = useRef<SidebarItemControl | undefined>(undefined)
  const activate = useRef(props.onActivate)
  activate.current = props.onActivate

  useLayoutEffect(() => {
    const item = createSidebarItem(document, {
      id: props.id,
      label: props.label,
      icon: props.icon,
      ...(props.ariaLabel === undefined ? {} : { ariaLabel: props.ariaLabel }),
      ...(props.secondary === undefined ? {} : { secondary: props.secondary }),
      selected: props.selected === true,
      onActivate: () => activate.current(),
    })
    control.current = item
    host.current?.replaceChildren(item.element)
    return () => { item.dispose(); control.current = undefined }
  }, [props.id, props.label, props.ariaLabel, props.secondary, props.icon])
  useLayoutEffect(() => control.current?.setSelected(props.selected === true), [props.selected])
  return <div ref={host} className="pg-sidebar-item-host" />
}

export function App() {
  const runtime = useRuntimeState()
  const environment = usePlaygroundEnvironment()
  const [fixtureMode, setFixtureMode] = useState<PlaygroundFixtureMode>(fixture.reviewNavigationItem === undefined ? 'conversation' : 'review')
  const [simulatorOpen, setSimulatorOpen] = useState(false)
  const [simulatorSessionId, setSimulatorSessionId] = useState<string>()
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string>()
  const shell = useRef<HTMLDivElement>(null)
  const en = environment.locale === 'en'
  const tasks = runtime.simulator?.tasks ?? []
  const control = runtime.simulatorControl
  const selectedTask = tasks.find(task => task.sessionId === simulatorSessionId)

  useEffect(() => { void bootRuntime() }, [])
  useEffect(() => {
    if (runtime.status === 'active') sessionStorage.removeItem(RESET_MARKER)
  }, [runtime.status])
  useEffect(() => shell.current === null ? undefined : playgroundEnvironment.attachTheme(shell.current), [])
  useEffect(() => {
    if (runtime.status !== 'active' || fixture.reviewNavigationItem === undefined) return undefined
    let disposed = false
    let deactivate: (() => void) | undefined
    const hostRuntime = window.__cordisxRuntime
    if (hostRuntime !== undefined) {
      void authorizePlaygroundReviewNavigation(hostRuntime, fixture.reviewNavigationItem).then(() => {
        if (!disposed) deactivate = activatePlaygroundReviewNavigation(document, fixture.reviewNavigationItem!)
      }).catch(() => undefined)
    }
    return () => {
      disposed = true
      deactivate?.()
    }
  }, [runtime.status])
  const reset = async () => {
    if (resetting) return
    setResetting(true); setResetError(undefined)
    try {
      sessionStorage.setItem(RESET_MARKER, JSON.stringify({ phase: 'requesting', at: Date.now() }))
      const response = await fetch('/api/reset', { method: 'POST' })
      if (!response.ok) throw new Error(`reset failed (${response.status})`)
      const value = await response.json() as { readonly ok?: unknown }
      if (value.ok !== true) throw new Error('reset did not acknowledge completion')
      sessionStorage.setItem(RESET_MARKER, JSON.stringify({ phase: 'applied', at: Date.now() }))
      playgroundEnvironment.resetPreferences()
      window.location.reload()
    } catch (error) { setResetError(error instanceof Error ? error.message : String(error)); setResetting(false) }
  }
  const menuItems: readonly HostMenuItem[] = [
    { kind: 'heading', id: 'theme-heading', label: en ? 'Appearance' : '外观' },
    ...(['system', 'light', 'dark'] as const).map(value => ({
      kind: 'action' as const,
      id: `theme-${value}`,
      label: en ? ({ system: 'Follow system', light: 'Light', dark: 'Dark' } as const)[value] : ({ system: '跟随系统', light: '浅色', dark: '深色' } as const)[value],
      selected: environment.themePreference === value,
      onSelect: () => playgroundEnvironment.setTheme(value),
    })),
    { kind: 'separator', id: 'theme-locale-separator' },
    { kind: 'heading', id: 'locale-heading', label: en ? 'Language' : '语言' },
    { kind: 'action', id: 'locale-zh', label: '中文', selected: environment.locale === 'zh-CN', onSelect: () => playgroundEnvironment.setLocale('zh-CN') },
    { kind: 'action', id: 'locale-en', label: 'English', selected: environment.locale === 'en', onSelect: () => playgroundEnvironment.setLocale('en') },
    ...(fixture.reviewNavigationItem === undefined ? [
      { kind: 'action' as const, id: 'fixture-conversation', label: en ? 'Conversation fixture' : '有会话 fixture', selected: fixtureMode === 'conversation', onSelect: () => setFixtureMode('conversation') },
      { kind: 'action' as const, id: 'fixture-empty', label: en ? 'Empty fixture' : '空会话 fixture', selected: fixtureMode === 'empty', onSelect: () => setFixtureMode('empty') },
    ] : []),
    { kind: 'separator', id: 'runtime-separator' },
    { kind: 'heading', id: 'runtime-heading', label: en ? 'Runtime' : '运行时' },
    { kind: 'action', id: 'reload', label: en ? 'Reload plugins' : '重载插件', onSelect: () => window.location.reload() },
    { kind: 'action', id: 'reset', label: en ? 'Reset fixture' : '重置 fixture', onSelect: () => setResetOpen(true) },
  ]

  return (
    <div ref={shell} className="pg-shell" data-pg-fixture-mode={fixtureMode} data-pg-locale={environment.locale}>
      <aside className="pg-sidebar" aria-label={en ? 'Playground navigation' : 'Playground 导航'}>
        <div className="pg-brand-seat">
          <span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true" />
        </div>
        <div className="pg-sidebar-stack">
          {fixture.reviewNavigationItem === undefined
            ? <SidebarItem id="action.new" label={en ? 'New task' : '新任务'} icon="host:new" onActivate={() => setFixtureMode('empty')} />
            : null}
          <nav className="pg-primary-navigation" aria-label={en ? 'Plugin navigation' : '插件导航'}>
            {fixture.reviewNavigationItem === undefined
              ? <SidebarItem id="host.playground" label="Playground" icon="host:playground" onActivate={() => setFixtureMode('conversation')} />
              : null}
            <div className="pg-surface-seat pg-navigation-seat" data-cordisx-playground-surface="sidebar.navigation.items" data-pg-seat-label="sidebar.navigation.items" />
          </nav>
        </div>
        {fixture.reviewNavigationItem === undefined ? <section className="pg-playground-fixtures" aria-labelledby="pg-playground-fixtures-title">
          <div className="pg-session-heading"><span id="pg-playground-fixtures-title">{en ? 'Playground fixtures' : 'Playground 测试场景'}</span><small>Debug</small></div>
          <div className="pg-session-list">
            <SidebarItem id="fixture.conversation" label={en ? 'Plugin composition' : '调试插件组合'} secondary={en ? 'Inspect pages and slots' : '验证页面与插槽贡献'} icon="host:playground" selected={fixtureMode === 'conversation'} onActivate={() => setFixtureMode('conversation')} />
            <SidebarItem id="fixture.empty" label={en ? 'Empty conversation' : '空会话'} secondary={en ? 'Inspect the no-context state' : '检查无上下文状态'} icon="host:new" selected={fixtureMode === 'empty'} onActivate={() => setFixtureMode('empty')} />
            <SidebarItem id="fixture.simulator" label={en ? 'Simulator' : '模拟器'} secondary={en ? `${tasks.length} SessionEvent tasks` : `${tasks.length} 个 SessionEvent 任务`} icon="host:playground" selected={simulatorOpen} onActivate={() => { setSimulatorOpen(true); setSimulatorSessionId(undefined) }} />
          </div>
        </section> : null}
        <footer className="pg-sidebar-footer">
          <div className="pg-footer-surface" data-cordisx-playground-surface="sidebar.footer.before-control" />
          <HostMenu
            label={en ? 'Playground environment and developer tools' : 'Playground 环境与开发工具'}
            className="pg-sidebar-control"
            icon={<span className="pg-sidebar-control-icon" aria-hidden="true">•••</span>}
            copy={<span className="pg-sidebar-control-copy">{en ? 'Environment' : '环境与开发'}</span>}
            items={menuItems}
            footer={<>
              <div className="pg-tool-status"><strong>{en ? 'Isolated Cordis runtime' : '独立 Cordis runtime'}</strong><span className="pg-status" role="status" title={runtime.error}>{runtime.error === undefined ? runtime.status : `${runtime.status} · ${runtime.error}`}</span></div>
              <FixtureSummary plugins={runtime.plugins} locale={environment.locale} />
              <p className="pg-capability-note"><span data-pg-capability>Host connection unavailable</span> · {en ? 'This page does not start or connect to Codex.' : '本页不启动或连接真实 Codex。'}</p>
            </>}
          />
          <div className="pg-footer-surface" data-cordisx-playground-surface="sidebar.footer.after-control" />
        </footer>
      </aside>
      {simulatorOpen && control !== undefined
        ? selectedTask !== undefined
          ? <MockAgentTaskPage task={selectedTask} tasks={tasks} locale={environment.locale} control={control} onChanged={() => undefined} onReturn={() => setSimulatorSessionId(undefined)} />
          : <ScenarioLabPage locale={environment.locale} tasks={tasks} control={control} onOpenTask={setSimulatorSessionId} onClose={() => setSimulatorOpen(false)} />
        : <HostSeats mode={fixtureMode} locale={environment.locale} />}
      {resetOpen ? <div className="pg-preview-reset-backdrop" role="presentation"><section className="pg-preview-reset-confirm" role="alertdialog" aria-modal="true" aria-labelledby="pg-reset-title"><h2 id="pg-reset-title">{en ? 'Clear local preview data?' : '清空本地预览数据？'}</h2><p>{en ? 'This is irreversible for the selected Playground home. A reset marker is recorded before the server confirms the operation.' : '这会清除当前 Playground home 中的本地预览数据；服务器确认前会先写入重置标记。'}</p>{resetError === undefined ? null : <p role="alert">{resetError}</p>}<footer><button type="button" disabled={resetting} onClick={() => setResetOpen(false)}>{en ? 'Cancel' : '取消'}</button><button type="button" disabled={resetting} onClick={() => { void reset() }}>{resetting ? (en ? 'Clearing…' : '正在清空…') : (en ? 'Clear and refresh' : '清空并刷新')}</button></footer></section></div> : null}
    </div>
  )
}
