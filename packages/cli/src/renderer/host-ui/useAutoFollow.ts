import { type RefObject, type UIEventHandler, useLayoutEffect, useRef } from 'react'

const BOTTOM_THRESHOLD = 8

/** Bottom-follow is automatic: scrolling away suspends it; returning resumes it. */
export function useAutoFollow<T extends HTMLElement>(dependency: unknown): {
  readonly ref: RefObject<T | null>
  readonly onScroll: UIEventHandler<T>
} {
  const ref = useRef<T>(null)
  const follows = useRef(true)
  const onScroll: UIEventHandler<T> = event => {
    const target = event.currentTarget
    follows.current = target.scrollHeight - target.clientHeight - target.scrollTop <= BOTTOM_THRESHOLD
  }
  useLayoutEffect(() => {
    const target = ref.current
    if (target !== null && follows.current) target.scrollTop = target.scrollHeight
  }, [dependency])
  return { ref, onScroll }
}
