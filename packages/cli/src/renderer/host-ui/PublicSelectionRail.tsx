import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface PublicSelectionRailOption {
  readonly value: string
  readonly label: ReactNode
  readonly description?: ReactNode
  readonly disabled?: boolean
  readonly controls?: string
}

export interface PublicSelectionRailProps {
  readonly className?: string
  readonly 'aria-label': string
  readonly value: string
  readonly options: readonly PublicSelectionRailOption[]
  readonly onChange: (value: string) => void
  readonly layout?: 'responsive' | 'vertical' | 'horizontal'
}

const NARROW_MEDIA_QUERY = '(max-width: 640px)'

function joinClassName(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value !== '').join(' ')
}

function useNarrowLayout(enabled: boolean): boolean {
  const [narrow, setNarrow] = useState(() => enabled && (window.matchMedia?.(NARROW_MEDIA_QUERY).matches ?? false))
  useEffect(() => {
    if (!enabled) {
      setNarrow(false)
      return
    }
    const media = window.matchMedia?.(NARROW_MEDIA_QUERY)
    if (media === undefined) return
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [enabled])
  return narrow
}

/** Public Host-owned selection rail for related document sections. */
export function PublicSelectionRail({
  className,
  'aria-label': ariaLabel,
  value,
  options,
  onChange,
  layout = 'responsive',
}: PublicSelectionRailProps) {
  const narrow = useNarrowLayout(layout === 'responsive')
  const orientation = layout === 'horizontal' || narrow ? 'horizontal' : 'vertical'
  const elements = useRef(new Map<string, HTMLButtonElement>())
  const enabled = options.filter(option => option.disabled !== true)
  const tabbableValue = enabled.some(option => option.value === value) ? value : enabled[0]?.value
  const move = (event: KeyboardEvent<HTMLButtonElement>, optionValue: string): void => {
    const current = enabled.findIndex(option => option.value === optionValue)
    if (current < 0 || enabled.length === 0) return
    const delta = orientation === 'vertical'
      ? event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : undefined
      : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : undefined
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? enabled.length - 1
        : delta === undefined ? undefined : (current + delta + enabled.length) % enabled.length
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const option = enabled[next]
    if (option === undefined) return
    onChange(option.value)
    queueMicrotask(() => elements.current.get(option.value)?.focus({ preventScroll: true }))
  }
  return <div
    className={joinClassName('cxr-ui-selection-rail', className)}
    role="tablist"
    aria-label={ariaLabel}
    aria-orientation={orientation}
    data-layout={orientation}
  >
    {options.map(option => <button
      ref={element => { if (element === null) elements.current.delete(option.value); else elements.current.set(option.value, element) }}
      key={option.value}
      type="button"
      className="cxr-ui-selection-rail-item"
      role="tab"
      aria-selected={option.value === value}
      aria-controls={option.controls}
      tabIndex={option.value === tabbableValue ? 0 : -1}
      disabled={option.disabled}
      onClick={() => onChange(option.value)}
      onKeyDown={event => move(event, option.value)}
    >
      <span className="cxr-ui-selection-rail-label">{option.label}</span>
      {option.description === undefined ? null : <span className="cxr-ui-selection-rail-description">{option.description}</span>}
    </button>)}
  </div>
}
