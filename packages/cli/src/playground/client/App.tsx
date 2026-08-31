import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { HostMenu, type HostMenuItem } from '../../renderer/host-ui/HostMenu.js'
import { createSidebarItem, type SidebarItemControl } from '../../renderer/host-ui/SidebarItem.js'
import { FixtureSummary } from './components/FixtureSummary.js'
import { HostSeats, type PlaygroundFixtureMode } from './components/HostSeats.js'
import { MockAgentTaskPage } from './components/MockAgentTaskPage.js'
import { ScenarioLabPage } from './components/ScenarioLabPage.js'
import { playgroundEnvironment, usePlaygroundEnvironment } from './environment.js'
import fixture from 'virtual:cordisx-playground-fixture'
import { activatePlaygroundReviewNavigation, authorizePlaygroundReviewNavigation } from './review-navigation.js'
import { bootRuntime, useRuntimeState } from './runtime-store.js'
import {
  clearPlaygroundSimulatorSessionRegistry,
  navigateTaskDetails,
  simulatorTaskIdFromPath,
  subscribePlaygroundTaskLocation,
} from './task-details-navigation.js'

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
  const [simulatorTaskId, setSimulatorTaskId] = useState<string | undefined>(() => simulatorTaskIdFromPath(window.location.pathname))
  const [scenarioLabOpen, setScenarioLabOpen] = useState(false)
  const shell = useRef<HTMLDivElement>(null)
  const en = environment.locale === 'en'

  useEffect(() => { void bootRuntime() }, [])
  useEffect(() => shell.current === null ? undefined : playgroundEnvironment.attachTheme(shell.current), [])
  useEffect(() => {
    if (runtime.status !== 'active' || fixture.reviewNavigationItem === undefined) return undefined
    let disposed = false
    let deactivate: (() => void) | undefined
    const hostRuntime = window.__cordisxRuntime
    if (hostRuntime !== undefined) {
      void authorizePlaygroundReviewNavigation(hostRuntime, fixture.reviewNavigationItem).then(() => {
        if (!disposed) deactivate = activatePlaygroundReviewNavigation(document, fixture.reviewNavigationItem!)
      })
    }
    return () => {
      disposed = true
      deactivate?.()
    }
  }, [runtime.status])
  const recentTasks = [...(runtime.simulator?.tasks ?? [])].reverse()
  const simulatorTask = recentTasks.find(task => task.debugTaskId === simulatorTaskId)
  useEffect(() => {
    return subscribePlaygroundTaskLocation(window, (taskId, synchronous) => {
      if (synchronous) flushSync(() => setSimulatorTaskId(taskId))
      else setSimulatorTaskId(taskId)
    })
  }, [])

  const openSimulatorTask = (detailsUrl: (typeof recentTasks)[number]['detailsUrl']) => {
    navigateTaskDetails(window, detailsUrl)
  }
  const preparePluginNavigation = () => {
    setScenarioLabOpen(false)
    if (simulatorTaskId !== undefined) flushSync(() => setSimulatorTaskId(undefined))
  }
  const closeSimulatorTask = () => {
    setSimulatorTaskId(undefined)
    if (window.location.pathname.startsWith('/playground/simulator/tasks/')) window.history.pushState(window.history.state, '', '/')
  }
  const openScenarioLab = () => {
    closeSimulatorTask()
    setScenarioLabOpen(true)
  }
  const closeScenarioLab = () => setScenarioLabOpen(false)

  const reset = async () => {
    await fetch('/api/reset', { method: 'POST' })
    try { clearPlaygroundSimulatorSessionRegistry(sessionStorage) } catch { /* browser session storage is optional */ }
    playgroundEnvironment.resetPreferences()
    window.location.reload()
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
    { kind: 'separator' as const, id: 'developer-separator' },
    { kind: 'heading' as const, id: 'developer-heading', label: en ? 'Developer' : '开发' },
    { kind: 'action' as const, id: 'scenario-lab', label: en ? 'Chatroom interaction scenarios' : 'Chatroom 交互场景', selected: scenarioLabOpen, onSelect: openScenarioLab },
    ...(fixture.reviewNavigationItem === undefined ? [
      { kind: 'action' as const, id: 'fixture-conversation', label: en ? 'Conversation fixture' : '有会话 fixture', selected: fixtureMode === 'conversation', onSelect: () => { closeScenarioLab(); closeSimulatorTask(); setFixtureMode('conversation') } },
      { kind: 'action' as const, id: 'fixture-empty', label: en ? 'Empty fixture' : '空会话 fixture', selected: fixtureMode === 'empty', onSelect: () => { closeScenarioLab(); closeSimulatorTask(); setFixtureMode('empty') } },
    ] : []),
    { kind: 'separator', id: 'runtime-separator' },
    { kind: 'heading', id: 'runtime-heading', label: en ? 'Runtime' : '运行时' },
    { kind: 'action', id: 'reload', label: en ? 'Reload plugins' : '重载插件', onSelect: () => window.location.reload() },
    { kind: 'action', id: 'reset', label: en ? 'Reset fixture' : '重置 fixture', onSelect: () => { void reset() } },
  ]

  return (
    <div ref={shell} className="pg-shell" data-pg-fixture-mode={fixtureMode} data-pg-locale={environment.locale}>
      <aside className="pg-sidebar" aria-label={en ? 'Playground navigation' : 'Playground 导航'}>
        <div className="pg-brand-seat">
          <span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true" />
        </div>
        <div className="pg-sidebar-stack">
          {fixture.reviewNavigationItem === undefined
            ? <SidebarItem id="action.new" label={en ? 'New task' : '新任务'} icon="host:new" onActivate={() => { closeScenarioLab(); closeSimulatorTask(); setFixtureMode('empty') }} />
            : null}
          <nav className="pg-primary-navigation" aria-label={en ? 'Plugin navigation' : '插件导航'} onClickCapture={preparePluginNavigation}>
            {fixture.reviewNavigationItem === undefined
              ? <SidebarItem id="host.playground" label="Playground" icon="host:playground" onActivate={() => { closeScenarioLab(); closeSimulatorTask(); setFixtureMode('conversation') }} />
              : null}
            <div className="pg-surface-seat pg-navigation-seat" data-cordisx-playground-surface="sidebar.navigation.items" data-pg-seat-label="sidebar.navigation.items" />
          </nav>
        </div>
        <section className="pg-recent-task-list" aria-labelledby="pg-recent-task-list-title" data-playground-recent-tasks>
          <div className="pg-session-heading"><span id="pg-recent-task-list-title">{en ? 'Recent tasks' : '最近任务'}</span></div>
          {recentTasks.length === 0
            ? <p>{en ? 'No recent tasks.' : '暂无最近任务。'}</p>
            : recentTasks.map(task => <div key={task.debugTaskId} data-recent-task-row={task.debugTaskId}>
                <SidebarItem
                  id={`task.${task.debugTaskId}`}
                  label={task.agentLabel}
                  secondary={`${task.identity.agentId} · ${task.identity.revision} · ${en ? 'Mock' : '模拟'}`}
                  icon="host:history"
                  selected={task.debugTaskId === simulatorTaskId}
                  onActivate={() => { setScenarioLabOpen(false); openSimulatorTask(task.detailsUrl) }}
                />
              </div>)}
        </section>
        {fixture.reviewNavigationItem === undefined ? <section className="pg-playground-fixtures" aria-labelledby="pg-playground-fixtures-title">
          <div className="pg-session-heading"><span id="pg-playground-fixtures-title">{en ? 'Playground fixtures' : 'Playground 测试场景'}</span><small>Debug</small></div>
          <div className="pg-session-list">
            <SidebarItem id="fixture.conversation" label={en ? 'Plugin composition' : '调试插件组合'} secondary={en ? 'Inspect pages and slots' : '验证页面与插槽贡献'} icon="host:playground" selected={!scenarioLabOpen && simulatorTask === undefined && fixtureMode === 'conversation'} onActivate={() => { closeScenarioLab(); closeSimulatorTask(); setFixtureMode('conversation') }} />
            <SidebarItem id="fixture.empty" label={en ? 'Empty conversation' : '空会话'} secondary={en ? 'Inspect the no-context state' : '检查无上下文状态'} icon="host:new" selected={!scenarioLabOpen && simulatorTask === undefined && fixtureMode === 'empty'} onActivate={() => { closeScenarioLab(); closeSimulatorTask(); setFixtureMode('empty') }} />
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
      {scenarioLabOpen
        ? <ScenarioLabPage locale={environment.locale} onClose={() => setScenarioLabOpen(false)} />
        : simulatorTask === undefined
          ? <HostSeats mode={fixtureMode} locale={environment.locale} />
          : <MockAgentTaskPage task={simulatorTask} locale={environment.locale} />}
    </div>
  )
}
