import { type KeyboardEvent, type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HostThemeProjection } from '../host-theme.js'

export type HostMenuItem =
  | { readonly kind: 'heading'; readonly id: string; readonly label: string }
  | { readonly kind: 'separator'; readonly id: string }
  | { readonly kind: 'status'; readonly id: string; readonly label: string; readonly value?: string }
  | {
    readonly kind: 'action'
    readonly id: string
    readonly label: string
    readonly selected?: boolean
    readonly disabled?: boolean
    readonly onSelect: () => void
  }

export interface HostMenuProps {
  readonly label: string
  readonly className?: string
  readonly icon: ReactNode
  readonly copy?: ReactNode
  readonly items: readonly HostMenuItem[]
  readonly footer?: ReactNode
}

function enabledItems(root: HTMLElement | null): HTMLButtonElement[] {
  return root === null ? [] : [...root.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
}

export interface HostMenuSurfaceProps {
  readonly open: boolean
  readonly label: string
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly returnFocusRef?: RefObject<HTMLElement | null>
  readonly align?: 'start' | 'end'
  readonly className?: string
  readonly children: ReactNode
  readonly onClose: () => void
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly canFocus?: () => boolean
}

/** Internal composable menu surface for Host controls with custom row content. */
export function HostMenuSurface({
  open,
  label,
  anchorRef,
  returnFocusRef,
  align = 'start',
  className,
  children,
  onClose,
  onKeyDown,
  canFocus,
}: HostMenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const focusAllowed = useRef(canFocus)
  const initialFocusRequested = useRef(false)
  const placement = useRef<'above' | 'below' | undefined>(undefined)
  const openGeneration = useRef(0)
  const previouslyOpen = useRef(false)
  focusAllowed.current = canFocus
  const menuId = `cxhm-${useId().replace(/:/g, '')}`

  if (open && !previouslyOpen.current) openGeneration.current += 1
  previouslyOpen.current = open

  if (!open) {
    initialFocusRequested.current = false
    placement.current = undefined
  }

  useLayoutEffect(() => {
    if (!open || menuRef.current === null || anchorRef.current === null) return
    const menu = menuRef.current
    const anchor = anchorRef.current
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(menu)
    let positionFrame: number | undefined
    const position = () => {
      const edge = 8
      const gap = 6
      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const preferredLeft = align === 'end' ? anchorRect.right - menuRect.width : anchorRect.left
      const left = Math.min(Math.max(edge, preferredLeft), Math.max(edge, window.innerWidth - menuRect.width - edge))
      const availableAbove = Math.max(0, anchorRect.top - gap - edge)
      const availableBelow = Math.max(0, window.innerHeight - edge - anchorRect.bottom - gap)
      placement.current ??= menuRect.height <= availableAbove
          || (menuRect.height > availableBelow && availableAbove >= availableBelow)
        ? 'above'
        : 'below'
      const placeAbove = placement.current === 'above'
      const availableHeight = placeAbove ? availableAbove : availableBelow
      menu.style.setProperty('--cxhm-available-height', `${Math.floor(availableHeight)}px`)
      const top = placeAbove ? anchorRect.top - gap : anchorRect.bottom + gap
      menu.style.left = `${Math.round(left)}px`
      menu.style.top = `${Math.round(top)}px`
      menu.style.transform = placeAbove ? 'translateY(-100%)' : 'none'
    }
    const schedulePosition = () => {
      if (positionFrame !== undefined) return
      if (typeof window.requestAnimationFrame !== 'function') {
        position()
        return
      }
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = undefined
        position()
      })
    }
    const reposition = () => {
      placement.current = undefined
      schedulePosition()
    }
    position()
    if (!initialFocusRequested.current && (canFocus?.() ?? true) && !menu.contains(document.activeElement)) {
      initialFocusRequested.current = true
      ;(menu.querySelector<HTMLElement>('[data-menu-initial="true"]:not(:disabled)') ?? enabledItems(menu)[0] ?? menu)
        .focus()
    }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || menu.contains(target) || anchor.contains(target)) return
      onClose()
    }
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', outside, true)
    const ResizeObserver = document.defaultView?.ResizeObserver
    const resizeObserver = ResizeObserver === undefined ? undefined : new ResizeObserver(schedulePosition)
    resizeObserver?.observe(menu)
    resizeObserver?.observe(anchor)
    return () => {
      if (positionFrame !== undefined) window.cancelAnimationFrame?.(positionFrame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
      document.removeEventListener('pointerdown', outside, true)
      detachTheme()
      theme.dispose()
    }
  })

  if (!open) return null
  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      className={['cxhm-menu', className].filter(Boolean).join(' ')}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={event => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          const target = returnFocusRef?.current
          const closingGeneration = openGeneration.current
          onClose()
          const restoreFocus = () => {
            if (
              openGeneration.current === closingGeneration && target?.isConnected && returnFocusRef?.current === target
              && anchorRef.current?.isConnected
              && (focusAllowed.current?.() ?? true)
            ) {
              target.focus({ preventScroll: true })
            }
          }
          queueMicrotask(restoreFocus)
          // Native Composer restores its own focus after the portal disappears.
          // Restore the invoking control after that layout commit as well.
          window.requestAnimationFrame?.(restoreFocus)
          return
        }
        if (
          event.target instanceof Element
          && event.target.closest('input,textarea,select,[role="slider"],[contenteditable="true"]')
        ) return
        const buttons = enabledItems(menuRef.current)
        if (buttons.length === 0) return
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown'
          ? buttons[(index + 1 + buttons.length) % buttons.length]
          : event.key === 'ArrowUp'
          ? buttons[(index - 1 + buttons.length) % buttons.length]
          : event.key === 'Home'
          ? buttons[0]
          : event.key === 'End'
          ? buttons.at(-1)
          : undefined
        if (next !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          next.focus()
        }
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Host portal menu with the same focus, keyboard and clipping policy as Host collections. */
export function HostMenu({ label, className, icon, copy, items, footer }: HostMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  return (
    <span ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (
            event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight'
            && event.key !== 'ArrowRight' && event.key !== 'ArrowRight'
          ) return
          event.preventDefault()
          setOpen(true)
          queueMicrotask(() => {
            const menu = document.querySelector<HTMLElement>('.cxhm-menu')
            const buttons = enabledItems(menu)
            ;(event.key === 'ArrowUp' ? buttons.at(-1) : buttons[0])?.focus()
          })
        }}
      >
        {icon}
        {copy}
      </button>
      <HostMenuSurface
        open={open}
        label={label}
        anchorRef={anchorRef}
        returnFocusRef={triggerRef}
        onClose={() => close(false)}
      >
        {items.map(item =>
          item.kind === 'separator'
            ? <div key={item.id} className="cxhm-separator" role="separator" />
            : item.kind === 'heading'
            ? <div key={item.id} className="cxhm-heading" role="presentation">{item.label}</div>
            : item.kind === 'status'
            ? (
              <div key={item.id} className="cxhm-status" role="presentation">
                <span>{item.label}</span>
                {item.value === undefined ? null : <strong>{item.value}</strong>}
              </div>
            )
            : (
              <button
                key={item.id}
                type="button"
                className="cxhm-item"
                role={item.selected === undefined ? 'menuitem' : 'menuitemradio'}
                {...(item.selected === undefined ? {} : { 'aria-checked': item.selected })}
                disabled={item.disabled}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                <span className="cxhm-check" aria-hidden="true">{item.selected === true ? '✓' : ''}</span>
                <span>{item.label}</span>
              </button>
            )
        )}
        {footer === undefined ? null : <div className="cxhm-footer" role="presentation">{footer}</div>}
      </HostMenuSurface>
    </span>
  )
}
