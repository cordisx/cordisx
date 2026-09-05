import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { HostIcon } from '../../renderer/host-ui/HostIcon.js'
import { HostMenu, type HostMenuItem } from '../../renderer/host-ui/HostMenu.js'
import { createSidebarItem, type SidebarItemControl } from '../../renderer/host-ui/SidebarItem.js'
import { FixtureSummary } from './components/FixtureSummary.js'
import { HostSeats, type PlaygroundFixtureMode } from './components/HostSeats.js'
import { MockAgentTaskNotFoundPage, MockAgentTaskPage } from './components/MockAgentTaskPage.js'
import { type PlaygroundPreviewConnectionState, PreviewConnectionNotice } from './components/PreviewConnectionNotice.js'
import { PlaygroundScenarioLabController } from '../scenario-lab.js'
import { playgroundEnvironment, usePlaygroundEnvironment } from './environment.js'
import fixture from 'virtual:cordisx-playground-fixture'
import { activatePlaygroundReviewNavigation, authorizePlaygroundReviewNavigation } from './review-navigation.js'
import {
  beginPlaygroundPreviewRuntimeReset,
  bootRuntime,
  cancelPlaygroundPreviewRuntimeReset,
  completePlaygroundPreviewRuntimeReset,
  PLAYGROUND_PREVIEW_RESET_APPLY_EVENT,
  playgroundPreviewResetEpochReadback,
  playgroundSimulatorSourceBreakdown,
  playgroundSimulatorTaskSources,
  registerPlaygroundHostSessionTask,
  requestPlaygroundPreviewInstanceReset,
  resetPlaygroundLiveSimulator,
  useRuntimeState,
} from './runtime-store.js'
import {
  clearPlaygroundSimulatorSessionRegistry,
  countPlaygroundSimulatorSessionRecords,
  navigateTaskDetails,
  type PlaygroundHostSessionTaskContext,
  simulatorTaskIdFromPath,
  subscribePlaygroundTaskLocation,
} from './task-details-navigation.js'
import {
  clearPlaygroundPreviewResetMarker,
  PLAYGROUND_PREVIEW_RESET_RESULT_KEY,
  playgroundPreviewResetDisposition,
  type PlaygroundPreviewResetMarker,
  type PlaygroundPreviewResetResult,
  readPlaygroundPreviewResetMarker,
  readPlaygroundPreviewResetResult,
  writePlaygroundPreviewResetMarker,
  writePlaygroundPreviewResetResult,
} from './preview-reset.js'

interface SidebarItemProps {
  readonly id: string
  readonly label: string
  readonly ariaLabel?: string
  readonly secondary?: string
  readonly icon: string
  readonly selected?: boolean
  readonly onActivate: () => void
}

interface PlaygroundRouteHistoryState {
  readonly available: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly reason?: string
}

const UNAVAILABLE_ROUTE_HISTORY: PlaygroundRouteHistoryState = Object.freeze({
  available: false,
  canGoBack: false,
  canGoForward: false,
  reason: 'Playground route history is starting',
})

const PLAYGROUND_NAVIGATION_COLLAPSED_KEY = 'cordisx.playground.host-navigation-collapsed/v1'
const PLAYGROUND_TASK_DETAILS_SESSION_RESOLVER = '__cordisxPlaygroundTaskDetailsSessionV1'

type PlaygroundTaskDetailsResolverWindow = Window & {
  [PLAYGROUND_TASK_DETAILS_SESSION_RESOLVER]?: (
    input: PlaygroundHostSessionTaskContext,
  ) => PlaygroundHostSessionTaskContext['detailsUrl']
}

