import type { NativeRouteSnapshot, NativeRouteSource } from '../manager/native-route-transition.js'

interface DataRouterLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly key: string
}

interface DataRouter {
  readonly state: { readonly location: DataRouterLocation }
  subscribe(listener: () => void): () => void
}

interface ReactFiberLike {
  readonly child?: ReactFiberLike | null
  readonly sibling?: ReactFiberLike | null
  readonly memoizedProps?: unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dataRouter(value: unknown): DataRouter | undefined {
  if (!record(value) || !record(value.state) || !record(value.state.location)) return undefined
  const location = value.state.location
  if (
    typeof value.subscribe !== 'function' || typeof location.pathname !== 'string'
    || typeof location.search !== 'string' || typeof location.hash !== 'string'
    || typeof location.key !== 'string' || location.key.length === 0
  ) return undefined
  return value as unknown as DataRouter
}

/** Read-only 26.924 React Router Data Router probe; never mutates Codex routing. */
function findDataRouter(document: Document): DataRouter | undefined {
  const root = document.getElementById('root')
  const key = root === null ? undefined : Object.keys(root).find(candidate => candidate.startsWith('__reactContainer$'))
  if (root === null || key === undefined) return undefined
  const start = (root as unknown as Record<string, unknown>)[key] as ReactFiberLike | undefined
  if (start === undefined) return undefined
  const pending: ReactFiberLike[] = [start]
  const seen = new Set<ReactFiberLike>()
  while (pending.length > 0 && seen.size < 50_000) {
    const fiber = pending.pop()!
    if (seen.has(fiber)) continue
    seen.add(fiber)
    const props = record(fiber.memoizedProps) ? fiber.memoizedProps : undefined
    const context = props !== undefined && record(props.value) ? props.value : undefined
    const router = dataRouter(context?.router)
    if (router !== undefined) return router
    if (fiber.sibling !== undefined && fiber.sibling !== null) pending.push(fiber.sibling)
    if (fiber.child !== undefined && fiber.child !== null) pending.push(fiber.child)
  }
  return undefined
}

/** Host-private native route observation across Codex router generations. */
export class CodexNativeRouteObserver implements NativeRouteSource {
  private router: DataRouter | undefined

  constructor(private readonly document: Document, private readonly legacy: NativeRouteSource) {
    this.router = findDataRouter(document)
  }

  snapshot(): NativeRouteSnapshot {
    this.router ??= findDataRouter(this.document)
    if (this.router !== undefined) {
      if (findDataRouter(this.document) !== this.router) return { available: false }
      const { pathname, search, hash, key } = this.router.state.location
      if (
        typeof pathname !== 'string' || typeof search !== 'string'
        || typeof hash !== 'string' || typeof key !== 'string' || key.length === 0
      ) return { available: false }
      return { available: true, key, nativeLocation: { pathname, search, hash } }
    }
    return this.legacy.snapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.router === undefined ? this.legacy.subscribe(listener) : this.router.subscribe(listener)
  }
}
