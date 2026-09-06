import * as React from 'react'
import type { HorizontalSplitPaneProps } from '../../ui.js'

const KEYBOARD_STEP = 8
const KEYBOARD_LARGE_STEP = 32
const SEPARATOR_SIZE = 9

function assertSize(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`)
  }
}

function constrainedSize(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(Math.max(value, minimum), maximum))
}

export function HorizontalSplitPane({
  left,
  right,
  initialLeftSize,
  minLeftSize,
  maxLeftSize,
  separatorLabel,
  className,
  style,
  ...props
}: HorizontalSplitPaneProps): React.ReactElement {
  assertSize('initialLeftSize', initialLeftSize)
  assertSize('minLeftSize', minLeftSize)
  if (maxLeftSize !== undefined) {
    assertSize('maxLeftSize', maxLeftSize)
    if (maxLeftSize < minLeftSize) throw new RangeError('maxLeftSize must be greater than or equal to minLeftSize')
  }

  const configuredMaximum = maxLeftSize ?? Number.MAX_SAFE_INTEGER
  const root = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<
    { readonly pointerId: number; readonly startX: number; readonly startSize: number } | undefined
  >(undefined)
  const [availableMaximum, setAvailableMaximum] = React.useState(configuredMaximum)
  const [leftSize, setLeftSizeState] = React.useState(() =>
    constrainedSize(initialLeftSize, minLeftSize, configuredMaximum)
  )
  const leftSizeRef = React.useRef(leftSize)
  const effectiveMaximum = Math.max(minLeftSize, Math.min(configuredMaximum, availableMaximum))

  const setLeftSize = React.useCallback((next: number) => {
    const value = constrainedSize(next, minLeftSize, effectiveMaximum)
    leftSizeRef.current = value
    setLeftSizeState(value)
  }, [effectiveMaximum, minLeftSize])

  React.useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      const nextMaximum = Math.max(minLeftSize, width - SEPARATOR_SIZE)
      setAvailableMaximum(nextMaximum)
    }
    measure()
    const ResizeObserverConstructor = element.ownerDocument.defaultView?.ResizeObserver
    const observer = ResizeObserverConstructor === undefined ? undefined : new ResizeObserverConstructor(measure)
    observer?.observe(element)
    const view = element.ownerDocument.defaultView
    view?.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      view?.removeEventListener('resize', measure)
    }
  }, [minLeftSize])

  React.useLayoutEffect(() => {
    setLeftSize(leftSizeRef.current)
  }, [setLeftSize])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startSize: leftSizeRef.current }
  }
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    setLeftSize(active.startSize + event.clientX - active.startX)
  }
  const finishPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = leftSizeRef.current - step
    if (event.key === 'ArrowRight') next = leftSizeRef.current + step
    if (event.key === 'Home') next = minLeftSize
    if (event.key === 'End') next = effectiveMaximum
    if (next === undefined) return
    event.preventDefault()
    setLeftSize(next)
  }

  return (
    <div
      {...props}
      ref={root}
      className={['cxr-ui-horizontal-split-pane', className].filter(Boolean).join(' ')}
      style={{ ...style, gridTemplateColumns: `${leftSize}px ${SEPARATOR_SIZE}px minmax(0,1fr)` }}
    >
      <div className="cxr-ui-horizontal-split-pane__pane" data-pane="left">{left}</div>
      <div
        className="cxr-ui-horizontal-split-pane__separator"
        role="separator"
        aria-label={separatorLabel}
        aria-orientation="vertical"
        aria-valuemin={minLeftSize}
        aria-valuemax={effectiveMaximum}
        aria-valuenow={leftSize}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onLostPointerCapture={finishPointer}
      />
      <div className="cxr-ui-horizontal-split-pane__pane" data-pane="right">{right}</div>
    </div>
  )
}
