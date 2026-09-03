import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'

export interface HostConversationRightInspectorProps {
  readonly open: boolean
  readonly title: string
  readonly closeLabel: string
  readonly resizeLabel?: string
  readonly width: number
  readonly onWidthChange: (width: number) => void
  /** Stable logical page key. Changing it moves focus into the newly rendered inspector page without replacing the shell. */
  readonly pageKey?: string
  readonly breadcrumb?: Readonly<{
    readonly parentLabel: string
    readonly backLabel: string
    readonly navigationLabel?: string
    readonly onBack: () => void
  }>
  readonly labelledBy?: string
  readonly describedBy?: string
  readonly leading?: React.ReactNode
  readonly actions?: React.ReactNode
  readonly children: React.ReactNode
  readonly onOpenChange: (open: boolean) => void
}

function focusable(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"]),input:not([disabled]),textarea:not([disabled])')]
    .filter(item => item.getAttribute('aria-hidden') !== 'true' && !item.hasAttribute('inert'))
}

function initialFocusable(panel: HTMLElement): HTMLElement | undefined {
  const items = focusable(panel)
  return items.find(item => item.dataset.hostInspectorPrimaryFocus === 'true')
    ?? items.find(item => item.getAttribute('role') !== 'separator')
    ?? items[0]
}

const DEFAULT_INSPECTOR_WIDTH = 360
const MINIMUM_INSPECTOR_WIDTH = 300
const MAXIMUM_INSPECTOR_WIDTH = 640

/**
 * One Host-owned inspector shell for room members/settings/actions and Agent identity.
 * CSS container queries switch the same DOM between a split pane and a modal drawer.
 */
