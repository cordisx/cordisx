interface DataRouterLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly key: string
}

interface DataRouter {
  readonly state: {
    readonly location: DataRouterLocation
    readonly navigation: { readonly state: string }
    readonly revalidation: string
  }
  subscribe(listener: () => void): () => void
}

interface FiberLike {
  readonly child?: FiberLike | null
  readonly sibling?: FiberLike | null
  readonly memoizedProps?: unknown
}

export interface NativeRailIconOwnerToken {
  readonly document: Document
  readonly rail: HTMLElement
  readonly button: HTMLButtonElement
  readonly svg: SVGSVGElement
  readonly destination: string
  readonly routeIdentity: string
  readonly issuedAt: number
  readonly router: DataRouter
}

const issued = new WeakSet<NativeRailIconOwnerToken>()

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function routerFor(document: Document): DataRouter | undefined {
  const root = document.getElementById('root')
  const keys = root === null ? [] : Object.keys(root).filter(key => key.startsWith('__reactContainer$'))
  if (root === null || keys.length !== 1) return undefined
  const initial = (root as unknown as Record<string, unknown>)[keys[0]!] as FiberLike | undefined
  if (initial === undefined) return undefined
  const pending: FiberLike[] = [initial]
  const seen = new Set<FiberLike>()
  const found = new Set<DataRouter>()
  while (pending.length > 0 && seen.size < 50_000) {
    const fiber = pending.pop()!
    if (seen.has(fiber)) continue
    seen.add(fiber)
    const props = fiber.memoizedProps
    const value = record(props) && record(props.value) ? props.value : undefined
    const candidate = value?.router
    if (
      record(candidate) && record(candidate.state) && record(candidate.state.location)
      && typeof candidate.subscribe === 'function'
    ) found.add(candidate as unknown as DataRouter)
    if (fiber.sibling !== undefined && fiber.sibling !== null) pending.push(fiber.sibling)
    if (fiber.child !== undefined && fiber.child !== null) pending.push(fiber.child)
  }
  return found.size === 1 ? [...found][0] : undefined
}

function committedIdentity(router: DataRouter): string | undefined {
  const state = router.state
  const location = state?.location
  if (
    !record(state) || !record(location) || !record(state.navigation)
    || state.navigation.state !== 'idle' || state.revalidation !== 'idle'
    || typeof location.pathname !== 'string' || typeof location.search !== 'string'
    || typeof location.hash !== 'string' || typeof location.key !== 'string' || !location.key
  ) return undefined
  return JSON.stringify([location.pathname, location.search, location.hash, location.key])
}

/** Read the native router's committed location before a Host-owned rail transition. */
export function nativeRailCommittedRouteIdentity(document: Document): string | undefined {
  const router = routerFor(document)
  return router === undefined ? undefined : committedIdentity(router)
}

/**
 * Mint before the Host clears rail DOM markers. A changed, idle DataRouter
 * location plus one native marker and SVG is required. This is only a candidate:
 * the projector must compare that SVG with the rendered selected variant before
 * committing a visual override. An empty marker set is never itself proof.
 */
export function captureNativeRailIconOwner(
  document: Document,
  previousRouteIdentity: string,
): NativeRailIconOwnerToken | undefined {
  if (!previousRouteIdentity || document.defaultView?.location.href !== 'app://-/index.html') return undefined
  const rails = document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  const rail = rails[0]
  if (rails.length !== 1 || rail === undefined) return undefined
  const current = rail.querySelectorAll<HTMLButtonElement>(
    'button[data-sidebar-destination][aria-current="page"]',
  )
  const marked = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination][data-selected]')
  const button = current[0]
  if (current.length !== 1 || marked.length !== 1 || button === undefined || button !== marked[0]) return undefined
  const destination = button.getAttribute('data-sidebar-destination')
  const svgs = button.querySelectorAll<SVGSVGElement>('svg')
  const svg = svgs[0]
  if (destination === null || svgs.length !== 1 || svg === undefined || svg.querySelector('path[d]') === null) {
    return undefined
  }
  const router = routerFor(document)
  const routeIdentity = router === undefined ? undefined : committedIdentity(router)
  if (router === undefined || routeIdentity === undefined || routeIdentity === previousRouteIdentity) {
    return undefined
  }
  const token: NativeRailIconOwnerToken = Object.freeze({
    document,
    rail,
    button,
    svg,
    destination,
    routeIdentity,
    issuedAt: Date.now(),
    router,
  })
  issued.add(token)
  return token
}

/** One-shot check after Host entry; empty markers require this minted route-and-node token. */
export function consumeNativeRailIconOwner(token: NativeRailIconOwnerToken, document: Document): boolean {
  if (!issued.has(token)) return false
  issued.delete(token)
  return token.document === document && Date.now() - token.issuedAt <= 3_000
    && nativeRailIconOwnerCurrent(token, true)
}

/** `allowClearedMarkers` applies only to an authenticated token after Host entry. */
export function nativeRailIconOwnerCurrent(token: NativeRailIconOwnerToken, allowClearedMarkers: boolean): boolean {
  if (routerFor(token.document) !== token.router || committedIdentity(token.router) !== token.routeIdentity) {
    return false
  }
  const rails = token.document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  if (
    rails.length !== 1 || rails[0] !== token.rail || !token.rail.contains(token.button)
    || token.button.getAttribute('data-sidebar-destination') !== token.destination
    || !token.button.contains(token.svg)
  ) return false
  const current = token.rail.querySelectorAll('button[data-sidebar-destination][aria-current="page"]')
  const marked = token.rail.querySelectorAll('button[data-sidebar-destination][data-selected]')
  return current.length === 1 && marked.length === 1 && current[0] === token.button && marked[0] === token.button
    || allowClearedMarkers && current.length === 0 && marked.length === 0
}

/** Subscribe to DataRouter changes so a programmatic route jump revokes a provisional visual lease. */
export function watchNativeRailIconOwner(token: NativeRailIconOwnerToken, onChange: () => void): () => void {
  return token.router.subscribe(onChange)
}
