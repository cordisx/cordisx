import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { ManagerModel } from '../manager.js'
import { resolveManagerPaneSeat, resolveManagerRailSeat, resolveManagerTriggerTarget } from '../host-probes.js'
import { resolveManagerRailOnlyTitlebarSeat } from '../adapter/manager-rail-only-titlebar.js'
import {
  captureManagerTitlebarLease,
  type ManagerTitlebarLease,
  releaseManagerTitlebarLease,
  resolveManagerTitlebarContinuation,
} from '../adapter/manager-titlebar-continuation.js'
import { HostThemeProjection } from '../host-theme.js'
import { ManagerApp } from './ManagerApp.js'
import { createManagerMarketplaceStore } from './model/marketplace-store.js'
import { REACT_MANAGER_STYLES } from './styles.js'
import {
  MAX_MANAGER_SIDEBAR_WIDTH as MAX_SIDEBAR_WIDTH,
  maximumManagerSidebarWidth,
  MIN_MANAGER_SIDEBAR_WIDTH as MIN_SIDEBAR_WIDTH,
} from './sidebar-width.js'
import type { HostManagerNavigationController } from './navigation-controller.js'
import type { PluginManagementBinding } from '../management-binding.js'
import type { NativeRouteSource } from './native-route-transition.js'

const SIDEBAR_WIDTH_KEY = 'cordisx.manager.sidebar-width'

export interface ReactManagerInstallOptions {
  readonly triggerTarget?: () => HTMLElement | undefined
  readonly navigationController?: HostManagerNavigationController
  readonly pluginManagement?: PluginManagementBinding
  readonly nativeRouteHistory?: NativeRouteSource
  /** Opt-in Host workspace presentation; Codex still owns its native tabs and routes. */
  readonly presentationMode?: 'overlay' | 'workspace'
  /** Explicit compatibility for legacy Host fixtures; 26.924 production uses native two-pane seats. */
  readonly legacyModal?: boolean
}