export function HostConversationRightInspector({
  open,
  title,
  closeLabel,
  resizeLabel = 'Resize inspector',
  width,
  onWidthChange,
  pageKey,
  breadcrumb,
  labelledBy,
  describedBy,
  leading,
  actions,
  children,
  onOpenChange,
}: HostConversationRightInspectorProps) {
  const generatedTitleId = React.useId()
  const panelRef = React.useRef<HTMLElement>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const resizeCleanupRef = React.useRef<() => void>(() => {})
  const pageKeyRef = React.useRef(pageKey)
  const onOpenChangeRef = React.useRef(onOpenChange)
  const onWidthChangeRef = React.useRef(onWidthChange)
  const [drawer, setDrawer] = React.useState(true)
  const titleId = labelledBy ?? generatedTitleId
  const renderedWidth = Number.isFinite(width) ? width : DEFAULT_INSPECTOR_WIDTH

  React.useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  React.useLayoutEffect(() => {
    onWidthChangeRef.current = onWidthChange
  }, [onWidthChange])

  React.useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const root = panel?.closest<HTMLElement>('.cxa-root')
    if (panel === null || panel === undefined) return
    const update = (): void => {
      const width = root?.getBoundingClientRect().width ?? 0
      if (width > 0) setDrawer(width < 900)
    }
    update()
    const Observer = panel.ownerDocument.defaultView?.ResizeObserver
    if (Observer === undefined || root === null || root === undefined) return
    const observer = new Observer(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [open])

  React.useLayoutEffect(() => {
    if (!open) {
      pageKeyRef.current = pageKey
      return
    }
    if (pageKeyRef.current === pageKey) return
    pageKeyRef.current = pageKey
    const panel = panelRef.current
    if (panel === null) return
    initialFocusable(panel)?.focus()
  }, [open, pageKey])

  React.useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (panel === null) return
    returnFocusRef.current = panel.ownerDocument.activeElement instanceof panel.ownerDocument.defaultView!.HTMLElement
      ? panel.ownerDocument.activeElement
      : null
    initialFocusable(panel)?.focus()
    return () => {
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target?.isConnected) target.focus()
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (panel === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChangeRef.current(false); return }
      if (!drawer || event.key !== 'Tab') return
      const items = focusable(panel)
      if (items.length === 0) { event.preventDefault(); panel.focus(); return }
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && panel.ownerDocument.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && panel.ownerDocument.activeElement === last) { event.preventDefault(); first.focus() }
    }
    panel.ownerDocument.addEventListener('keydown', onKeyDown, true)
    return () => panel.ownerDocument.removeEventListener('keydown', onKeyDown, true)
  }, [drawer, open])

  React.useEffect(() => {
    if (!open || drawer) resizeCleanupRef.current()
  }, [drawer, open])

  React.useEffect(() => () => resizeCleanupRef.current(), [])

  const close = React.useCallback(() => onOpenChangeRef.current(false), [])
  const clampWidth = React.useCallback((value: number): number => {
    const rootWidth = panelRef.current?.closest<HTMLElement>('.cxa-root')?.getBoundingClientRect().width ?? 0
    const maximum = rootWidth > 0
      ? Math.min(MAXIMUM_INSPECTOR_WIDTH, Math.max(320, rootWidth * 0.62))
      : MAXIMUM_INSPECTOR_WIDTH
    const finiteValue = Number.isFinite(value) ? value : DEFAULT_INSPECTOR_WIDTH
    return Math.round(Math.min(maximum, Math.max(MINIMUM_INSPECTOR_WIDTH, finiteValue)))
  }, [])
  const beginResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (drawer || event.button !== 0) return
    event.preventDefault()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? renderedWidth
    const view = panelRef.current?.ownerDocument.defaultView
    if (view === undefined || view === null) return
    resizeCleanupRef.current()
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      onWidthChangeRef.current(clampWidth(startWidth + startX - moveEvent.clientX))
    }
    const end = (endEvent?: PointerEvent): void => {
      if (endEvent !== undefined && endEvent.pointerId !== pointerId) return
      view.removeEventListener('pointermove', move)
      view.removeEventListener('pointerup', end)
      view.removeEventListener('pointercancel', end)
      if (resizeCleanupRef.current === end) resizeCleanupRef.current = () => {}
    }
    resizeCleanupRef.current = end
    view.addEventListener('pointermove', move)
    view.addEventListener('pointerup', end)
    view.addEventListener('pointercancel', end)
  }, [clampWidth, drawer, renderedWidth])

  if (!open) return null
  return <div
    className="cx-conversation-inspector-layer"
    data-host-conversation-inspector="true"
    data-host-conversation-inspector-mode={drawer ? 'drawer' : 'split'}
    {...(pageKey === undefined ? {} : { 'data-host-conversation-inspector-page': pageKey })}
    style={{ '--cxa-inspector-width': `${renderedWidth}px` } as React.CSSProperties}
  >
    <button
      type="button"
      className="cx-conversation-inspector-scrim"
      aria-label={closeLabel}
      tabIndex={-1}
      onClick={close}
    />
    <aside
      ref={panelRef}
      className="cx-conversation-inspector"
      role="dialog"
      aria-modal={drawer ? 'true' : 'false'}
      aria-labelledby={titleId}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      tabIndex={-1}
    >
      <div
        className="cx-conversation-inspector-resizer"
        role="separator"
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemin={MINIMUM_INSPECTOR_WIDTH}
        aria-valuemax={MAXIMUM_INSPECTOR_WIDTH}
        aria-valuenow={renderedWidth}
        tabIndex={drawer ? -1 : 0}
        onPointerDown={beginResize}
        onKeyDown={event => {
          if (drawer || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
          event.preventDefault()
          onWidthChangeRef.current(clampWidth(renderedWidth + (event.key === 'ArrowLeft' ? 24 : -24)))
        }}
      />
      <header className="cx-conversation-inspector-header">
        {breadcrumb === undefined ? <>
          {leading === undefined ? null : <span className="cx-conversation-inspector-leading">{leading}</span>}
          <h2 id={titleId} className="cx-conversation-inspector-title">{title}</h2>
          {actions === undefined ? null : <span className="cx-conversation-inspector-actions">{actions}</span>}
        </> : <>
          <button
            type="button"
            className="cx-conversation-inspector-icon-action cx-conversation-inspector-back-action"
            aria-label={breadcrumb.backLabel}
            onClick={breadcrumb.onBack}
          ><HostSurfaceIcon token="host:back" /></button>
          <nav className="cx-conversation-inspector-breadcrumb" aria-label={breadcrumb.navigationLabel}>
            <button
              type="button"
              className="cx-conversation-inspector-breadcrumb-parent"
              onClick={breadcrumb.onBack}
            >{breadcrumb.parentLabel}</button>
            <span className="cx-conversation-inspector-breadcrumb-separator" aria-hidden="true">/</span>
            <h2 id={titleId} className="cx-conversation-inspector-breadcrumb-current">{title}</h2>
          </nav>
        </>}
        <button type="button" className="cx-conversation-inspector-icon-action" aria-label={closeLabel} onClick={close}><HostSurfaceIcon token="host:close" /></button>
      </header>
      <div className="cx-conversation-inspector-body">{children}</div>
    </aside>
  </div>
}
