import type { CordisXJsonScalar } from '../contracts.js'

const CORDISX_ROUTE_STATE_KEY = '__cordisxRouteV1'
const CORDISX_NATIVE_STATE_KEY = '__cordisxNativeStateV1'
const CORDISX_ROUTE_RELOAD_KEY = '__cordisxRouteReloadV1'
const CORDISX_BROWSER_STATE_KEY = '__cordisxBrowserStateV1'

export interface CodexRouteHistoryEntry {
  readonly schemaVersion: 1
  readonly owner: string
  readonly routeId: string
  readonly outlet: string
  readonly path: string
  readonly params: Readonly<Record<string, CordisXJsonScalar>>
}

export interface CodexRouteHistorySnapshot {
  readonly available: boolean
  readonly key?: string
  readonly index?: number
  readonly entry?: CodexRouteHistoryEntry
  readonly reason?: string
}

export interface CodexRouteHistoryAdapter {
  snapshot(): CodexRouteHistorySnapshot
  subscribe(listener: () => void): () => void
  push(entry: CodexRouteHistoryEntry): CodexRouteHistorySnapshot
  replace(entry?: CodexRouteHistoryEntry): CodexRouteHistorySnapshot
  go(delta: -1 | 1): Promise<CodexRouteHistorySnapshot>
  dispose(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseScalarParams(value: unknown): Readonly<Record<string, CordisXJsonScalar>> | undefined {
  if (!isRecord(value)) return undefined
  const params: Record<string, CordisXJsonScalar> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return undefined
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) return undefined
    if (typeof item === 'number' && !Number.isFinite(item)) return undefined
    params[key] = item as CordisXJsonScalar
  }
  return Object.freeze(params)
}

function parseEntry(value: unknown): CodexRouteHistoryEntry | undefined {
  if (!isRecord(value)) return undefined
  const allowed = new Set(['schemaVersion', 'owner', 'routeId', 'outlet', 'path', 'params'])
  if (Object.keys(value).some(key => !allowed.has(key))) return undefined
  const params = parseScalarParams(value.params)
  if (value.schemaVersion !== 1
    || typeof value.owner !== 'string'
    || typeof value.routeId !== 'string'
    || typeof value.outlet !== 'string'
    || typeof value.path !== 'string'
    || params === undefined) return undefined
  return Object.freeze({
    schemaVersion: 1,
    owner: value.owner,
    routeId: value.routeId,
    outlet: value.outlet,
    path: value.path,
    params,
  })
}

interface CodexRouterLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly state: unknown
  readonly key: string
}

interface CodexRouterNavigator {
  readonly index: number
  readonly action: string
  readonly location: CodexRouterLocation
  push(to: Readonly<Pick<CodexRouterLocation, 'pathname' | 'search' | 'hash'>>, state?: unknown): void
  replace(to: Readonly<Pick<CodexRouterLocation, 'pathname' | 'search' | 'hash'>>, state?: unknown): void
  go(delta: number): void
  listen(listener: (update: unknown) => void): () => void
}

interface ReactFiberLike {
  readonly child?: ReactFiberLike | null
  readonly sibling?: ReactFiberLike | null
  readonly memoizedProps?: unknown
}

interface RouteReloadCheckpoint {
  readonly schemaVersion: 1
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly entry: CodexRouteHistoryEntry
}

function routerNavigator(value: unknown): CodexRouterNavigator | undefined {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.index)
    || (value.index as number) < 0
    || typeof value.action !== 'string'
    || !isRecord(value.location)
    || typeof value.location.pathname !== 'string'
    || typeof value.location.search !== 'string'
    || typeof value.location.hash !== 'string'
    || typeof value.location.key !== 'string'
    || value.location.key.length === 0
    || typeof value.push !== 'function'
    || typeof value.replace !== 'function'
    || typeof value.go !== 'function'
    || typeof value.listen !== 'function') return undefined
  return value as unknown as CodexRouterNavigator
}

