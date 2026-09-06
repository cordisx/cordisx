import * as React from 'react'
import { createPortal } from 'react-dom'
import type { HoverCardProps } from '../../ui.js'
import { HostThemeProjection } from '../host-theme.js'

const HOVER_CARD_DELAY = Object.freeze({ open: 400, close: 120 })
const VIEWPORT_EDGE = 8
const CARD_GAP = 8

type TriggerElementProps = React.HTMLAttributes<HTMLElement> & React.RefAttributes<HTMLElement>

function contains(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (container === null) return false
  const NodeConstructor = container?.ownerDocument.defaultView?.Node
  return NodeConstructor !== undefined && target instanceof NodeConstructor && container.contains(target)
}

function assignRef(ref: React.Ref<HTMLElement> | undefined, value: HTMLElement | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref !== null && ref !== undefined) ref.current = value
}

export function HoverCard({
  trigger,
  content,
  placement = 'top',
  className,
  style,
  'aria-describedby': describedBy,
  ...props
}: HoverCardProps): React.ReactElement {
  if (!React.isValidElement<TriggerElementProps>(trigger)) {
    throw new TypeError('HoverCard trigger must be one React element')
  }
  const generatedId = React.useId()
  const cardId = `cxr-hover-card-${generatedId.replaceAll(':', '')}`
  const triggerRef = React.useRef<HTMLSpanElement>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerType = React.useRef<string | undefined>(undefined)
  const pinned = React.useRef(false)
  const [open, setOpen] = React.useState(false)
  const triggerProps = trigger.props

  const clearOpenTimer = React.useCallback(() => {
    if (openTimer.current !== undefined) clearTimeout(openTimer.current)
    openTimer.current = undefined
  }, [])
  const clearCloseTimer = React.useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])
  const openNow = React.useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer, clearOpenTimer])
  const closeNow = React.useCallback((restoreFocus = false) => {
    clearOpenTimer()
    clearCloseTimer()
    pinned.current = false
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [clearCloseTimer, clearOpenTimer])
  const scheduleOpen = () => {
    clearCloseTimer()
    clearOpenTimer()
    openTimer.current = setTimeout(openNow, HOVER_CARD_DELAY.open)
  }
  const scheduleClose = () => {
    clearOpenTimer()
    if (pinned.current) return
    clearCloseTimer()
    closeTimer.current = setTimeout(() => closeNow(), HOVER_CARD_DELAY.close)
  }

  React.useEffect(() => () => {
    clearOpenTimer()
    clearCloseTimer()
  }, [clearCloseTimer, clearOpenTimer])

  React.useLayoutEffect(() => {
    if (!open) return
    const triggerElement = triggerRef.current
    const card = cardRef.current
    const document = triggerElement?.ownerDocument
    const view = document?.defaultView
    if (triggerElement === null || card === null || document === undefined || view == null) return
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(card)
    const position = () => {
      const triggerRect = triggerElement.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      const viewportWidth = view.innerWidth || document.documentElement.clientWidth
      const viewportHeight = view.innerHeight || document.documentElement.clientHeight
      const topFits = triggerRect.top - cardRect.height - CARD_GAP >= VIEWPORT_EDGE
      const bottomFits = triggerRect.bottom + cardRect.height + CARD_GAP <= viewportHeight - VIEWPORT_EDGE
      const side = placement === 'top'
        ? (topFits || !bottomFits ? 'top' : 'bottom')
        : (bottomFits || !topFits ? 'bottom' : 'top')
      const desiredLeft = triggerRect.left + (triggerRect.width - cardRect.width) / 2
      const maximumLeft = Math.max(VIEWPORT_EDGE, viewportWidth - cardRect.width - VIEWPORT_EDGE)
      const left = Math.min(Math.max(VIEWPORT_EDGE, desiredLeft), maximumLeft)
      const desiredTop = side === 'top'
        ? triggerRect.top - cardRect.height - CARD_GAP
        : triggerRect.bottom + CARD_GAP
      const maximumTop = Math.max(VIEWPORT_EDGE, viewportHeight - cardRect.height - VIEWPORT_EDGE)
      card.dataset.side = side
      card.style.left = `${Math.round(left * 2) / 2}px`
      card.style.top = `${Math.round(Math.min(Math.max(VIEWPORT_EDGE, desiredTop), maximumTop) * 2) / 2}px`
      card.style.visibility = 'visible'
    }
    position()
    const ResizeObserverConstructor = view.ResizeObserver
    const observer = ResizeObserverConstructor === undefined ? undefined : new ResizeObserverConstructor(position)
    observer?.observe(triggerElement)
    observer?.observe(card)
    view.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeNow(true)
    }
    const outsidePointer = (event: PointerEvent) => {
      if (contains(triggerElement, event.target) || contains(card, event.target)) return
      closeNow()
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', outsidePointer, true)
    return () => {
      observer?.disconnect()
      view.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('pointerdown', outsidePointer, true)
      detachTheme()
      theme.dispose()
    }
  }, [closeNow, open, placement])

  const description = [triggerProps['aria-describedby'], describedBy, open ? cardId : undefined]
    .filter(Boolean)
    .join(' ') || undefined
  const portalRoot = triggerRef.current?.ownerDocument.body
  const card = open && portalRoot != null
    ? createPortal(
      <div
        ref={cardRef}
        id={cardId}
        className="cxr-ui-hover-card__content"
        role="tooltip"
        data-side={placement}
        onClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onPointerEnter={event => {
          event.stopPropagation()
          clearCloseTimer()
        }}
        onPointerLeave={event => {
          event.stopPropagation()
          scheduleClose()
        }}
      >
        {content}
      </div>,
      portalRoot,
    )
    : null

  const enhancedTrigger = React.cloneElement(trigger, {
    ...props,
    ref: (element: HTMLElement | null) => {
      triggerRef.current = element
      assignRef(triggerProps.ref, element)
    },
    className: [triggerProps.className, 'cxr-ui-hover-card__trigger', className].filter(Boolean).join(' '),
    style: { ...triggerProps.style, ...style },
    tabIndex: triggerProps.tabIndex ?? 0,
    'aria-describedby': description,
    onPointerDown: event => {
      triggerProps.onPointerDown?.(event)
      if (!event.defaultPrevented) pointerType.current = event.pointerType
    },
    onPointerEnter: event => {
      triggerProps.onPointerEnter?.(event)
      if (!event.defaultPrevented) scheduleOpen()
    },
    onPointerLeave: event => {
      triggerProps.onPointerLeave?.(event)
      if (!event.defaultPrevented) scheduleClose()
    },
    onFocus: event => {
      triggerProps.onFocus?.(event)
      if (!event.defaultPrevented) openNow()
    },
    onBlur: event => {
      triggerProps.onBlur?.(event)
      if (!event.defaultPrevented && !contains(cardRef.current, event.relatedTarget)) scheduleClose()
    },
    onClick: event => {
      triggerProps.onClick?.(event)
      if (event.defaultPrevented) return
      const coarse = pointerType.current === 'touch' || pointerType.current === 'pen'
        || event.detail === 0
        || event.currentTarget.ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches === true
      if (!coarse) return
      if (open && pinned.current) closeNow()
      else {
        pinned.current = true
        openNow()
      }
    },
    onKeyDown: event => {
      triggerProps.onKeyDown?.(event)
      if (event.defaultPrevented || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeNow(true)
    },
  })

  return <>{enhancedTrigger}{card}</>
}
