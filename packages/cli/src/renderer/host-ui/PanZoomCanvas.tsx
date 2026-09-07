import * as React from 'react'
import type { PanZoomCanvasHandle, PanZoomCanvasProps } from '../../ui.js'
import { HostIcon } from './HostIcon.js'

interface ViewTransform {
  readonly x: number
  readonly y: number
  readonly scale: number
}

interface PinchState {
  readonly distance: number
  readonly scale: number
  readonly midpoint: Readonly<{ x: number; y: number }>
  readonly transform: ViewTransform
}

interface PointerPoint {
  readonly clientX: number
  readonly clientY: number
}

interface DragOrigin {
  readonly x: number
  readonly y: number
  readonly transform: ViewTransform
  readonly active: boolean
}

const DEFAULT_MIN_SCALE = 0.25
const DEFAULT_MAX_SCALE = 2.5
const KEYBOARD_PAN_STEP = 48
const DRAG_THRESHOLD = 4
const WHEEL_ZOOM_LIMIT = 0.12

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function distance(first: PointerPoint, second: PointerPoint): number {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
}

function midpoint(first: PointerPoint, second: PointerPoint): Readonly<{ x: number; y: number }> {
  return { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 }
}

export function PanZoomCanvas({
  children,
  fill = false,
  minScale = DEFAULT_MIN_SCALE,
  maxScale = DEFAULT_MAX_SCALE,
  initialScale = 1,
  controls,
  controllerRef,
  onScaleChange,
  className,
  style,
  'aria-label': ariaLabel,
  ...props
}: PanZoomCanvasProps): React.ReactElement {
  const boundedMinimum = Math.max(0.05, minScale)
  const boundedMaximum = Math.max(boundedMinimum, maxScale)
  const boundedInitial = clamp(initialScale, boundedMinimum, boundedMaximum)
  const viewport = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const pointers = React.useRef(new Map<number, PointerPoint>())
  const dragOrigin = React.useRef<DragOrigin | undefined>(undefined)
  const pinch = React.useRef<PinchState | undefined>(undefined)
  const suppressClick = React.useRef(false)
  const transformRef = React.useRef<ViewTransform>({ x: 0, y: 0, scale: boundedInitial })
  const [transform, setTransformState] = React.useState<ViewTransform>(transformRef.current)
  const [dragging, setDragging] = React.useState(false)
  const instructionsId = React.useId()

  const publish = React.useCallback((next: ViewTransform) => {
    transformRef.current = next
    setTransformState(next)
    onScaleChange?.(next.scale)
  }, [onScaleChange])

  const scaleAround = React.useCallback((nextScale: number, clientX: number, clientY: number) => {
    const bounds = viewport.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const current = transformRef.current
    const scale = clamp(nextScale, boundedMinimum, boundedMaximum)
    if (scale === current.scale) return
    const pointX = clientX - bounds.left
    const pointY = clientY - bounds.top
    publish({
      scale,
      x: pointX - (pointX - current.x) * scale / current.scale,
      y: pointY - (pointY - current.y) * scale / current.scale,
    })
  }, [boundedMaximum, boundedMinimum, publish])

  const fitToView = React.useCallback(() => {
    const frame = viewport.current
    const body = content.current
    if (frame === null || body === null) return
    const availableWidth = frame.clientWidth
    const availableHeight = frame.clientHeight
    const contentWidth = body.scrollWidth
    const contentHeight = body.scrollHeight
    if (availableWidth <= 0 || availableHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) return
    const scale = clamp(
      Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
      boundedMinimum,
      boundedMaximum,
    )
    publish({
      scale,
      x: (availableWidth - contentWidth * scale) / 2,
      y: (availableHeight - contentHeight * scale) / 2,
    })
  }, [boundedMaximum, boundedMinimum, publish])

  const reset = React.useCallback(() => publish({ x: 0, y: 0, scale: boundedInitial }), [boundedInitial, publish])

  React.useImperativeHandle(controllerRef, () => ({
    getScale: () => transformRef.current.scale,
    fitToView,
    reset,
  }), [fitToView, reset])

  const updatePinch = (event: React.PointerEvent): void => {
    pointers.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
    const active = [...pointers.current.values()]
    if (active.length !== 2) return
    const [first, second] = active as [PointerPoint, PointerPoint]
    const nextMidpoint = midpoint(first, second)
    if (pinch.current === undefined) {
      pinch.current = {
        distance: Math.max(1, distance(first, second)),
        scale: transformRef.current.scale,
        midpoint: nextMidpoint,
        transform: transformRef.current,
      }
      return
    }
    const start = pinch.current
    const scale = clamp(start.scale * distance(first, second) / start.distance, boundedMinimum, boundedMaximum)
    const bounds = viewport.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const startX = start.midpoint.x - bounds.left
    const startY = start.midpoint.y - bounds.top
    const nextX = nextMidpoint.x - bounds.left
    const nextY = nextMidpoint.y - bounds.top
    publish({
      scale,
      x: nextX - (startX - start.transform.x) * scale / start.transform.scale,
      y: nextY - (startY - start.transform.y) * scale / start.transform.scale,
    })
  }

  const releasePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId)
    dragOrigin.current = undefined
    setDragging(false)
    if (pointers.current.size < 2) pinch.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      {...props}
      ref={viewport}
      className={['cxr-ui-pan-zoom-canvas', className].filter(Boolean).join(' ')}
      style={style}
      role="region"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-describedby={instructionsId}
      aria-keyshortcuts="+ - 0 ArrowUp ArrowDown ArrowLeft ArrowRight"
      data-scale={transform.scale.toFixed(3)}
      data-fill={fill}
      data-dragging={dragging}
      onWheel={event => {
        event.preventDefault()
        event.stopPropagation()
        const delta = clamp(-event.deltaY * 0.0015, -WHEEL_ZOOM_LIMIT, WHEEL_ZOOM_LIMIT)
        scaleAround(transformRef.current.scale * Math.exp(delta), event.clientX, event.clientY)
      }}
      onPointerDown={event => {
        if (event.button !== 0) return
        if ((event.target as Element).closest('button,a,input,select,textarea,[role="button"]') !== null) return
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        pointers.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
        if (pointers.current.size === 1) {
          dragOrigin.current = { x: event.clientX, y: event.clientY, transform: transformRef.current, active: false }
        } else {
          updatePinch(event)
        }
      }}
      onPointerMove={event => {
        if (!pointers.current.has(event.pointerId)) return
        pointers.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
        if (pointers.current.size === 2) {
          updatePinch(event)
          return
        }
        const origin = dragOrigin.current
        if (origin === undefined) return
        const offsetX = event.clientX - origin.x
        const offsetY = event.clientY - origin.y
        if (!origin.active && Math.hypot(offsetX, offsetY) < DRAG_THRESHOLD) return
        if (!origin.active) {
          dragOrigin.current = { ...origin, active: true }
          suppressClick.current = true
          setDragging(true)
        }
        publish({
          ...origin.transform,
          x: origin.transform.x + offsetX,
          y: origin.transform.y + offsetY,
        })
      }}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onClickCapture={event => {
        if (!suppressClick.current) return
        suppressClick.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragStart={event => event.preventDefault()}
      onKeyDown={event => {
        const frame = viewport.current?.getBoundingClientRect()
        if (frame === undefined) return
        if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          scaleAround(transformRef.current.scale * 1.15, frame.left + frame.width / 2, frame.top + frame.height / 2)
        } else if (event.key === '-') {
          event.preventDefault()
          scaleAround(transformRef.current.scale / 1.15, frame.left + frame.width / 2, frame.top + frame.height / 2)
        } else if (event.key === '0') {
          event.preventDefault()
          fitToView()
        } else if (event.key.startsWith('Arrow')) {
          event.preventDefault()
          const x = event.key === 'ArrowLeft'
            ? transformRef.current.x - KEYBOARD_PAN_STEP
            : event.key === 'ArrowRight'
            ? transformRef.current.x + KEYBOARD_PAN_STEP
            : transformRef.current.x
          const y = event.key === 'ArrowUp'
            ? transformRef.current.y - KEYBOARD_PAN_STEP
            : event.key === 'ArrowDown'
            ? transformRef.current.y + KEYBOARD_PAN_STEP
            : transformRef.current.y
          publish({ ...transformRef.current, x, y })
        }
      }}
    >
      <span id={instructionsId} className="cxr-ui-visually-hidden">
        Drag to pan. Use the mouse wheel or plus and minus keys to zoom. Press zero to fit the content.
      </span>
      <div
        ref={content}
        className="cxr-ui-pan-zoom-canvas__content"
        style={{ transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})` }}
      >
        {children}
      </div>
      {controls === undefined
        ? null
        : (
          <div className="cxr-ui-action-toolbar cxr-ui-pan-zoom-canvas__controls" role="toolbar">
            <button
              type="button"
              className="cxr-ui-icon-action"
              disabled={controls.disabled}
              aria-label={controls.fitLabel}
              title={controls.fitLabel}
              onClick={() => {
                fitToView()
                controls.onFit?.()
              }}
            >
              <HostCanvasIcon token="host:fit" label={controls.fitLabel} />
            </button>
            <button
              type="button"
              className="cxr-ui-icon-action"
              disabled={controls.disabled}
              aria-label={controls.resetLabel}
              title={controls.resetLabel}
              onClick={() => {
                reset()
                controls.onReset?.()
              }}
            >
              <HostCanvasIcon token="host:reset" label={controls.resetLabel} />
            </button>
          </div>
        )}
    </div>
  )
}

function HostCanvasIcon({ token, label }: { readonly token: 'host:fit' | 'host:reset'; readonly label: string }) {
  return <HostIcon token={label} surfaceToken={token} className="cxr-ui-canvas-control-icon" size={16} />
}
