export interface CodexRouterLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly state: unknown
  readonly key: string
}

type Destination = Readonly<Pick<CodexRouterLocation, 'pathname' | 'search' | 'hash'>>

/** Index is exposed only when the native router actually supplies it. */
export interface CodexRouterNavigator {
  readonly index?: number
  readonly action: string
  readonly location: CodexRouterLocation
  push(to: Destination, state?: unknown): void | Promise<void>
  replace(to: Destination, state?: unknown): void | Promise<void>
  go(delta: number): void | Promise<void>
  subscribe?(listener: () => void): () => void
}

interface ReactFiberLike {
  readonly child?: ReactFiberLike | null
  readonly sibling?: ReactFiberLike | null
  readonly memoizedProps?: unknown
  readonly stateNode?: { readonly current?: ReactFiberLike }
}

interface DataRouter {
  readonly state: { readonly historyAction: string; readonly location: CodexRouterLocation }
  navigate(to: Destination | number, options?: { readonly state?: unknown; readonly replace?: boolean }): Promise<void>
  subscribe(listener: () => void): () => void
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function location(value: unknown): value is CodexRouterLocation {
  return record(value) && typeof value.pathname === 'string' && value.pathname.startsWith('/')
    && typeof value.search === 'string' && typeof value.hash === 'string'
    && typeof value.key === 'string' && value.key.length > 0
}

function memoryNavigator(value: unknown): CodexRouterNavigator | undefined {
  if (
    !record(value) || !Number.isSafeInteger(value.index) || (value.index as number) < 0
    || typeof value.action !== 'string' || !location(value.location)
    || typeof value.push !== 'function' || typeof value.replace !== 'function'
    || typeof value.go !== 'function' || typeof value.listen !== 'function'
  ) return undefined
  // MemoryHistory has one listener owned by React. It must never be replaced.
  return value as unknown as CodexRouterNavigator
}

function dataNavigator(value: Record<string, unknown>): CodexRouterNavigator | undefined {
  const router = value.router
  const navigator = value.navigator
  if (
    value.static === true || value.basename !== '/'
    || !record(router) || !record(router.state) || !location(router.state.location)
    || typeof router.state.historyAction !== 'string' || typeof router.navigate !== 'function'
    || typeof router.subscribe !== 'function' || !record(navigator)
    || typeof navigator.push !== 'function' || typeof navigator.replace !== 'function'
    || typeof navigator.go !== 'function'
  ) return undefined
  const native = router as unknown as DataRouter
  return {
    get action() {
      return native.state.historyAction
    },
    get location() {
      return native.state.location
    },
    push: (to, state) => native.navigate(to, { state }),
    replace: (to, state) => native.navigate(to, { state, replace: true }),
    go: delta => native.navigate(delta),
    subscribe: listener => {
      let current = native.state.location
      return native.subscribe(() => {
        const next = native.state.location
        if (next === current) return
        current = next
        listener()
      })
    },
  }
}

/** Discover the native router in the committed React tree, including current data-router builds. */
export function findCodexRouterNavigator(document: Document): CodexRouterNavigator | undefined {
  const root = document.getElementById('root')
  if (root === null) return undefined
  const key = Object.keys(root).find(key => key.startsWith('__reactContainer$'))
  if (key === undefined) return undefined
  const container = (root as unknown as Record<string, unknown>)[key] as ReactFiberLike | undefined
  const start = container?.stateNode?.current ?? container
  if (start === undefined) return undefined
  const pending: ReactFiberLike[] = [start]
  const seen = new Set<ReactFiberLike>()
  while (pending.length > 0 && seen.size < 30_000) {
    const fiber = pending.pop()!
    if (seen.has(fiber)) continue
    seen.add(fiber)
    const props = record(fiber.memoizedProps) ? fiber.memoizedProps : undefined
    const value = props && record(props.value) ? props.value : undefined
    if (value) {
      const navigator = memoryNavigator(value.navigator) ?? dataNavigator(value)
      if (navigator) return navigator
    }
    if (fiber.sibling) pending.push(fiber.sibling)
    if (fiber.child) pending.push(fiber.child)
  }
  return undefined
}
