import { useCallback, useEffect, useMemo, useState } from 'react'
import { type ManagerRoute, normalizeManagerHistory, normalizeManagerRoute } from '../model/routes.js'

const PLAYGROUND_ROUTE_KEY = 'cordisx.playground.manager.history.v1'

function initialHistory(storage?: Storage): readonly ManagerRoute[] {
  if (storage === undefined) return [{ kind: 'primary', page: 'plugins' }]
  try {
    const value = JSON.parse(storage.getItem(PLAYGROUND_ROUTE_KEY) ?? 'null')
    return Array.isArray(value) && value.length > 0
      ? normalizeManagerHistory(value as readonly ManagerRoute[])
      : [{ kind: 'primary', page: 'plugins' }]
  } catch {
    return [{ kind: 'primary', page: 'plugins' }]
  }
}

export function useManagerRouter(storage?: Storage) {
  const [history, setHistory] = useState<readonly ManagerRoute[]>(() => initialHistory(storage))
  const route = history.at(-1) ?? { kind: 'primary' as const, page: 'plugins' as const }
  useEffect(() => {
    storage?.setItem(PLAYGROUND_ROUTE_KEY, JSON.stringify(history))
  }, [history, storage])
  const navigate = useCallback((next: ManagerRoute) => {
    const normalized = normalizeManagerRoute(next)
    setHistory(current =>
      JSON.stringify(current.at(-1)) === JSON.stringify(normalized) ? current : [...current, normalized]
    )
  }, [])
  const replace = useCallback((next: ManagerRoute) => {
    const normalized = normalizeManagerRoute(next)
    setHistory(current => current.length === 0 ? [normalized] : [...current.slice(0, -1), normalized])
  }, [])
  const openDetail = useCallback((root: ManagerRoute, detail: ManagerRoute) => {
    setHistory(normalizeManagerHistory([root, detail]))
  }, [])
  const back = useCallback(() => {
    setHistory(current => current.length > 1 ? current.slice(0, -1) : current)
  }, [])
  const capture = useCallback(() => history, [history])
  const restore = useCallback((next: readonly ManagerRoute[]) => {
    setHistory(normalizeManagerHistory(next))
  }, [])
  return useMemo(
    () => ({ route, navigate, replace, openDetail, back, capture, restore }),
    [back, capture, navigate, openDetail, replace, restore, route],
  )
}
