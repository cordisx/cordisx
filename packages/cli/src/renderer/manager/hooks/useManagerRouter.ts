import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ManagerRoute, ManagerRouter } from '../model/routes.js'

const PLAYGROUND_ROUTE_KEY = 'cordisx.playground.manager.history.v1'

function initialHistory(storage?: Storage): readonly ManagerRoute[] {
  if (storage === undefined) return [{ kind: 'primary', page: 'plugins' }]
  try {
    const value = JSON.parse(storage.getItem(PLAYGROUND_ROUTE_KEY) ?? 'null')
    return Array.isArray(value) && value.length > 0 ? value as readonly ManagerRoute[] : [{ kind: 'primary', page: 'plugins' }]
  } catch { return [{ kind: 'primary', page: 'plugins' }] }
}

export function useManagerRouter(storage?: Storage): ManagerRouter {
  const [history, setHistory] = useState<readonly ManagerRoute[]>(() => initialHistory(storage))
  const route = history.at(-1) ?? { kind: 'primary' as const, page: 'plugins' as const }
  useEffect(() => { storage?.setItem(PLAYGROUND_ROUTE_KEY, JSON.stringify(history)) }, [history, storage])
  const navigate = useCallback((next: ManagerRoute) => {
    setHistory(current => [...current, next])
  }, [])
  const back = useCallback(() => {
    setHistory(current => current.length > 1 ? current.slice(0, -1) : current)
  }, [])
  return useMemo(() => ({ route, navigate, back }), [back, navigate, route])
}
