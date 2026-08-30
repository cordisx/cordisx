import type { CordisXJsonScalar } from '../contracts.js'

const CORDISX_ROUTE_STATE_KEY = '__cordisxRouteV1'

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

function nextKey(view: Window): string {
  return typeof view.crypto?.randomUUID === 'function'
    ? view.crypto.randomUUID()
    : `cordisx-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Private Codex adapter for the BrowserRouter history used by the renderer.
 *
 * React Router does not publish its navigator. The stable executable seam is
 * therefore the browser history record that it already owns (`key` + `idx`).
 * CordisX stores only a namespaced projection beside that record, changes the
 * location key for PUSH/REPLACE, and emits `popstate` so React Router observes
 * the same location. Native React Router writes are observed by wrapping the
 * two History mutation methods; the wrappers are restored on disposal.
 */
export class BrowserCodexRouteHistoryAdapter implements CodexRouteHistoryAdapter {
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