function findCodexRouterNavigator(document: Document): CodexRouterNavigator | undefined {
  const root = document.getElementById('root')
  if (root === null) return undefined
  const containerKey = Object.keys(root).find(key => key.startsWith('__reactContainer$'))
  if (containerKey === undefined) return undefined
  const start = (root as unknown as Record<string, unknown>)[containerKey] as ReactFiberLike | undefined
  if (start === undefined) return undefined
  const pending: ReactFiberLike[] = [start]
  const seen = new Set<ReactFiberLike>()
  while (pending.length > 0) {
    const fiber = pending.pop()!
    if (seen.has(fiber)) continue
    seen.add(fiber)
    const props = isRecord(fiber.memoizedProps) ? fiber.memoizedProps : undefined
    const value = props === undefined || !isRecord(props.value) ? undefined : props.value
    const navigator = routerNavigator(value?.navigator)
    if (navigator !== undefined) return navigator
    if (fiber.sibling !== undefined && fiber.sibling !== null) pending.push(fiber.sibling)
    if (fiber.child !== undefined && fiber.child !== null) pending.push(fiber.child)
  }
  return undefined
}

function routerTarget(location: CodexRouterLocation): Readonly<Pick<CodexRouterLocation, 'pathname' | 'search' | 'hash'>> {
  return Object.freeze({ pathname: location.pathname, search: location.search, hash: location.hash })
}

function stateWithEntry(state: unknown, entry?: CodexRouteHistoryEntry): unknown {
  if (entry !== undefined) {
    return {
      ...(isRecord(state) ? state : { [CORDISX_NATIVE_STATE_KEY]: state }),
      [CORDISX_ROUTE_STATE_KEY]: entry,
    }
  }
  if (!isRecord(state)) return state
  const next = { ...state }
  delete next[CORDISX_ROUTE_STATE_KEY]
  if (Object.hasOwn(next, CORDISX_NATIVE_STATE_KEY) && Object.keys(next).length === 1) {
    return next[CORDISX_NATIVE_STATE_KEY]
  }
  return next
}

function parseReloadCheckpoint(value: unknown): RouteReloadCheckpoint | undefined {
  if (!isRecord(value)) return undefined
  const allowed = new Set(['schemaVersion', 'pathname', 'search', 'hash', 'entry'])
  if (Object.keys(value).some(key => !allowed.has(key))) return undefined
  const entry = parseEntry(value.entry)
  if (value.schemaVersion !== 1
    || typeof value.pathname !== 'string'
    || typeof value.search !== 'string'
    || typeof value.hash !== 'string'
    || entry === undefined) return undefined
  return Object.freeze({
    schemaVersion: 1,
    pathname: value.pathname,
    search: value.search,
    hash: value.hash,
    entry,
  })
}

/**
 * Private adapter for the MemoryHistory navigator owned by Codex React Router.
 *
 * Codex Desktop 26.818.61809 keeps its actionable back/forward history in a
 * React Router Context navigator; `window.history` remains length 1 with null
 * state. The Host discovers that existing navigator from the React root,
 * wraps only `push`/`replace`/`go` so native POPs can be reverse-projected, and
 * never calls `listen` because the MemoryHistory implementation has a single
 * listener already owned by React Router.
 *
 * Browser history stores one current-route reload checkpoint only. It is not a
 * stack and is never used for back/forward. The checkpoint is bound to the
 * native pathname/search/hash and is replaced or cleared after every Codex
 * navigator transition.
 */
export class CodexRouterHistoryAdapter implements CodexRouteHistoryAdapter {
  private readonly listeners = new Set<() => void>()
  private navigator: CodexRouterNavigator | undefined
  private originalPush: CodexRouterNavigator['push'] | undefined
  private originalReplace: CodexRouterNavigator['replace'] | undefined
  private originalGo: CodexRouterNavigator['go'] | undefined
  private originalPushDescriptor: PropertyDescriptor | undefined
  private originalReplaceDescriptor: PropertyDescriptor | undefined
  private originalGoDescriptor: PropertyDescriptor | undefined
  private wrappedPush: CodexRouterNavigator['push'] | undefined
  private wrappedReplace: CodexRouterNavigator['replace'] | undefined
  private wrappedGo: CodexRouterNavigator['go'] | undefined
  private installReason: string | undefined
  private ownWrite = false
  private scheduled = false
  private disposed = false

  constructor(private readonly view: Window) {
    this.install()
  }

