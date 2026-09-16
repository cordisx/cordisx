import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { HostDialogProps } from '../../ui.js'
import { HostThemeProjection } from '../host-theme.js'

export const HOST_DIALOG_STYLES = `
.cxhd-backdrop{position:fixed;z-index:2147483605;inset:0;display:grid;place-items:center;padding:16px;background:rgb(0 0 0 / 46%)}
.cxhd-dialog{width:min(460px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 32px));overflow:auto;border:1px solid var(--cx-border);border-radius:10px;padding:18px;background:var(--cx-surface-raised,var(--cx-surface));color:var(--cx-text);box-shadow:0 18px 54px var(--cx-shadow,rgb(0 0 0 / 36%));outline:0}
.cxhd-dialog[data-width="small"]{width:min(380px,calc(100vw - 32px))}.cxhd-dialog[data-width="medium"]{width:min(520px,calc(100vw - 32px))}
.cxhd-dialog[data-tone="danger"]{border-color:color-mix(in srgb,var(--cx-danger) 45%,var(--cx-border))}
.cxhd-title{margin:0;color:var(--cx-text);font:inherit;font-size:16px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
.cxhd-description{margin:8px 0 0;color:var(--cx-muted);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.cxhd-body{margin-top:16px;min-width:0;overflow-wrap:anywhere}.cxhd-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}
.cxhd-button{appearance:none;display:inline-flex;min-height:34px;align-items:center;justify-content:center;border:1px solid var(--cx-border);border-radius:8px;padding:6px 13px;background:var(--cx-surface);color:var(--cx-text);font:inherit;font-weight:600;cursor:pointer}
.cxhd-button[data-variant="primary"]{border-color:transparent;background:var(--cx-primary);color:var(--cx-primary-text)}.cxhd-button:focus-visible{outline:2px solid var(--cx-focus);outline-offset:2px}.cxhd-button:disabled{cursor:not-allowed;opacity:var(--cx-disabled,.5)}
@media(max-width:480px){.cxhd-backdrop{align-items:end;padding:12px}.cxhd-dialog{width:100%;max-height:calc(100vh - 24px);padding:16px}}
`

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
  )].filter(element => {
    for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
      if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false
      const style = current.ownerDocument.defaultView?.getComputedStyle(current)
      if (style?.display === 'none' || style?.visibility === 'hidden') return false
      if (current === root) break
    }
    return true
  })
}

export function HostDialog({
  open,
  title,
  description,
  children,
  actions,
  tone = 'neutral',
  width = 'small',
  initialFocusRef,
  returnFocusRef,
  closeOnBackdrop = true,
  onClose,
  className,
  ...props
}: HostDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const fallbackReturnFocus = useRef<HTMLElement | null>(null)
  const titleId = `cxhd-title-${useId().replace(/:/g, '')}`
  const descriptionId = `${titleId}-description`

  useEffect(() => {
    if (!open || dialogRef.current === null) return
    const dialog = dialogRef.current
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(dialog)
    let cancelled = false
    fallbackReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    queueMicrotask(() => {
      if (cancelled || !dialog.isConnected) return
      const preferred = initialFocusRef?.current
      const available = focusable(dialog)
      ;(preferred?.isConnected === true && available.includes(preferred) ? preferred : available[0] ?? dialog).focus({
        preventScroll: true,
      })
    })
    return () => {
      cancelled = true
      detachTheme()
      theme.dispose()
      const target = returnFocusRef?.current ?? fallbackReturnFocus.current
      if (target?.isConnected === true) queueMicrotask(() => target.focus({ preventScroll: true }))
      fallbackReturnFocus.current = null
    }
  }, [initialFocusRef, open, returnFocusRef])

  if (!open) return null
  return createPortal(
    <div
      className="cxhd-backdrop"
      onPointerDown={event => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose('backdrop')
      }}
    >
      <style>{HOST_DIALOG_STYLES}</style>
      <div
        {...props}
        ref={dialogRef}
        className={['cxhd-dialog', className].filter(Boolean).join(' ')}
        data-tone={tone}
        data-width={width}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        onKeyDown={event => {
          props.onKeyDown?.(event)
          if (event.defaultPrevented) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose('escape')
            return
          }
          if (event.key !== 'Tab') return
          const items = focusable(event.currentTarget)
          if (items.length === 0) {
            event.preventDefault()
            event.currentTarget.focus()
            return
          }
          const current = items.indexOf(document.activeElement as HTMLElement)
          const next = event.shiftKey
            ? (current <= 0 ? items.at(-1) : items[current - 1])
            : (current < 0 || current === items.length - 1 ? items[0] : items[current + 1])
          event.preventDefault()
          next?.focus()
        }}
      >
        <h2 className="cxhd-title" id={titleId}>{title}</h2>
        {description === undefined ? null : <p className="cxhd-description" id={descriptionId}>{description}</p>}
        {children === undefined ? null : <div className="cxhd-body">{children}</div>}
        {actions === undefined ? null : <div className="cxhd-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

export const HostDialogAction = forwardRef<
  HTMLButtonElement,
  {
    readonly variant?: 'primary' | 'secondary'
  } & ButtonHTMLAttributes<HTMLButtonElement>
>(function HostDialogAction(
  { variant = 'secondary', className, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      className={['cxhd-button', className].filter(Boolean).join(' ')}
      data-variant={variant}
    />
  )
})
