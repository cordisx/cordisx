import { type CSSProperties, useEffect, useRef, useState } from 'react'

const clamp = (value: number) => Math.max(0, Math.min(1, value))

export function ProviderReasoningSlider({ efforts, value, disabled, pending, fast, label, labelFor, commit }: {
  readonly efforts: readonly string[]
  readonly value: string | undefined
  readonly disabled: boolean
  readonly pending: boolean
  readonly fast: boolean
  readonly label: string
  readonly labelFor: (effort?: string) => string
  readonly commit: (effort: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<string>()
  const [dragProgress, setDragProgress] = useState<number>()
  const [flowing, setFlowing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const flow = useRef<HTMLSpanElement>(null)
  const pointerId = useRef<number | undefined>(undefined)
  const draftRef = useRef<string | undefined>(undefined)
  const committing = useRef(false)
  const displayed = draft ?? value ?? ''
  const index = Math.max(0, efforts.indexOf(displayed))
  const maximum = Math.max(0, efforts.length - 1)
  const progress = maximum === 0 ? 0 : index / maximum
  const visualProgress = dragProgress ?? progress
  const thumbOffset = 12 - visualProgress * 24
  const thumbX = `calc(${visualProgress * 100}% + ${thumbOffset}px)`
  const fillX = visualProgress === 1 ? '100%' : `calc(${thumbX} + 12px)`
  const activeMark = maximum === 0 ? 0 : Math.floor(visualProgress * maximum)
  const unavailable = disabled || efforts.length < 2 || !efforts.includes(value ?? '')
  const hot = !unavailable && !pending && (fast || index === maximum)
  const effortsKey = efforts.join('\0')

  useEffect(() => {
    setDraft(undefined)
    setDragProgress(undefined)
    draftRef.current = undefined
  }, [value, disabled, effortsKey])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const particles = new Set<HTMLElement>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const clearParticles = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      for (const particle of particles) {
        for (const animation of particle.getAnimations?.() ?? []) animation.cancel()
        particle.remove()
      }
      particles.clear()
    }
    const spawn = () => {
      timer = undefined
      const container = flow.current
      if (disposed || !hot || media?.matches || document.hidden || container === null) return
      if (particles.size < 14) {
        const particle = document.createElement('span')
        particle.className = 'cxmp-reasoning-particle'
        const height = 2 + Math.random() * 2
        const width = height * (1.1 + Math.random() * 2.5)
        const drift = (Math.random() - 0.5) * 6
        const opacity = 0.28 + Math.random() * 0.5
        Object.assign(particle.style, {
          height: `${height}px`,
          width: `${width}px`,
          top: `${3 + Math.random() * 17}px`,
        })
        container.append(particle)
        if (typeof particle.animate === 'function') {
          particles.add(particle)
          const travel = container.clientWidth + width + 24
          const animation = particle.animate([
            { transform: 'translate(0, 0)', opacity: 0 },
            { offset: 0.12, transform: `translate(${travel * 0.12}px, ${drift * 0.25}px)`, opacity },
            { offset: 0.85, transform: `translate(${travel * 0.85}px, ${drift}px)`, opacity },
            { transform: `translate(${travel}px, ${drift * 1.2}px)`, opacity: 0 },
          ], { duration: 1100 + Math.random() * 1700, easing: 'linear' })
          animation.onfinish = () => {
            particle.remove()
            particles.delete(particle)
          }
        } else particle.remove()
      }
      timer = setTimeout(spawn, 90 + Math.random() * 260)
    }
    const refresh = () => {
      const shouldFlow = hot && media?.matches !== true && !document.hidden
      setFlowing(shouldFlow)
      if (!shouldFlow) clearParticles()
      else if (timer === undefined) spawn()
    }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    media?.addEventListener('change', refresh)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', refresh)
      media?.removeEventListener('change', refresh)
      clearParticles()
    }
  }, [hot])

  const updateDraft = (nextIndex: number) => {
    const next = efforts[Math.max(0, Math.min(maximum, nextIndex))]
    draftRef.current = next
    setDraft(next)
  }
  const pointerProgress = (element: HTMLElement, clientX: number) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 24 ? clamp((clientX - rect.left - 12) / (rect.width - 24)) : undefined
  }
  const updatePointer = (element: HTMLElement, clientX: number) => {
    const nextProgress = pointerProgress(element, clientX)
    if (nextProgress === undefined) return
    setDragProgress(nextProgress)
    updateDraft(Math.round(nextProgress * maximum))
  }
  const submit = (next = draftRef.current) => {
    pointerId.current = undefined
    setDragProgress(undefined)
    draftRef.current = undefined
    if (!disabled && !pending && !committing.current && next !== undefined && next !== value) {
      committing.current = true
      void commit(next).finally(() => {
        committing.current = false
        setDraft(undefined)
      })
    } else setDraft(undefined)
  }
  return (
    <div
      className="cxmp-reasoning"
      data-dragging={dragProgress === undefined ? undefined : 'true'}
      data-disabled={unavailable || undefined}
      data-hot={hot || undefined}
      data-flowing={flowing || undefined}
      data-progress={visualProgress.toFixed(4)}
      style={{
        '--cxmp-reasoning-fill-x': fillX,
        '--cxmp-reasoning-thumb-x': thumbX,
      } as CSSProperties}
      onPointerDown={event => {
        if (unavailable || pending || event.button !== 0 || pointerId.current !== undefined) return
        pointerId.current = event.pointerId
        event.currentTarget.setPointerCapture?.(event.pointerId)
        input.current?.focus({ preventScroll: true })
        updatePointer(event.currentTarget, event.clientX)
      }}
      onPointerMove={event => {
        if (event.pointerId === pointerId.current) updatePointer(event.currentTarget, event.clientX)
      }}
      onPointerUp={event => {
        if (event.pointerId !== pointerId.current) return
        const nextProgress = pointerProgress(event.currentTarget, event.clientX)
        if (nextProgress !== undefined) {
          setDragProgress(nextProgress)
          const next = efforts[Math.round(nextProgress * maximum)]
          draftRef.current = next
          setDraft(next)
          submit(next)
        } else submit()
      }}
      onPointerCancel={event => {
        if (event.pointerId !== pointerId.current) return
        pointerId.current = undefined
        setDragProgress(undefined)
        draftRef.current = undefined
        setDraft(undefined)
      }}
    >
      <span className="cxmp-reasoning-rail" aria-hidden="true">
        <span className="cxmp-reasoning-fill" />
        <span ref={flow} className="cxmp-reasoning-flow" />
      </span>
      <span className="cxmp-reasoning-marks" aria-hidden="true">
        {efforts.map((effort, effortIndex) => (
          <span
            key={effort}
            data-active={effortIndex <= activeMark || undefined}
          />
        ))}
      </span>
      <input
        ref={input}
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
        disabled={unavailable}
        onInput={event => {
          if (pending) return
          updateDraft(Number(event.currentTarget.value))
        }}
        onChange={event => {
          if (pending) return
          updateDraft(Number(event.currentTarget.value))
          if (pointerId.current === undefined) submit(efforts[Number(event.currentTarget.value)])
        }}
        onKeyUp={() => submit()}
        onBlur={() => submit()}
        onKeyDown={event => {
          if (
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
          ) {
            event.stopPropagation()
            if (pending) event.preventDefault()
          }
        }}
      />
      <span className="cxmp-reasoning-thumb" aria-hidden="true" />
    </div>
  )
}
