import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'

export interface HostConversationRightInspectorProps {
  readonly open: boolean
  readonly title: string
  readonly closeLabel: string
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

/**
 * One Host-owned inspector shell for room members/settings/actions and Agent identity.
 * CSS container queries switch the same DOM between a split pane and a modal drawer.
 */
export function HostConversationRightInspector({
  open,
  title,
  closeLabel,
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
  const [drawer, setDrawer] = React.useState(true)
  const titleId = labelledBy ?? generatedTitleId

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

  React.useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (panel === null) return
    returnFocusRef.current = panel.ownerDocument.activeElement instanceof panel.ownerDocument.defaultView!.HTMLElement
      ? panel.ownerDocument.activeElement
      : null
    focusable(panel)[0]?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); return }
      if (!drawer || event.key !== 'Tab') return
      const items = focusable(panel)
      if (items.length === 0) { event.preventDefault(); panel.focus(); return }
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && panel.ownerDocument.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && panel.ownerDocument.activeElement === last) { event.preventDefault(); first.focus() }
    }
    panel.ownerDocument.addEventListener('keydown', onKeyDown, true)
    return () => {
      panel.ownerDocument.removeEventListener('keydown', onKeyDown, true)
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target?.isConnected) target.focus()
    }
  }, [drawer, onOpenChange, open])

  if (!open) return null
  return <div
    className="cx-conversation-inspector-layer"
    data-host-conversation-inspector="true"
    data-host-conversation-inspector-mode={drawer ? 'drawer' : 'split'}
  >
    <button
      type="button"
      className="cx-conversation-inspector-scrim"
      aria-label={closeLabel}
      tabIndex={-1}
      onClick={() => onOpenChange(false)}
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
      <header className="cx-conversation-inspector-header">
        {leading === undefined ? null : <span className="cx-conversation-inspector-leading">{leading}</span>}
        <h2 id={titleId} className="cx-conversation-inspector-title">{title}</h2>
        {actions === undefined ? null : <span className="cx-conversation-inspector-actions">{actions}</span>}
        <button type="button" className="cx-conversation-inspector-icon-action" aria-label={closeLabel} onClick={() => onOpenChange(false)}><HostSurfaceIcon token="host:close" /></button>
      </header>
      <div className="cx-conversation-inspector-body">{children}</div>
    </aside>
  </div>
}
