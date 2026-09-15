import { type CSSProperties, useEffect, useRef, useState } from 'react'

export function ProviderReasoningSlider({ efforts, value, disabled, pending, label, labelFor, commit }: {
  readonly efforts: readonly string[]
  readonly value: string | undefined
  readonly disabled: boolean
  readonly pending: boolean
  readonly label: string
  readonly labelFor: (effort?: string) => string
  readonly commit: (effort: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<string>()
  const dragging = useRef(false)
  const draftRef = useRef<string | undefined>(undefined)
  const committing = useRef(false)
  const displayed = draft ?? value ?? ''
  const index = Math.max(0, efforts.indexOf(displayed))
  const maximum = Math.max(0, efforts.length - 1)
  const progress = maximum === 0 ? 0 : index / maximum * 100
  useEffect(() => {
    setDraft(undefined)
    draftRef.current = undefined
  }, [value, disabled])
  const submit = () => {
    dragging.current = false
    const next = draftRef.current
    draftRef.current = undefined
    if (!disabled && !committing.current && next !== undefined && next !== value) {
      committing.current = true
      void commit(next).finally(() => {
        committing.current = false
        setDraft(undefined)
      })
    } else setDraft(undefined)
  }
  return (
    <label className="cxmp-reasoning">
      <span>
        {label}
        <output>{labelFor(draft ?? value)}</output>
      </span>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={labelFor(displayed)}
        aria-busy={pending}
        aria-disabled={disabled || pending}
        data-menu-initial="true"
        min={0}
        max={maximum}
        step={1}
        value={index}
        style={{ '--cxmp-reasoning-progress': `${progress}%` } as CSSProperties}
        disabled={disabled || efforts.length < 2 || !efforts.includes(value ?? '')}
        onPointerDown={event => {
          if (pending) {
            event.preventDefault()
            return
          }
          dragging.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onInput={event => {
          if (pending) return
          const next = efforts[Number(event.currentTarget.value)]
          draftRef.current = next
          setDraft(next)
        }}
        onChange={event => {
          if (pending) return
          const next = efforts[Number(event.currentTarget.value)]
          draftRef.current = next
          setDraft(next)
          if (!dragging.current) submit()
        }}
        onPointerUp={submit}
        onKeyUp={submit}
        onPointerCancel={() => {
          dragging.current = false
          draftRef.current = undefined
          setDraft(undefined)
        }}
        onBlur={submit}
        onKeyDown={event => {
          // Range arrow/Home/End behavior must never enter menu roving focus.
          if (
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
          ) {
            event.stopPropagation()
            if (pending) event.preventDefault()
          }
        }}
      />
    </label>
  )
}