/** One React root owns the complete Manager shell and every Host-owned page. */
export function installReactCordisXManager(
  document: Document,
  model: ManagerModel,
  options: ReactManagerInstallOptions = {},
): () => void {
  const presentationMode = options.legacyModal === true ? 'overlay' : options.presentationMode ?? 'overlay'
  const view = document.defaultView
  const installedAnimationFrameFallback = view !== null && typeof view.requestAnimationFrame !== 'function'
  if (installedAnimationFrameFallback) {
    view.requestAnimationFrame = callback => view.setTimeout(() => callback(view.performance.now()), 16)
    view.cancelAnimationFrame = handle => view.clearTimeout(handle)
  }
  const style = document.createElement('style')
  style.id = 'cordisx-react-manager-style'
  style.textContent = REACT_MANAGER_STYLES
  ;(document.head ?? document.documentElement).append(style)
  const rootSeat = document.createElement('div')
  rootSeat.className = 'cxr-root'
  rootSeat.dataset.cordisxReactManager = 'true'
  rootSeat.dataset.managerSurface = 'modal'
  rootSeat.hidden = presentationMode === 'workspace'
  const navigationSeat = document.createElement('div')
  navigationSeat.className = 'cxr-root cxr-native-navigation-seat'
  navigationSeat.dataset.cordisxManagerNavigationSeat = 'true'
  navigationSeat.dataset.cordisxManagerSidebarRoot = 'true'
  const titlebarSeat = document.createElement('div')
  titlebarSeat.className = 'cxr-root cxr-titlebar-root'
  titlebarSeat.dataset.cordisxManagerTitlebarSeat = 'true'
  titlebarSeat.dataset.managerSurface = 'pane'
  Object.assign(titlebarSeat.style, { position: 'absolute', pointerEvents: 'none', zIndex: '1' })
  const resizeHandle = document.createElement('div')
  resizeHandle.className = 'cxr-manager-sidebar-resizer'
  resizeHandle.dataset.cordisxManagerSidebarResizer = 'true'
  resizeHandle.setAttribute('role', 'separator')
  resizeHandle.setAttribute('aria-label', '调整 CordisX 侧栏宽度')
  resizeHandle.setAttribute('aria-orientation', 'vertical')
  resizeHandle.setAttribute('tabindex', '0')
  const triggerSeat = document.createElement('span')
  triggerSeat.className = 'cxr-trigger-seat'
  const railItem = document.createElement('div')
  railItem.className = 'contents'
  railItem.dataset.cordisxManagerRailItem = 'true'
  ;(document.body ?? document.documentElement).append(rootSeat)
  const theme = new HostThemeProjection(document)
  const detachRootTheme = theme.attach(rootSeat)
  const detachNavigationTheme = theme.attach(navigationSeat)
  const detachTitlebarTheme = theme.attach(titlebarSeat)
  const detachTriggerTheme = theme.attach(triggerSeat)
  const marketplace = createManagerMarketplaceStore(document, options.pluginManagement)
  type NativeState = {
    node: HTMLElement
    ariaHidden: string | null
    inert: boolean
    visibility: string
  }
  let pane: {
    mainAnchor: HTMLElement
    mainFrame: HTMLElement
    sidebarContainer: HTMLElement
    sidebarNative: readonly HTMLElement[]
    sidebarResizer: HTMLElement | undefined
    titlebarSlot: HTMLElement
    titlebarNative: readonly HTMLElement[]
    titlebarPosition: string
    provenance: string
    titlebarProvenance: 'native' | 'split' | 'rail-only' | 'settings'
    titlebarLease: ManagerTitlebarLease | undefined
    titlebarSafeLeft: number
    titlebarSafeRight: number
    titlebarStyle: string
    mainPosition: string
    sidebarPosition: string
    sidebarWidth: string
    sidebarFlexBasis: string
    sidebarLayout: HTMLElement | undefined
    sidebarLayoutWidth: string
    sidebarLayoutFlexBasis: string
    width: number
    maximumWidth: number
    navigationLeft: string
    navigationRight: string
    navigationWidth: string
    rootLeft: string
    rootWidth: string
    native: NativeState[]
    nativeTitle: NativeState[]
    selected: Array<{ button: HTMLButtonElement; current: string | null; dataSelected: string | null }>
  } | undefined
  let endResize: ((event?: PointerEvent) => void) | undefined
  const persistedWidth = (() => {
    try {
      const value = Number(view?.localStorage.getItem(SIDEBAR_WIDTH_KEY))
      return Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH
        ? value
        : undefined
    } catch {
      return undefined
    }
  })()
  let preferredWidth = persistedWidth
  const saveWidth = (width: number) => {
    preferredWidth = width
    try {
      view?.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
    } catch {
      // A restricted renderer may disable local storage; the open pane remains resizable.
    }
  }
  const setSidebarWidth = (width: number) => {
    const current = pane
    if (current === undefined) return
    const next = Math.round(Math.min(current.maximumWidth, Math.max(MIN_SIDEBAR_WIDTH, width)))
    current.width = next
    resizeHandle.setAttribute('aria-valuenow', String(next))
    if (current.provenance === 'codex-26.924-rail-only') {
      navigationSeat.style.width = `${next}px`
      rootSeat.style.left = `${next}px`
      rootSeat.style.width = `calc(100% - ${next}px)`
    } else {
      current.sidebarContainer.style.width = `${next}px`
      current.sidebarContainer.style.flexBasis = `${next}px`
      if (current.sidebarLayout !== undefined) {
        const railWidth = current.sidebarContainer.getBoundingClientRect().left
        current.sidebarLayout.style.width = `${railWidth + next}px`
        current.sidebarLayout.style.flexBasis = `${railWidth + next}px`
      }
    }
    const anchorRect = current.mainAnchor.getBoundingClientRect()
    const sidebarLeft = current.provenance === 'codex-26.924-rail-only'
      ? anchorRect.left
      : current.sidebarContainer.getBoundingClientRect().left
    resizeHandle.style.left = `${sidebarLeft + next}px`
    resizeHandle.style.top = `${anchorRect.top}px`
    resizeHandle.style.height = `${anchorRect.height}px`
    if (current.titlebarProvenance !== 'rail-only') {
      const titleRect = current.titlebarSlot.getBoundingClientRect()
      const desiredLeft = Math.max(current.titlebarSafeLeft, anchorRect.left)
      Object.assign(titlebarSeat.style, {
        position: 'absolute',
        top: '0px',
        bottom: 'auto',
        left: `${desiredLeft - titleRect.left}px`,
        right: 'auto',
        width: `${Math.max(0, Math.min(current.titlebarSafeRight, titleRect.right) - desiredLeft)}px`,
        height: `${titleRect.height}px`,
      })
    }
  }
  const stopResize = () => {
    endResize?.()
    endResize = undefined
  }
  const onViewportResize = () => {
    const current = pane
    if (current === undefined) return
    const mainRect = current.mainAnchor.getBoundingClientRect()
    const availableWidth = current.provenance === 'codex-26.924-rail-only'
      ? mainRect.width
      : current.sidebarContainer.getBoundingClientRect().width + mainRect.width
    current.maximumWidth = maximumManagerSidebarWidth({
      availableWidth,
      currentWidth: current.width,
      mainLeft: mainRect.left,
      ...(current.titlebarProvenance === 'rail-only' ? {} : { titlebarSafeRight: current.titlebarSafeRight }),
    })
    resizeHandle.setAttribute('aria-valuemax', String(current.maximumWidth))
    setSidebarWidth(current.width)
  }
  view?.addEventListener('resize', onViewportResize)
  resizeHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pane === undefined || view === null) return
    event.preventDefault()
    event.stopPropagation()
    stopResize()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = pane.width
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (next: PointerEvent) => {
      if (next.pointerId === pointerId) setSidebarWidth(startWidth + next.clientX - startX)
    }
    const finish = (next?: PointerEvent) => {
      if (next !== undefined && next.pointerId !== pointerId) return
      if (endResize !== finish) return
      endResize = undefined
      view.removeEventListener('pointermove', move)
      view.removeEventListener('pointerup', finish)
      view.removeEventListener('pointercancel', finish)
      view.removeEventListener('blur', onBlur)
      resizeHandle.removeEventListener('lostpointercapture', finish)
      try {
        if (resizeHandle.hasPointerCapture?.(pointerId)) resizeHandle.releasePointerCapture(pointerId)
      } catch {
        // The native pointer may already have left this renderer.
      }
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      if (next?.type === 'pointerup' && pane !== undefined) saveWidth(pane.width)
      else if (pane !== undefined) setSidebarWidth(startWidth)
    }
    const onBlur = () => finish()
    endResize = finish
    view.addEventListener('pointermove', move)
    view.addEventListener('pointerup', finish)
    view.addEventListener('pointercancel', finish)
    view.addEventListener('blur', onBlur)
    resizeHandle.addEventListener('lostpointercapture', finish)
    try {
      resizeHandle.setPointerCapture?.(pointerId)
    } catch {
      // Window listeners retain the drag when pointer capture is unavailable.
    }
  })
  resizeHandle.addEventListener('keydown', event => {
    if (pane === undefined) return
    const step = event.shiftKey ? 32 : 8
    const next = event.key === 'ArrowLeft'
      ? pane.width - step
      : event.key === 'ArrowRight'
      ? pane.width + step
      : event.key === 'Home'
      ? MIN_SIDEBAR_WIDTH
      : event.key === 'End'
      ? pane.maximumWidth
      : undefined
    if (next === undefined) return
    event.preventDefault()
    setSidebarWidth(next)
    saveWidth(pane.width)
  })
  let paneLossHandler: (() => void) | undefined
  const deactivatePane = () => {
    const current = pane
    if (current === undefined) return
    stopResize()
    pane = undefined
    if (current.titlebarLease !== undefined) releaseManagerTitlebarLease(current.titlebarLease)
    current.sidebarContainer.style.width = current.sidebarWidth
    current.sidebarContainer.style.flexBasis = current.sidebarFlexBasis
    if (current.sidebarLayout !== undefined) {
      current.sidebarLayout.style.width = current.sidebarLayoutWidth
      current.sidebarLayout.style.flexBasis = current.sidebarLayoutFlexBasis
    }
    for (const { node, ariaHidden, inert, visibility } of current.native) {
      node.inert = inert
      node.style.visibility = visibility
      if (ariaHidden === null) node.removeAttribute('aria-hidden')
      else node.setAttribute('aria-hidden', ariaHidden)
    }
    for (const { node, ariaHidden, inert, visibility } of current.nativeTitle) {
      node.inert = inert
      node.style.visibility = visibility
      if (ariaHidden === null) node.removeAttribute('aria-hidden')
      else node.setAttribute('aria-hidden', ariaHidden)
    }
    current.mainAnchor.style.position = current.mainPosition
    current.sidebarContainer.style.position = current.sidebarPosition
    current.titlebarSlot.style.position = current.titlebarPosition
    titlebarSeat.setAttribute('style', current.titlebarStyle)
    navigationSeat.style.left = current.navigationLeft
    navigationSeat.style.right = current.navigationRight
    navigationSeat.style.width = current.navigationWidth
    rootSeat.style.left = current.rootLeft
    rootSeat.style.width = current.rootWidth
    for (const { button, current: value, dataSelected } of current.selected) {
      if (!button.isConnected) continue
      if (value !== null && !button.hasAttribute('aria-current')) button.setAttribute('aria-current', value)
      if (dataSelected !== null && !button.hasAttribute('data-selected')) {
        button.setAttribute('data-selected', dataSelected)
      }
    }
    navigationSeat.remove()
    resizeHandle.remove()
    titlebarSeat.remove()
    rootSeat.dataset.managerSurface = 'modal'
    ;(document.body ?? document.documentElement).append(rootSeat)
  }
  const resolveTitlebar = (seat: NonNullable<ReturnType<typeof resolveManagerPaneSeat>>) => {
    if (seat.provenance === 'codex-26.924-rail-only') {
      const railOnly = resolveManagerRailOnlyTitlebarSeat(document)
      return railOnly === undefined ? undefined : {
        slot: railOnly.anchor,
        native: [railOnly.nativeTitle],
        provenance: 'rail-only' as const,
        bounds: railOnly.bounds,
        lease: undefined,
      }
    }
    if (pane !== undefined) {
      const lease = pane.titlebarLease
      if (lease === undefined) return undefined
      const continued = resolveManagerTitlebarContinuation(document, lease, {
        titlebarSeat,
        navigationSeat,
        contentSeat: rootSeat,
        resizeHandle,
        sidebarWidth: pane.width,
      })
      return continued === undefined ? undefined : { ...continued, lease }
    }
    const lease = captureManagerTitlebarLease(document, 'native', seat)
      ?? captureManagerTitlebarLease(document, 'split', seat)
      ?? captureManagerTitlebarLease(document, 'settings', seat)
    return lease === undefined ? undefined : { ...lease.seat, lease }
  }
  const placeTitlebarSeat = (titlebar: NonNullable<ReturnType<typeof resolveTitlebar>>) => {
    const slotRect = titlebar.slot.getBoundingClientRect()
    Object.assign(titlebarSeat.style, {
      position: 'absolute',
      left: `${titlebar.bounds.left - slotRect.left}px`,
      top: `${titlebar.bounds.top - slotRect.top}px`,
      width: `${titlebar.bounds.width}px`,
      height: `${titlebar.bounds.height}px`,
      right: 'auto',
      bottom: 'auto',
    })
    if (pane?.titlebarSlot === titlebar.slot) pane.titlebarSafeRight = titlebar.bounds.left + titlebar.bounds.width
  }
  const activatePane = () => {
    const seat = resolveManagerPaneSeat(document)
    if (seat === undefined || !railItem.isConnected) return false
    const titlebar = resolveTitlebar(seat)
    if (titlebar === undefined) return false
    const current = pane
    if (
      current?.mainAnchor === seat.main.anchor && current.mainFrame === seat.main.frame
      && current.sidebarContainer === seat.sidebar.container
      && current.provenance === seat.provenance
      && current.sidebarNative.length === seat.sidebar.native.length
      && current.sidebarNative.every((node, index) => node === seat.sidebar.native[index])
      && current.sidebarResizer === (seat.provenance === 'codex-26.924-native-two-pane'
          ? seat.sidebar.resizer
          : undefined)
      && current.titlebarProvenance === titlebar.provenance
      && current.titlebarSlot === titlebar.slot
      && current.titlebarNative.length === titlebar.native.length
      && current.titlebarNative.every((node, index) => node === titlebar.native[index])
    ) {
      placeTitlebarSeat(titlebar)
      return true
    }
    deactivatePane()
    const selected = [
      ...seat.rail.querySelectorAll<HTMLButtonElement>('button[aria-current],button[data-selected]'),
    ]
      .filter(button => !triggerSeat.contains(button))
      .map(button => ({
        button,
        current: button.getAttribute('aria-current'),
        dataSelected: button.getAttribute('data-selected'),
      }))
    const sidebarResizer = seat.provenance === 'codex-26.924-native-two-pane'
      ? seat.sidebar.resizer
      : undefined
    const native = [seat.main.frame, ...seat.sidebar.native, ...(sidebarResizer === undefined ? [] : [sidebarResizer])]
      .map(node => ({
        node,
        ariaHidden: node.getAttribute('aria-hidden'),
        inert: node.inert,
        visibility: node.style.visibility,
      }))
    const nativeTitle = titlebar.native.map(node => ({
      node,
      ariaHidden: node.getAttribute('aria-hidden'),
      inert: node.inert,
      visibility: node.style.visibility,
    }))
    const sidebarLayout = seat.provenance === 'codex-26.924-native-two-pane'
      ? seat.sidebar.container.closest<HTMLElement>('aside[data-app-shell-left-panel-appearance]') ?? undefined
      : undefined
    const initialWidth = seat.provenance === 'codex-26.924-rail-only'
      ? seat.sidebar.width
      : seat.geometry.sidebarRight - seat.geometry.sidebarLeft
    const mainRect = seat.main.anchor.getBoundingClientRect()
    const availableWidth = seat.provenance === 'codex-26.924-rail-only'
      ? mainRect.width
      : initialWidth + mainRect.width
    const maximumWidth = maximumManagerSidebarWidth({
      availableWidth,
      currentWidth: initialWidth,
      mainLeft: mainRect.left,
      ...(titlebar.provenance === 'rail-only'
        ? {}
        : { titlebarSafeRight: titlebar.bounds.left + titlebar.bounds.width }),
    })
    pane = {
      mainAnchor: seat.main.anchor,
      mainFrame: seat.main.frame,
      sidebarContainer: seat.sidebar.container,
      sidebarNative: seat.sidebar.native,
      sidebarResizer,
      titlebarSlot: titlebar.slot,
      titlebarNative: titlebar.native,
      titlebarPosition: titlebar.slot.style.position,
      provenance: seat.provenance,
      titlebarProvenance: titlebar.provenance,
      titlebarLease: titlebar.lease,
      titlebarSafeLeft: titlebar.bounds.left,
      titlebarSafeRight: titlebar.bounds.left + titlebar.bounds.width,
      titlebarStyle: titlebarSeat.getAttribute('style') ?? '',
      mainPosition: seat.main.anchor.style.position,
      sidebarPosition: seat.sidebar.container.style.position,
      sidebarWidth: seat.sidebar.container.style.width,
      sidebarFlexBasis: seat.sidebar.container.style.flexBasis,
      sidebarLayout,
      sidebarLayoutWidth: sidebarLayout?.style.width ?? '',
      sidebarLayoutFlexBasis: sidebarLayout?.style.flexBasis ?? '',
      width: initialWidth,
      maximumWidth,
      navigationLeft: navigationSeat.style.left,
      navigationRight: navigationSeat.style.right,
      navigationWidth: navigationSeat.style.width,
      rootLeft: rootSeat.style.left,
      rootWidth: rootSeat.style.width,
      native,
      nativeTitle,
      selected,
    }
    seat.main.anchor.style.position = 'relative'
    seat.sidebar.container.style.position = 'relative'
    if (titlebar.provenance === 'native') titlebar.slot.style.position = 'relative'
    if (seat.provenance === 'codex-26.924-rail-only') {
      navigationSeat.style.left = `${seat.sidebar.left}px`
      navigationSeat.style.right = 'auto'
      navigationSeat.style.width = `${seat.sidebar.width}px`
      rootSeat.style.left = seat.sidebar.inMain ? `${seat.sidebar.width}px` : '0'
      rootSeat.style.width = seat.sidebar.inMain ? `calc(100% - ${seat.sidebar.width}px)` : '100%'
    }
    resizeHandle.setAttribute('aria-valuemin', String(MIN_SIDEBAR_WIDTH))
    resizeHandle.setAttribute('aria-valuemax', String(maximumWidth))
    resizeHandle.setAttribute('aria-valuenow', String(initialWidth))
    ;(document.body ?? document.documentElement).append(resizeHandle)
    setSidebarWidth(preferredWidth ?? initialWidth)
    for (const { node } of native) {
      node.inert = true
      node.style.visibility = 'hidden'
      node.setAttribute('aria-hidden', 'true')
    }
    for (const { node } of nativeTitle) {
      node.inert = true
      node.style.visibility = 'hidden'
      node.setAttribute('aria-hidden', 'true')
    }
    for (const { button } of selected) {
      button.removeAttribute('aria-current')
      button.removeAttribute('data-selected')
    }
    rootSeat.dataset.managerSurface = 'pane'
    seat.main.anchor.append(rootSeat)
    seat.sidebar.container.append(navigationSeat)
    placeTitlebarSeat(titlebar)
    titlebar.slot.append(titlebarSeat)
    return true
  }
  const root = createRoot(rootSeat)
  // The Manager trigger is part of the Host bootstrap contract. Commit the
  // initial tree before returning so callers never observe a half-installed
  // renderer (and tests do not need renderer-specific timing workarounds).
  flushSync(() =>
    root.render(
      <ManagerApp
        model={model}
        marketplace={marketplace.model}
        {...(options.pluginManagement === undefined ? {} : { pluginManagement: options.pluginManagement })}
        {...(options.nativeRouteHistory === undefined ? {} : { nativeRouteHistory: options.nativeRouteHistory })}
        presentationMode={presentationMode}
        setWorkspaceVisible={visible => {
          rootSeat.hidden = !visible
        }}
        triggerSeat={triggerSeat}
        navigationSeat={navigationSeat}
        titlebarSeat={titlebarSeat}
        {...(options.legacyModal === true ? {} : { activatePane })}
        deactivatePane={deactivatePane}
        registerPaneLoss={handler => {
          paneLossHandler = handler
        }}
        {...(options.navigationController === undefined ? {} : { navigationController: options.navigationController })}
      />,
    )
  )

  let currentTarget: HTMLElement | undefined
  let scheduled = false
  const reconcile = () => {
    scheduled = false
    if (pane !== undefined) {
      const seat = resolveManagerPaneSeat(document)
      const titlebar = seat === undefined ? undefined : resolveTitlebar(seat)
      if (
        seat?.main.anchor !== pane.mainAnchor || seat.main.frame !== pane.mainFrame
        || seat.sidebar.container !== pane.sidebarContainer
        || seat.provenance !== pane.provenance
        || seat.sidebar.native.length !== pane.sidebarNative.length
        || pane.sidebarNative.some((node, index) => node !== seat.sidebar.native[index])
        || pane.sidebarResizer !== (seat.provenance === 'codex-26.924-native-two-pane'
            ? seat.sidebar.resizer
            : undefined)
        || titlebar?.provenance !== pane.titlebarProvenance
        || titlebar?.slot !== pane.titlebarSlot
        || titlebar.native.length !== pane.titlebarNative.length
        || pane.titlebarNative.some((node, index) => node !== titlebar.native[index])
      ) {
        deactivatePane()
        paneLossHandler?.()
      } else if (titlebar !== undefined) {
        placeTitlebarSeat(titlebar)
      }
    }
    const rail = resolveManagerRailSeat(document)
    if (rail !== undefined) {
      if (railItem.parentElement !== rail.container || railItem.nextElementSibling !== rail.before) {
        rail.container.insertBefore(railItem, rail.before)
      }
      if (triggerSeat.parentElement !== railItem) railItem.append(triggerSeat)
      currentTarget = undefined
      return
    }
    railItem.remove()
    const target = options.triggerTarget?.() ?? resolveManagerTriggerTarget(document)
    if (target === undefined) {
      triggerSeat.remove()
      currentTarget = undefined
      return
    }
    if (target === currentTarget && triggerSeat.isConnected && triggerSeat.previousElementSibling === target) return
    target.after(triggerSeat)
    currentTarget = target
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const Observer = document.defaultView?.MutationObserver
  const observer = Observer === undefined ? undefined : new Observer(schedule)
  observer?.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-app-shell-main-content-layout',
      'data-app-shell-thread-edge-divider',
      'data-app-shell-main-content-top-fade',
      'data-app-shell-focus-area',
      'data-app-navigation-rail',
      'data-sidebar-destination',
      'data-app-shell-titlebar',
      'data-app-shell-main-titlebar',
      'data-app-shell-titlebar-slot',
      'data-app-shell-header-slot',
      'role',
    ],
  })
  view?.addEventListener('resize', schedule)
  reconcile()

  return () => {
    view?.removeEventListener('resize', schedule)
    observer?.disconnect()
    view?.removeEventListener('resize', onViewportResize)
    root.unmount()
    deactivatePane()
    marketplace.dispose()
    detachTriggerTheme()
    detachNavigationTheme()
    detachTitlebarTheme()
    detachRootTheme()
    theme.dispose()
    triggerSeat.remove()
    railItem.remove()
    rootSeat.remove()
    resizeHandle.remove()
    style.remove()
    if (installedAnimationFrameFallback && view !== null) {
      Reflect.deleteProperty(view, 'requestAnimationFrame')
      Reflect.deleteProperty(view, 'cancelAnimationFrame')
    }
  }
}