  snapshot(): CodexRouteHistorySnapshot {
    if (this.navigator === undefined && !this.disposed) this.install()
    if (this.navigator === undefined) {
      return Object.freeze({
        available: false,
        reason: this.installReason ?? 'Codex React Router navigator is unavailable',
      })
    }
    const location = this.navigator.location
    if (!Number.isSafeInteger(this.navigator.index)
      || this.navigator.index < 0
      || typeof location.key !== 'string'
      || location.key.length === 0) {
      return Object.freeze({ available: false, reason: 'Codex React Router navigator has an invalid index or location key' })
    }
    const entry = isRecord(location.state) ? parseEntry(location.state[CORDISX_ROUTE_STATE_KEY]) : undefined
    return Object.freeze({
      available: true,
      key: location.key,
      index: this.navigator.index,
      ...(entry === undefined ? {} : { entry }),
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  push(entry: CodexRouteHistoryEntry): CodexRouteHistorySnapshot {
    const navigator = this.requireNavigator()
    const location = navigator.location
    this.transition(location, entry, () => navigator.push(routerTarget(location), stateWithEntry(location.state, entry)))
    return this.snapshot()
  }

  replace(entry?: CodexRouteHistoryEntry): CodexRouteHistorySnapshot {
    const navigator = this.requireNavigator()
    const location = navigator.location
    this.transition(location, entry, () => navigator.replace(routerTarget(location), stateWithEntry(location.state, entry)))
    return this.snapshot()
  }

  async go(delta: -1 | 1): Promise<CodexRouteHistorySnapshot> {
    const navigator = this.requireNavigator()
    this.write(() => navigator.go(delta))
    const snapshot = this.snapshot()
    this.persistCurrentLocation()
    return snapshot
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const navigator = this.navigator
    if (navigator !== undefined) {
      if (navigator.push === this.wrappedPush) this.restoreMethod(navigator, 'push', this.originalPushDescriptor)
      if (navigator.replace === this.wrappedReplace) this.restoreMethod(navigator, 'replace', this.originalReplaceDescriptor)
      if (navigator.go === this.wrappedGo) this.restoreMethod(navigator, 'go', this.originalGoDescriptor)
    }
    this.listeners.clear()
  }

  private install(): void {
    if (this.navigator !== undefined || this.disposed) return
    const navigator = findCodexRouterNavigator(this.view.document)
    if (navigator === undefined) {
      this.installReason = 'Codex React Router Context navigator is unavailable'
      return
    }
    try {
      this.view.history.replaceState(this.view.history.state, '')
    } catch (error) {
      this.installReason = `CordisX reload checkpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    const adapter = this
    this.originalPush = navigator.push
    this.originalReplace = navigator.replace
    this.originalGo = navigator.go
    this.originalPushDescriptor = Object.getOwnPropertyDescriptor(navigator, 'push')
    this.originalReplaceDescriptor = Object.getOwnPropertyDescriptor(navigator, 'replace')
    this.originalGoDescriptor = Object.getOwnPropertyDescriptor(navigator, 'go')
    this.wrappedPush = function push(to, state): void {
      adapter.originalPush!.call(this, to, state)
      if (!adapter.ownWrite) adapter.afterNativeTransition()
    }
    this.wrappedReplace = function replace(to, state): void {
      adapter.originalReplace!.call(this, to, state)
      if (!adapter.ownWrite) adapter.afterNativeTransition()
    }
    this.wrappedGo = function go(delta): void {
      adapter.originalGo!.call(this, delta)
      if (!adapter.ownWrite) adapter.afterNativeTransition()
    }
    try {
      navigator.push = this.wrappedPush
      navigator.replace = this.wrappedReplace
      navigator.go = this.wrappedGo
    } catch (error) {
      if (navigator.push === this.wrappedPush) this.restoreMethod(navigator, 'push', this.originalPushDescriptor)
      if (navigator.replace === this.wrappedReplace) this.restoreMethod(navigator, 'replace', this.originalReplaceDescriptor)
      if (navigator.go === this.wrappedGo) this.restoreMethod(navigator, 'go', this.originalGoDescriptor)
      this.installReason = `Codex React Router navigator cannot be observed: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    this.navigator = navigator
    this.installReason = undefined
    this.restoreReloadCheckpoint()
  }

  private requireNavigator(): CodexRouterNavigator {
    const snapshot = this.snapshot()
    if (!snapshot.available || this.navigator === undefined) throw new Error(snapshot.reason)
    return this.navigator
  }

  private write(operation: () => void): void {
    this.ownWrite = true
    try {
      operation()
    } finally {
      this.ownWrite = false
    }
  }

  private transition(location: CodexRouterLocation, entry: CodexRouteHistoryEntry | undefined, operation: () => void): void {
    const previousBrowserState: unknown = this.view.history.state
    this.writeCheckpoint(location, entry)
    try {
      this.write(operation)
    } catch (error) {
      try {
        this.view.history.replaceState(previousBrowserState, '')
      } catch {
        // Installation already proved replaceState; preserve the navigator error
        // if the renderer invalidates that seam during the transition.
      }
      throw error
    }
  }

  private afterNativeTransition(): void {
    this.persistCurrentLocation()
    this.scheduleNotify()
  }

  private persistCurrentLocation(): void {
    if (this.navigator === undefined) return
    const location = this.navigator.location
    const entry = isRecord(location.state) ? parseEntry(location.state[CORDISX_ROUTE_STATE_KEY]) : undefined
    this.writeCheckpoint(location, entry)
  }

  private writeCheckpoint(location: CodexRouterLocation, entry?: CodexRouteHistoryEntry): void {
    const current: unknown = this.view.history.state
    const state: Record<string, unknown> = isRecord(current)
      ? { ...current }
      : { [CORDISX_BROWSER_STATE_KEY]: current }
    if (entry === undefined) {
      delete state[CORDISX_ROUTE_RELOAD_KEY]
      if (Object.hasOwn(state, CORDISX_BROWSER_STATE_KEY) && Object.keys(state).length === 1) {
        this.view.history.replaceState(state[CORDISX_BROWSER_STATE_KEY], '')
        return
      }
    }
    else {
      state[CORDISX_ROUTE_RELOAD_KEY] = Object.freeze({
        schemaVersion: 1,
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        entry,
      }) satisfies RouteReloadCheckpoint
    }
    this.view.history.replaceState(state, '')
  }

  private restoreMethod(
    navigator: CodexRouterNavigator,
    name: 'push' | 'replace' | 'go',
    descriptor: PropertyDescriptor | undefined,
  ): void {
    if (descriptor === undefined) delete (navigator as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(navigator, name, descriptor)
  }

  private restoreReloadCheckpoint(): void {
    const navigator = this.navigator!
    const location = navigator.location
    const current = isRecord(location.state) ? parseEntry(location.state[CORDISX_ROUTE_STATE_KEY]) : undefined
    if (current !== undefined) {
      this.writeCheckpoint(location, current)
      return
    }
    const checkpoint = isRecord(this.view.history.state)
      ? parseReloadCheckpoint(this.view.history.state[CORDISX_ROUTE_RELOAD_KEY])
      : undefined
    if (checkpoint === undefined
      || checkpoint.pathname !== location.pathname
      || checkpoint.search !== location.search
      || checkpoint.hash !== location.hash) {
      this.writeCheckpoint(location)
      return
    }
    this.write(() => navigator.replace(routerTarget(location), stateWithEntry(location.state, checkpoint.entry)))
  }

  private scheduleNotify(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.view.queueMicrotask(() => {
      this.scheduled = false
      if (!this.disposed) this.notify()
    })
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function nextKey(view: Window): string {
  return typeof view.crypto?.randomUUID === 'function'
    ? view.crypto.randomUUID()
    : `cordisx-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Browser-history adapter used only by the standalone Playground renderer.
 * Production Codex uses CodexRouterHistoryAdapter above.
 */
export class BrowserRouteHistoryAdapter implements CodexRouteHistoryAdapter {
  private readonly listeners = new Set<() => void>()
  private readonly originalPushState: History['pushState']
  private readonly originalReplaceState: History['replaceState']
  private readonly wrappedPushState: History['pushState']
  private readonly wrappedReplaceState: History['replaceState']
  private readonly onPopState = () => { if (!this.ownWrite) this.notify() }
  private ownWrite = false
  private scheduled = false
  private disposed = false
  private installReason: string | undefined

  constructor(private readonly view: Window, initializeWhenMissing = false) {
    if (initializeWhenMissing && (!isRecord(view.history.state)
      || typeof view.history.state.key !== 'string'
      || !Number.isSafeInteger(view.history.state.idx))) {
      view.history.replaceState({ ...(isRecord(view.history.state) ? view.history.state : {}), key: 'default', idx: 0 }, '')
    }
    this.originalPushState = view.history.pushState
    this.originalReplaceState = view.history.replaceState
    const adapter = this
    this.wrappedPushState = function pushState(data: unknown, unused: string, url?: string | URL | null): void {
      adapter.originalPushState.call(this, data, unused, url)
      if (!adapter.ownWrite) adapter.scheduleNotify()
    }
    this.wrappedReplaceState = function replaceState(data: unknown, unused: string, url?: string | URL | null): void {
      adapter.originalReplaceState.call(this, data, unused, url)
      if (!adapter.ownWrite) adapter.scheduleNotify()
    }
    try {
      view.history.pushState = this.wrappedPushState
      view.history.replaceState = this.wrappedReplaceState
      view.addEventListener('popstate', this.onPopState)
    } catch (error) {
      if (view.history.pushState === this.wrappedPushState) view.history.pushState = this.originalPushState
      if (view.history.replaceState === this.wrappedReplaceState) view.history.replaceState = this.originalReplaceState
      this.installReason = `Codex React Router history methods cannot be observed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  snapshot(): CodexRouteHistorySnapshot {
    if (this.installReason !== undefined) return Object.freeze({ available: false, reason: this.installReason })
    const state: unknown = this.view.history.state
    if (!isRecord(state)
      || typeof state.key !== 'string'
      || state.key.length === 0
      || !Number.isSafeInteger(state.idx)
      || (state.idx as number) < 0) {
      return Object.freeze({
        available: false,
        reason: 'Codex React Router history state is unavailable (expected non-empty key and non-negative integer idx)',
      })
    }
    const entry = parseEntry(state[CORDISX_ROUTE_STATE_KEY])
    return Object.freeze({
      available: true,
      key: state.key,
      index: state.idx as number,
      ...(entry === undefined ? {} : { entry }),
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  push(entry: CodexRouteHistoryEntry): CodexRouteHistorySnapshot {
    const current = this.requireSnapshot()
    const state = this.requireState()
    const next = {
      ...state,
      key: nextKey(this.view),
      idx: current.index! + 1,
      [CORDISX_ROUTE_STATE_KEY]: entry,
    }
    this.write(() => this.originalPushState.call(this.view.history, next, ''))
    return this.snapshot()
  }

  replace(entry?: CodexRouteHistoryEntry): CodexRouteHistorySnapshot {
    this.requireSnapshot()
    const state: Record<string, unknown> = { ...this.requireState(), key: nextKey(this.view) }
    if (entry === undefined) delete state[CORDISX_ROUTE_STATE_KEY]
    else state[CORDISX_ROUTE_STATE_KEY] = entry
    this.write(() => this.originalReplaceState.call(this.view.history, state, ''))
    return this.snapshot()
  }

  go(delta: -1 | 1): Promise<CodexRouteHistorySnapshot> {
    this.requireSnapshot()
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = this.view.setTimeout(() => {
        if (settled) return
        settled = true
        this.view.removeEventListener('popstate', onPop)
        reject(new Error(`Codex session history did not complete go(${delta})`))
      }, 2000)
      const onPop = () => {
        if (settled) return
        settled = true
        this.view.clearTimeout(timeout)
        this.view.removeEventListener('popstate', onPop)
        resolve(this.snapshot())
      }
      this.view.addEventListener('popstate', onPop)
      this.view.history.go(delta)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.view.removeEventListener('popstate', this.onPopState)
    if (this.view.history.pushState === this.wrappedPushState) this.view.history.pushState = this.originalPushState
    if (this.view.history.replaceState === this.wrappedReplaceState) this.view.history.replaceState = this.originalReplaceState
    this.listeners.clear()
  }

  private requireSnapshot(): CodexRouteHistorySnapshot {
    const snapshot = this.snapshot()
    if (!snapshot.available) throw new Error(snapshot.reason)
    return snapshot
  }

  private requireState(): Record<string, unknown> {
    const state: unknown = this.view.history.state
    if (!isRecord(state)) throw new Error('Codex React Router history state is unavailable')
    return state
  }

  private write(operation: () => void): void {
    this.ownWrite = true
    try {
      operation()
      const event = this.view.document.createEvent('Event')
      event.initEvent('popstate', false, false)
      this.view.dispatchEvent(event)
    } finally {
      this.ownWrite = false
    }
  }

  private scheduleNotify(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.view.queueMicrotask(() => {
      this.scheduled = false
      if (!this.disposed) this.notify()
    })
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
