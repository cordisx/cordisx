import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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

/** Host portal menu with the same focus, keyboard and clipping policy as Host collections. */
export function HostMenu({ label, className, icon, copy, items, footer }: HostMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = `cxhm-${useId().replace(/:/g, '')}`

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (trigger === null || menu === null) return
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(menu)
    const position = () => {
      const edge = 8
      const gap = 6
      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const left = Math.min(Math.max(edge, triggerRect.left), Math.max(edge, window.innerWidth - menuRect.width - edge))
      const above = triggerRect.top - menuRect.height - gap
      const top = above >= edge
        ? above
        : Math.min(window.innerHeight - menuRect.height - edge, triggerRect.bottom + gap)
      menu.style.left = `${Math.round(left)}px`
      menu.style.top = `${Math.max(edge, Math.round(top))}px`
    }
    position()
    enabledItems(menu)[0]?.focus()
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      detachTheme()
      theme.dispose()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return
      close(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const buttons = enabledItems(menuRef.current)
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? buttons[(index + 1 + buttons.length) % buttons.length]
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
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
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={label}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
          queueMicrotask(() => {
            const buttons = enabledItems(menuRef.current)
            ;(event.key === 'ArrowUp' ? buttons.at(-1) : buttons[0])?.focus()
          })
        }}
      >
        {icon}
        {copy}
      </button>
      {open
        ? createPortal(
          <div ref={menuRef} id={menuId} className="cxhm-menu" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
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
          </div>,
          document.body,
        )
        : null}
    </>
  )
}
