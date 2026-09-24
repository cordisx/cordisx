import { useEffect, useRef, useState } from 'react'

const INITIAL_MODEL_ROWS = 48
const MODEL_ROW_BATCH = 48

export function useProgressiveModelRows(total: number, resetKey: string) {
  const [limit, setLimit] = useState(INITIAL_MODEL_ROWS)
  const sentinel = useRef<HTMLLIElement>(null)

  useEffect(() => {
    setLimit(INITIAL_MODEL_ROWS)
  }, [resetKey])

  useEffect(() => {
    const node = sentinel.current
    const Observer = node?.ownerDocument.defaultView?.IntersectionObserver
    if (!node || !Observer || limit >= total) return
    const observer = new Observer(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setLimit(current => Math.min(total, current + MODEL_ROW_BATCH))
      }
    }, { rootMargin: '240px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [limit, total])

  return {
    limit,
    sentinel: limit < total ? sentinel : undefined,
  }
}