function PlaygroundNavigationToggleIcon({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg
      className="pg-host-chrome-icon pg-host-navigation-toggle-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.25 2.75v10.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d={collapsed ? 'm8.25 5.75 2.25 2.25-2.25 2.25' : 'm10.5 5.75-2.25 2.25 2.25 2.25'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function initialNavigationCollapsed(): boolean {
  try {
    return sessionStorage.getItem(PLAYGROUND_NAVIGATION_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function previewResetReadback(): Pick<
  PlaygroundPreviewResetResult,
  | 'roomRows'
  | 'recentTaskRows'
  | 'simulatorRecords'
  | 'sources'
  | 'instanceId'
  | 'serverGeneration'
  | 'appliedGeneration'
> {
  const epoch = playgroundPreviewResetEpochReadback()
  return {
    roomRows: document.querySelectorAll('.pg-navigation-seat [data-navigation-group] [data-sidebar-item]').length,
    recentTaskRows: document.querySelectorAll('[data-playground-recent-tasks] [data-recent-task-row]').length,
    simulatorRecords: countPlaygroundSimulatorSessionRecords(sessionStorage),
    sources: playgroundSimulatorSourceBreakdown(),
    instanceId: epoch.server?.instanceId ?? epoch.applied?.instanceId ?? 'unavailable',
    serverGeneration: epoch.server?.generation ?? -1,
    appliedGeneration: epoch.applied?.generation ?? -2,
  }
}

function previewResetMessage(
  result: Pick<
    PlaygroundPreviewResetResult,
    'roomRows' | 'recentTaskRows' | 'simulatorRecords' | 'sources' | 'serverGeneration' | 'appliedGeneration'
  >,
  en: boolean,
): string {
  const sources = result.sources
  return en
    ? `epoch ${result.appliedGeneration}/${result.serverGeneration} · Rooms ${result.roomRows} · recent ${result.recentTaskRows} · records ${result.simulatorRecords} · live ${sources.liveRuntime} · memory ${sources.runtimeMemory} · registry ${sources.taskSnapshotRegistry} · Host sessions ${sources.hostSessionRegistry} · legacy ${sources.legacyAliasRegistry} · final ${sources.finalSelector}`
    : `epoch ${result.appliedGeneration}/${result.serverGeneration} · 房间 ${result.roomRows} · 最近任务 ${result.recentTaskRows} · 记录 ${result.simulatorRecords} · live ${sources.liveRuntime} · memory ${sources.runtimeMemory} · registry ${sources.taskSnapshotRegistry} · Host session ${sources.hostSessionRegistry} · legacy ${sources.legacyAliasRegistry} · final ${sources.finalSelector}`
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
    return () => {
      item.dispose()
      control.current = undefined
    }
  }, [props.id, props.label, props.ariaLabel, props.secondary, props.icon])
  useLayoutEffect(() => control.current?.setSelected(props.selected === true), [props.selected])
  return <div ref={host} className="pg-sidebar-item-host" />
}

function PreviewResetConfirmation({ locale, phase, error, onCancel, onConfirm }: {
  readonly locale: 'zh-CN' | 'en'
  readonly phase: 'confirming' | 'resetting' | 'failed'
  readonly error?: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const en = locale === 'en'
  const resetting = phase === 'resetting'

  useEffect(() => {
    const focusTimer = window.setTimeout(() => cancel.current?.focus({ preventScroll: true }), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !resetting) {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const buttons = [cancel.current, confirm.current].filter((button): button is HTMLButtonElement =>
        button !== null && !button.disabled
      )
      if (buttons.length === 0) return
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.shiftKey
        ? buttons[current <= 0 ? buttons.length - 1 : current - 1]
        : buttons[current >= buttons.length - 1 ? 0 : current + 1]
      event.preventDefault()
      next?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onCancel, resetting])

  return (
    <div
      className="pg-preview-reset-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget && !resetting) onCancel()
      }}
    >
      <section
        className="pg-preview-reset-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pg-preview-reset-title"
        aria-describedby="pg-preview-reset-description"
      >
        <h2 id="pg-preview-reset-title">{en ? 'Clear local preview data?' : '清空本地预览数据？'}</h2>
        <p id="pg-preview-reset-description">
          {en
            ? 'This permanently clears disposable Chatroom fixtures, recent Simulator tasks, snapshots, ledgers, and debug sessions across every tab connected to this preview instance. Each tab refreshes after applying the same reset generation. Theme, language, and navigation preferences are kept.'
            : '这会永久清除连接到当前预览实例的所有标签中的可丢弃 Chatroom fixture、最近 Simulator tasks、快照、ledgers 与调试会话。每个标签应用同一清理代际后会自动刷新。主题、语言和导航偏好会保留。'}
        </p>
        <p className="pg-preview-reset-warning">{en ? 'This action cannot be undone.' : '此操作不可恢复。'}</p>
        {error === undefined ? null : <p className="pg-preview-reset-error" role="alert">{error}</p>}
        <footer>
          <button ref={cancel} type="button" disabled={resetting} onClick={onCancel}>{en ? 'Cancel' : '取消'}</button>
          <button
            ref={confirm}
            type="button"
            className="pg-preview-reset-danger"
            disabled={resetting}
            onClick={onConfirm}
          >
            {resetting ? (en ? 'Clearing…' : '正在清空…') : (en ? 'Clear and refresh' : '清空并刷新')}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function App() {
  const runtime = useRuntimeState()
  const environment = usePlaygroundEnvironment()
  const [fixtureMode, setFixtureMode] = useState<PlaygroundFixtureMode>(
    fixture.reviewNavigationItem === undefined ? 'conversation' : 'review',
  )
  const [simulatorTaskId, setSimulatorTaskId] = useState<string | undefined>(() =>
    simulatorTaskIdFromPath(window.location.pathname)
  )
  const [navigationCollapsed, setNavigationCollapsed] = useState(initialNavigationCollapsed)
  const [routeHistory, setRouteHistory] = useState<PlaygroundRouteHistoryState>(UNAVAILABLE_ROUTE_HISTORY)
  const [previewConnection, setPreviewConnection] = useState<'connected' | PlaygroundPreviewConnectionState>(
    'connected',
  )
  const initialResetMarker = useRef<PlaygroundPreviewResetMarker | undefined>(
    readPlaygroundPreviewResetMarker(sessionStorage),
  )
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false)
  const [resetPhase, setResetPhase] = useState<'confirming' | 'resetting' | 'failed'>('confirming')
  const [resetError, setResetError] = useState<string>()
  const [resetResult, setResetResult] = useState<PlaygroundPreviewResetResult | undefined>(() =>
    readPlaygroundPreviewResetResult(sessionStorage)
  )
  const resetRecoveryStarted = useRef(false)
  const resetRequestAuthority = useRef<symbol | undefined>(undefined)
  const resetRequestOrdinal = useRef(0)
  const shell = useRef<HTMLDivElement>(null)
  const navigationToggle = useRef<HTMLButtonElement>(null)
  const restoreNavigationToggleFocus = useRef(false)
  const scenarioControllers = useRef(
    new Map<
      string,
      PlaygroundScenarioLabController | {
        readonly bindingSignature: string
        readonly controller: PlaygroundScenarioLabController
      }
    >(),
  )
  const scenarioControllerFor = (
    entry: PlaygroundScenarioLabController | {
      readonly bindingSignature: string
      readonly controller: PlaygroundScenarioLabController
    },
  ) => 'controller' in entry ? entry.controller : entry
  const en = environment.locale === 'en'
  const resetEpoch = playgroundPreviewResetEpochReadback()
  let simulatorSessionRecordCount = 0
  try {
    simulatorSessionRecordCount = countPlaygroundSimulatorSessionRecords(sessionStorage)
  } catch { /* optional browser session storage */ }

  useEffect(() => {
    const disposeScenarioControllers = () => {
      for (const entry of scenarioControllers.current.values()) scenarioControllerFor(entry).dispose()
      scenarioControllers.current.clear()
    }
    window.addEventListener(PLAYGROUND_PREVIEW_RESET_APPLY_EVENT, disposeScenarioControllers)
    return () => window.removeEventListener(PLAYGROUND_PREVIEW_RESET_APPLY_EVENT, disposeScenarioControllers)
  }, [])
  useEffect(() => {
    void bootRuntime()
  }, [])
  useEffect(() => {
    const marker = readPlaygroundPreviewResetMarker(sessionStorage)
    if (marker === undefined || resetRecoveryStarted.current) return
    if (marker.phase !== 'requesting' && runtime.status !== 'active') return
    resetRecoveryStarted.current = true
    const finish = async () => {
      const restoreCollapsedNavigation = navigationCollapsed
      try {
        if (marker.phase === 'requesting') {
          clearPlaygroundPreviewResetMarker(sessionStorage)
          cancelPlaygroundPreviewRuntimeReset()
          setResetPhase('confirming')
          setResetConfirmationOpen(false)
          return
        }
        if (restoreCollapsedNavigation) setNavigationCollapsed(false)
        await new Promise(resolve => window.setTimeout(resolve, 650))
        for (const entry of scenarioControllers.current.values()) scenarioControllerFor(entry).dispose()
        scenarioControllers.current.clear()
        resetPlaygroundLiveSimulator()
        clearPlaygroundSimulatorSessionRegistry(sessionStorage)
        completePlaygroundPreviewRuntimeReset()
        for (let pass = 0; pass < 3; pass += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 450))
          resetPlaygroundLiveSimulator()
          clearPlaygroundSimulatorSessionRegistry(sessionStorage)
        }
        await new Promise(resolve => window.setTimeout(resolve, 450))
        const counts = previewResetReadback()
        if (restoreCollapsedNavigation) setNavigationCollapsed(true)
        const disposition = playgroundPreviewResetDisposition(counts)
        const complete = disposition.complete
        const result: PlaygroundPreviewResetResult = {
          version: 1,
          status: complete ? 'complete' : 'failed',
          ...counts,
          completedAt: new Date().toISOString(),
          ...(complete ? {} : { message: `Reset readback is non-zero: ${previewResetMessage(counts, false)}` }),
        }
        writePlaygroundPreviewResetResult(sessionStorage, result)
        setResetResult(result)
        if (!complete) {
          beginPlaygroundPreviewRuntimeReset()
          setResetError(
            en
              ? `Clear failed verification: ${previewResetMessage(counts, true)}`
              : `清理读回失败：${previewResetMessage(counts, false)}`,
          )
          setResetPhase('failed')
          setResetConfirmationOpen(disposition.confirmationOpen)
          return
        }
        clearPlaygroundPreviewResetMarker(sessionStorage)
        setResetError(undefined)
        setResetPhase('confirming')
        setResetConfirmationOpen(disposition.confirmationOpen)
      } catch (error) {
        if (restoreCollapsedNavigation) setNavigationCollapsed(true)
        const message = error instanceof Error ? error.message : String(error)
        const counts = previewResetReadback()
        const result: PlaygroundPreviewResetResult = {
          version: 1,
          status: 'failed',
          ...counts,
          completedAt: new Date().toISOString(),
          message,
        }
        writePlaygroundPreviewResetResult(sessionStorage, result)
        setResetResult(result)
        setResetError(message)
        setResetPhase('failed')
        setResetConfirmationOpen(true)
      }
    }
    void finish()
  }, [en, navigationCollapsed, runtime.status])
  useEffect(() => {
    const view = window as PlaygroundTaskDetailsResolverWindow
    const previous = view[PLAYGROUND_TASK_DETAILS_SESSION_RESOLVER]
    view[PLAYGROUND_TASK_DETAILS_SESSION_RESOLVER] = registerPlaygroundHostSessionTask
    return () => {
      if (previous === undefined) delete view[PLAYGROUND_TASK_DETAILS_SESSION_RESOLVER]
      else view[PLAYGROUND_TASK_DETAILS_SESSION_RESOLVER] = previous
    }
  }, [])
  useEffect(() => {
    const hot = import.meta.hot
    if (hot === undefined) return undefined
    const disconnect = () => setPreviewConnection('disconnected')
    const reconnect = () => {
      setPreviewConnection('reconnecting')
      void bootRuntime().then(() => setPreviewConnection('connected'))
    }
    hot.on('vite:ws:disconnect', disconnect)
    hot.on('vite:ws:connect', reconnect)
    return () => {
      hot.off('vite:ws:disconnect', disconnect)
      hot.off('vite:ws:connect', reconnect)
    }
  }, [])
  useEffect(() => shell.current === null ? undefined : playgroundEnvironment.attachTheme(shell.current), [])
  useLayoutEffect(() => {
    if (!restoreNavigationToggleFocus.current) return
    restoreNavigationToggleFocus.current = false
    navigationToggle.current?.focus()
  }, [navigationCollapsed])
  useEffect(() => {
    if (runtime.status !== 'active') {
      setRouteHistory(UNAVAILABLE_ROUTE_HISTORY)
      return undefined
    }
    const hostRuntime = window.__cordisxRuntime
    const refresh = () => {
      const next = hostRuntime?.playgroundRouteHistory?.() ?? UNAVAILABLE_ROUTE_HISTORY
      setRouteHistory(current =>
        current.available === next.available
          && current.canGoBack === next.canGoBack
          && current.canGoForward === next.canGoForward
          && current.reason === next.reason
          ? current
          : next
      )
    }
    refresh()
    const unsubscribe = hostRuntime?.subscribePlaygroundRouteHistory?.(refresh)
    const timer = window.setInterval(refresh, 300)
    return () => {
      unsubscribe?.()
      window.clearInterval(timer)
    }
  }, [runtime.status])
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
  const recentTasks = [...(runtime.simulator?.tasks ?? [])].reverse()
  const simulatorSources = playgroundSimulatorSourceBreakdown()
  const simulatorTask = recentTasks.find(task =>
    task.taskRef === simulatorTaskId || task.debugTaskId === simulatorTaskId
  )
  let simulatorScenarioController: PlaygroundScenarioLabController | undefined
  if (simulatorTask !== undefined) {
    const bindingSignature = JSON.stringify(simulatorTask.simulationBinding ?? null)
    const existing = scenarioControllers.current.get(simulatorTask.taskRef)
    if (existing !== undefined && 'controller' in existing && existing.bindingSignature === bindingSignature) {
      simulatorScenarioController = existing.controller
    } else {
      if (existing !== undefined) scenarioControllerFor(existing).dispose()
      simulatorScenarioController = new PlaygroundScenarioLabController(simulatorTask)
      scenarioControllers.current.set(simulatorTask.taskRef, {
        bindingSignature,
        controller: simulatorScenarioController,
      })
    }
  }
  useEffect(() => () => {
    for (const entry of scenarioControllers.current.values()) scenarioControllerFor(entry).dispose()
    scenarioControllers.current.clear()
  }, [])
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
    if (simulatorTaskId !== undefined) flushSync(() => setSimulatorTaskId(undefined))
  }
  const closeSimulatorTask = () => {
    setSimulatorTaskId(undefined)
    if (window.location.pathname.startsWith('/playground/simulator/tasks/')) {
      window.history.pushState(window.history.state, '', '/')
    }
  }
  const openScenarioWorkbench = () => {
    const task = recentTasks[0]
    if (task !== undefined) openSimulatorTask(task.detailsUrl)
  }
  const toggleNavigation = () => {
    const next = !navigationCollapsed
    const focusedInSidebar = next && document.activeElement instanceof HTMLElement
      && document.activeElement.closest('.pg-sidebar') !== null
    const focusedInControls = document.activeElement instanceof HTMLElement
      && document.activeElement.closest('.pg-main-chrome-leading') !== null
    restoreNavigationToggleFocus.current = focusedInSidebar || focusedInControls
    setNavigationCollapsed(next)
    try {
      sessionStorage.setItem(PLAYGROUND_NAVIGATION_COLLAPSED_KEY, String(next))
    } catch { /* optional developer-session preference */ }
  }
  const moveRouteHistory = (delta: -1 | 1) => {
    const go = window.__cordisxRuntime?.goPlaygroundRouteHistory
    if (go === undefined) return
    void go(delta).catch(() =>
      setRouteHistory(window.__cordisxRuntime?.playgroundRouteHistory?.() ?? UNAVAILABLE_ROUTE_HISTORY)
    )
  }

  const closeResetConfirmation = () => {
    if (resetPhase === 'resetting') return
    if (resetPhase === 'failed' || resetResult?.status === 'failed') {
      clearPlaygroundPreviewResetMarker(sessionStorage)
      cancelPlaygroundPreviewRuntimeReset()
    }
    setResetConfirmationOpen(false)
    queueMicrotask(() =>
      shell.current?.querySelector<HTMLButtonElement>('.pg-sidebar-control')?.focus({ preventScroll: true })
    )
  }
  const openResetConfirmation = () => {
    setResetError(undefined)
    setResetPhase('confirming')
    setResetConfirmationOpen(true)
  }
  const reset = async () => {
    if (resetPhase === 'resetting') return
    setResetError(undefined)
    setResetPhase('resetting')
    const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    resetRequestOrdinal.current += 1
    const authority = Symbol('playground-preview-reset-request')
    resetRequestAuthority.current = authority
    const requestId = `document:${resetEpoch.server?.instanceId ?? 'unbound'}:${resetRequestOrdinal.current}`
    const marker: PlaygroundPreviewResetMarker = {
      version: 1,
      nonce: requestId,
      phase: 'requesting',
      startedAt: new Date().toISOString(),
    }
    try {
      sessionStorage.removeItem(PLAYGROUND_PREVIEW_RESET_RESULT_KEY)
      setResetResult(undefined)
      writePlaygroundPreviewResetMarker(sessionStorage, marker)
      if (resetRequestAuthority.current !== authority) {
        throw new Error('Preview reset request authority is no longer active')
      }
      await requestPlaygroundPreviewInstanceReset(requestId)
    } catch (error) {
      clearPlaygroundPreviewResetMarker(sessionStorage)
      cancelPlaygroundPreviewRuntimeReset()
      window.history.replaceState(window.history.state, '', previousUrl)
      setResetError(error instanceof Error ? error.message : String(error))
      setResetPhase('failed')
    } finally {
      if (resetRequestAuthority.current === authority) resetRequestAuthority.current = undefined
    }
  }
  const menuItems: readonly HostMenuItem[] = [
    { kind: 'heading', id: 'theme-heading', label: en ? 'Appearance' : '外观' },
    ...(['system', 'light', 'dark'] as const).map(value => ({
      kind: 'action' as const,
      id: `theme-${value}`,
      label: en
        ? ({ system: 'Follow system', light: 'Light', dark: 'Dark' } as const)[value]
        : ({ system: '跟随系统', light: '浅色', dark: '深色' } as const)[value],
      selected: environment.themePreference === value,
      onSelect: () => playgroundEnvironment.setTheme(value),
    })),
    { kind: 'separator', id: 'theme-locale-separator' },
    { kind: 'heading', id: 'locale-heading', label: en ? 'Language' : '语言' },
    {
      kind: 'action',
      id: 'locale-zh',
      label: '中文',
      selected: environment.locale === 'zh-CN',
      onSelect: () => playgroundEnvironment.setLocale('zh-CN'),
    },
    {
      kind: 'action',
      id: 'locale-en',
      label: 'English',
      selected: environment.locale === 'en',
      onSelect: () => playgroundEnvironment.setLocale('en'),
    },
    { kind: 'separator' as const, id: 'developer-separator' },
    { kind: 'heading' as const, id: 'developer-heading', label: en ? 'Developer' : '开发' },
    {
      kind: 'action' as const,
      id: 'scenario-lab',
      label: en ? 'Chatroom interaction scenarios' : 'Chatroom 交互场景',
      selected: simulatorTask !== undefined,
      disabled: recentTasks.length === 0,
      onSelect: openScenarioWorkbench,
    },
    ...(fixture.reviewNavigationItem === undefined
      ? [
        {
          kind: 'action' as const,
          id: 'fixture-conversation',
          label: en ? 'Conversation fixture' : '有会话 fixture',
          selected: fixtureMode === 'conversation',
          onSelect: () => {
            closeSimulatorTask()
            setFixtureMode('conversation')
          },
        },
        {
          kind: 'action' as const,
          id: 'fixture-empty',
          label: en ? 'Empty fixture' : '空会话 fixture',
          selected: fixtureMode === 'empty',
          onSelect: () => {
            closeSimulatorTask()
            setFixtureMode('empty')
          },
        },
      ]
      : []),
    { kind: 'separator', id: 'runtime-separator' },
    { kind: 'heading', id: 'runtime-heading', label: en ? 'Runtime' : '运行时' },
    {
      kind: 'heading',
      id: 'runtime-reset-epoch',
      label: en
        ? `Preview reset epoch · server ${resetEpoch.server?.generation ?? 'starting'} · this tab ${
          resetEpoch.applied?.generation ?? 'not applied'
        }${resetEpoch.synchronized ? ' · synchronized' : ' · pending'}`
        : `预览清理代际 · server ${resetEpoch.server?.generation ?? '启动中'} · 本标签 ${
          resetEpoch.applied?.generation ?? '未应用'
        }${resetEpoch.synchronized ? ' · 已同步' : ' · 待同步'}`,
    },
    {
      kind: 'heading',
      id: 'runtime-simulator-sources',
      label: en
        ? `Simulator sources · final ${simulatorSources.finalSelector} · live ${simulatorSources.liveRuntime} · memory ${simulatorSources.runtimeMemory} · registry ${simulatorSources.taskSnapshotRegistry} · Host ${simulatorSources.hostSessionRegistry} · legacy ${simulatorSources.legacyAliasRegistry}`
        : `Simulator 数据源 · final ${simulatorSources.finalSelector} · live ${simulatorSources.liveRuntime} · memory ${simulatorSources.runtimeMemory} · registry ${simulatorSources.taskSnapshotRegistry} · Host ${simulatorSources.hostSessionRegistry} · legacy ${simulatorSources.legacyAliasRegistry}`,
    },
    ...(resetResult === undefined ? [] : [{
      kind: 'heading' as const,
      id: 'reset-result',
      label: `${
        resetResult.status === 'complete'
          ? (en ? 'Last clear complete' : '上次清理完成')
          : (en ? 'Last clear failed' : '上次清理失败')
      } · ${previewResetMessage(resetResult, en)}`,
    }]),
    {
      kind: 'action',
      id: 'reload',
      label: en ? 'Reload plugins' : '重载插件',
      onSelect: () => window.location.reload(),
    },
    {
      kind: 'action',
      id: 'reset',
      label: en ? 'Clear preview data…' : '清空预览数据…',
      onSelect: openResetConfirmation,
    },
  ]

  const previewNoticeState: PlaygroundPreviewConnectionState | undefined = previewConnection === 'disconnected'
    ? 'disconnected'
    : runtime.status === 'failed'
    ? 'failed'
    : previewConnection === 'reconnecting' || runtime.status !== 'active'
    ? 'reconnecting'
    : undefined

  const hostChromeControls = (
    <nav
      className="pg-main-chrome-leading"
      data-placement={navigationCollapsed ? 'main' : 'sidebar'}
      data-route-history-availability={routeHistory.available ? 'available' : 'unavailable'}
      aria-label={en ? 'Playground Host navigation simulation' : 'Playground Host 导航模拟'}
    >
      <button
        ref={navigationToggle}
        type="button"
        className="pg-host-chrome-button pg-host-navigation-toggle"
        aria-label={navigationCollapsed
          ? (en ? 'Expand Playground navigation' : '展开 Playground 导航')
          : (en ? 'Collapse Playground navigation' : '折叠 Playground 导航')}
        title={navigationCollapsed
          ? (en ? 'Expand navigation · developer simulation' : '展开导航 · 开发模拟')
          : (en ? 'Collapse navigation · developer simulation' : '折叠导航 · 开发模拟')}
        aria-expanded={!navigationCollapsed}
        onClick={toggleNavigation}
      >
        <PlaygroundNavigationToggleIcon collapsed={navigationCollapsed} />
      </button>
      <button
        type="button"
        className="pg-host-chrome-button"
        aria-label={en ? 'Back' : '后退'}
        title={routeHistory.canGoBack
          ? (en ? 'Back' : '后退')
          : (routeHistory.reason ?? (en ? 'No previous route' : '没有上一条路由'))}
        disabled={!routeHistory.available || !routeHistory.canGoBack}
        onClick={() => moveRouteHistory(-1)}
      >
        <HostIcon token="action.back" className="pg-host-chrome-icon" size={16} />
      </button>
      <button
        type="button"
        className="pg-host-chrome-button"
        aria-label={en ? 'Forward' : '前进'}
        title={routeHistory.canGoForward
          ? (en ? 'Forward' : '前进')
          : (routeHistory.reason ?? (en ? 'No next route' : '没有下一条路由'))}
        disabled={!routeHistory.available || !routeHistory.canGoForward}
        onClick={() => moveRouteHistory(1)}
      >
        <HostIcon token="control.chevron-right" className="pg-host-chrome-icon" size={16} />
      </button>
      <span className="pg-main-chrome-divider" aria-hidden="true" />
    </nav>
  )

  return (
    <div
      ref={shell}
      className="pg-shell"
      data-pg-fixture-mode={fixtureMode}
      data-pg-locale={environment.locale}
      data-navigation-collapsed={navigationCollapsed}
      data-simulator-session-record-count={simulatorSessionRecordCount}
      data-preview-reset-live-recent-tasks={recentTasks.length}
      data-simulator-source-live-runtime={simulatorSources.liveRuntime}
      data-simulator-source-agent-session={simulatorSources.agentSessionAuthority}
      data-simulator-source-runtime-memory={simulatorSources.runtimeMemory}
      data-simulator-source-task-registry={simulatorSources.taskSnapshotRegistry}
      data-simulator-source-host-session={simulatorSources.hostSessionRegistry}
      data-simulator-source-legacy-alias={simulatorSources.legacyAliasRegistry}
      data-simulator-source-final-selector={simulatorSources.finalSelector}
      data-preview-reset-source-version="all-sources-v1"
      data-preview-reset-status={resetResult?.status ?? 'none'}
      data-preview-reset-instance-id={resetEpoch.server?.instanceId ?? resetEpoch.applied?.instanceId ?? ''}
      data-preview-reset-server-generation={resetEpoch.server?.generation ?? ''}
      data-preview-reset-applied-generation={resetEpoch.applied?.generation ?? ''}
      data-preview-reset-epoch-synchronized={resetEpoch.synchronized}
      data-playground-runtime-error={runtime.error ?? ''}
      data-preview-reset-room-rows={resetResult?.roomRows ?? ''}
      data-preview-reset-recent-task-rows={resetResult?.recentTaskRows ?? ''}
    >
      {resetConfirmationOpen
        ? (
          <PreviewResetConfirmation
            locale={environment.locale}
            phase={resetPhase}
            {...(resetError === undefined ? {} : { error: resetError })}
            onCancel={closeResetConfirmation}
            onConfirm={() => {
              void reset()
            }}
          />
        )
        : null}
      <aside className="pg-sidebar" aria-label={en ? 'Playground navigation' : 'Playground 导航'}>
        <div className="pg-brand-seat">
          <span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true" />
          <div className="pg-brand-chrome-seat">{navigationCollapsed ? null : hostChromeControls}</div>
        </div>
        {navigationCollapsed ? null : (
          <>
            <div className="pg-sidebar-scroll">
              <div className="pg-sidebar-stack">
                {fixture.reviewNavigationItem === undefined
                  ? (
                    <SidebarItem
                      id="action.new"
                      label={en ? 'New task' : '新任务'}
                      icon="host:new"
                      onActivate={() => {
                        closeSimulatorTask()
                        setFixtureMode('empty')
                      }}
                    />
                  )
                  : null}
                <nav
                  className="pg-primary-navigation"
                  aria-label={en ? 'Plugin navigation' : '插件导航'}
                  onClickCapture={preparePluginNavigation}
                >
                  {fixture.reviewNavigationItem === undefined
                    ? (
                      <SidebarItem
                        id="host.playground"
                        label="Playground"
                        icon="host:playground"
                        onActivate={() => {
                          closeSimulatorTask()
                          setFixtureMode('conversation')
                        }}
                      />
                    )
                    : null}
                  <div
                    className="pg-surface-seat pg-navigation-seat"
                    data-cordisx-playground-surface="sidebar.navigation.items"
                    data-pg-seat-label="sidebar.navigation.items"
                  />
                </nav>
              </div>
              <section
                className="pg-recent-task-list"
                aria-labelledby="pg-recent-task-list-title"
                data-playground-recent-tasks
              >
                <div className="pg-session-heading">
                  <span id="pg-recent-task-list-title">{en ? 'Recent tasks' : '最近任务'}</span>
                </div>
                {recentTasks.length === 0
                  ? <p>{en ? 'No recent tasks.' : '暂无最近任务。'}</p>
                  : recentTasks.map(task => {
                    const sources = playgroundSimulatorTaskSources(task.taskRef)
                    return (
                      <div
                        key={task.taskRef}
                        data-recent-task-row={task.taskRef}
                        data-recent-task-title={task.debugTaskId}
                        data-recent-task-sources={sources.join(',')}
                      >
                        <SidebarItem
                          id={`task.${task.taskRef}`}
                          label={task.agentLabel}
                          {...(task.scenario === undefined
                            ? {}
                            : {
                              secondary: `${
                                en ? 'Scenario' : '场景'
                              } ${task.scenario.code} · ${task.scenario.stepIndex}/${task.scenario.stepCount}`,
                            })}
                          ariaLabel={`${task.agentLabel} · ${en ? 'sources' : '来源'} ${sources.join(', ')}`}
                          icon="host:history"
                          selected={task.taskRef === simulatorTask?.taskRef}
                          onActivate={() => openSimulatorTask(task.detailsUrl)}
                        />
                      </div>
                    )
                  })}
              </section>
              {fixture.reviewNavigationItem === undefined
                ? (
                  <section className="pg-playground-fixtures" aria-labelledby="pg-playground-fixtures-title">
                    <div className="pg-session-heading">
                      <span id="pg-playground-fixtures-title">
                        {en ? 'Playground fixtures' : 'Playground 测试场景'}
                      </span>
                      <small>Debug</small>
                    </div>
                    <div className="pg-session-list">
                      <SidebarItem
                        id="fixture.conversation"
                        label={en ? 'Plugin composition' : '调试插件组合'}
                        secondary={en ? 'Inspect pages and slots' : '验证页面与插槽贡献'}
                        icon="host:playground"
                        selected={simulatorTask === undefined && fixtureMode === 'conversation'}
                        onActivate={() => {
                          closeSimulatorTask()
                          setFixtureMode('conversation')
                        }}
                      />
                      <SidebarItem
                        id="fixture.empty"
                        label={en ? 'Empty conversation' : '空会话'}
                        secondary={en ? 'Inspect the no-context state' : '检查无上下文状态'}
                        icon="host:new"
                        selected={simulatorTask === undefined && fixtureMode === 'empty'}
                        onActivate={() => {
                          closeSimulatorTask()
                          setFixtureMode('empty')
                        }}
                      />
                    </div>
                  </section>
                )
                : null}
            </div>
            <footer className="pg-sidebar-footer">
              <div className="pg-footer-surface" data-cordisx-playground-surface="sidebar.footer.before-control" />
              <HostMenu
                label={en ? 'Playground environment and developer tools' : 'Playground 环境与开发工具'}
                className="pg-sidebar-control"
                icon={<span className="pg-sidebar-control-icon" aria-hidden="true">•••</span>}
                copy={<span className="pg-sidebar-control-copy">{en ? 'Environment' : '环境与开发'}</span>}
                items={menuItems}
                footer={
                  <>
                    <div className="pg-tool-status">
                      <strong>{en ? 'Isolated Cordis runtime' : '独立 Cordis runtime'}</strong>
                      <span className="pg-status" role="status" title={runtime.error}>
                        {runtime.error === undefined ? runtime.status : `${runtime.status} · ${runtime.error}`}
                      </span>
                    </div>
                    <FixtureSummary plugins={runtime.plugins} locale={environment.locale} />
                    <p className="pg-capability-note">
                      <span data-pg-capability>Host connection unavailable</span> ·{' '}
                      {en ? 'This page does not start or connect to Codex.' : '本页不启动或连接真实 Codex。'}
                    </p>
                  </>
                }
              />
              <div className="pg-footer-surface" data-cordisx-playground-surface="sidebar.footer.after-control" />
            </footer>
          </>
        )}
      </aside>
      <div className="pg-main-chrome-seat">{navigationCollapsed ? hostChromeControls : null}</div>
      <div className="pg-main-column">
        {previewNoticeState === undefined
          ? simulatorTaskId !== undefined && simulatorTask === undefined
            ? (
              <MockAgentTaskNotFoundPage
                taskId={simulatorTaskId}
                locale={environment.locale}
                onReturn={closeSimulatorTask}
              />
            )
            : simulatorTask === undefined || simulatorScenarioController === undefined
            ? <HostSeats mode={fixtureMode} locale={environment.locale} />
            : (
              <MockAgentTaskPage
                task={simulatorTask}
                locale={environment.locale}
                scenarioController={simulatorScenarioController}
              />
            )
          : (
            <PreviewConnectionNotice
              state={previewNoticeState}
              locale={environment.locale}
              onRefresh={() => window.location.reload()}
            />
          )}
      </div>
    </div>
  )
}
