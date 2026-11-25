import { useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { HostThemeProjection } from '../renderer/host-theme.js'
import type { ManagerSnapshot } from '../renderer/manager.js'
import { ManagerFrame } from '../renderer/manager/components/ManagerFrame.js'
import { ManagerHeader } from '../renderer/manager/components/ManagerHeader.js'
import { Navigation } from '../renderer/manager/components/Navigation.js'
import { useManagerRouter } from '../renderer/manager/hooks/useManagerRouter.js'
import type { ManagerRoute } from '../renderer/manager/model/routes.js'
import {
  type StandaloneStartupFailure,
  type StandaloneStartupSurface,
  type StandaloneStartupWindow,
} from '../renderer/manager/standalone-startup-contract.js'

type State = 'loading' | 'unavailable' | 'result-unknown' | 'refresh'

function startupSnapshot(document: Document): ManagerSnapshot {
  return {
    version: '',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: document.documentElement.lang || 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    permissions: [],
    platform: {
      hostId: 'standalone',
      hostName: 'CordisX',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
  }
}

function StartingManager({ document, state, reportRoute }: {
  readonly document: Document
  readonly state: State
  readonly reportRoute: (route: ManagerRoute) => void
}) {
  const storage = (() => {
    try {
      return document.defaultView?.sessionStorage
    } catch {
      return undefined
    }
  })()
  const router = useManagerRouter(undefined, storage)
  const snapshot = startupSnapshot(document)
  const locale = snapshot.localization.locale
  const zh = locale.toLowerCase().startsWith('zh')
  useLayoutEffect(() => reportRoute(router.route), [reportRoute, router.route])
  const content = state === 'loading'
    ? (
      <div
        className="cxr-standalone-loading"
        role="status"
        aria-label={zh ? '正在加载页面' : 'Loading page'}
        aria-busy="true"
        data-manager-starting="true"
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </div>
    )
    : (
      <p className="cxr-standalone-unavailable" role="status">
        {state === 'result-unknown'
          ? zh
            ? '操作结果未确认。请重新打开管理页面，核对已保存的配置后再继续。'
            : 'The operation result is unknown. Reopen the Manager and check the saved configuration.'
          : state === 'refresh'
          ? zh
            ? '连接中断，请刷新页面重试。'
            : 'Connection interrupted. Refresh the page to retry.'
          : zh
          ? 'CordisX 连接不可用，请重新打开管理页面。'
          : 'CordisX connection unavailable. Reopen the Manager.'}
      </p>
    )
  return (
    <ManagerFrame
      standaloneMode
      workspaceMode={false}
      open
      surface="modal"
      locale={locale}
      sidebar={
        <Navigation
          snapshot={snapshot}
          router={router}
          onSelect={route => flushSync(() => router.navigate(route))}
        />
      }
      header={
        <ManagerHeader
          router={router}
          snapshot={snapshot}
          model={{}}
          surface="modal"
          standaloneMode
          workspaceMode={false}
          actionsEnabled={false}
        />
      }
    >
      <div className="cxr-content" data-content-layout="document">{content}</div>
    </ManagerFrame>
  )
}

/** Render only Host chrome until an owner-authorized Manager is admitted. */
export function createStandaloneStartup(document: Document): StandaloneStartupSurface {
  const view = document.defaultView as StandaloneStartupWindow | null
  if (view === null || view.__cordisxManagerStartupV1 !== undefined) {
    throw new Error('Standalone Manager starting surface is unavailable')
  }
  if (document.getElementById('cordisx-manager-startup-style') === null) {
    const style = document.createElement('link')
    style.id = 'cordisx-manager-startup-style'
    style.rel = 'stylesheet'
    style.href = '/manager-host.css'
    ;(document.head ?? document.documentElement).append(style)
  }
  const seat = document.createElement('div')
  seat.className = 'cxr-root'
  seat.dataset.managerSurface = 'standalone'
  seat.dataset.cordisxManagerStartup = 'true'
  ;(document.body ?? document.documentElement).append(seat)
  const theme = new HostThemeProjection(document)
  const detachTheme = theme.attach(seat)
  const root = createRoot(seat)
  let disposed = false
  let route: ManagerRoute = { kind: 'primary', page: 'plugins' }
  let activate: ((route: ManagerRoute) => void) | undefined
  const reportRoute = (next: ManagerRoute) => {
    route = next
  }
  const render = (state: State) =>
    flushSync(() =>
      root.render(
        <StartingManager document={document} state={state} reportRoute={reportRoute} />,
      )
    )
  const surface: StandaloneStartupSurface = {
    get disposed() {
      return disposed
    },
    stage: next => {
      if (disposed || activate !== undefined) throw new Error('Standalone Manager handoff is unavailable')
      activate = next
      return () => {
        if (activate === next) activate = undefined
      }
    },
    connected: () => {
      if (disposed || activate === undefined) return false
      activate(route)
      surface.dispose()
      return true
    },
    unavailable: (reason?: StandaloneStartupFailure) => {
      if (!disposed) render(reason ?? 'unavailable')
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      activate = undefined
      root.unmount()
      detachTheme()
      theme.dispose()
      seat.remove()
      if (view.__cordisxManagerStartupV1 === surface) delete view.__cordisxManagerStartupV1
    },
  }
  view.__cordisxManagerStartupV1 = surface
  try {
    render('loading')
  } catch (error) {
    surface.dispose()
    throw error
  }
  return surface
}
