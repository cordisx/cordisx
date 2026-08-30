import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  BrowserRouteHistoryAdapter,
  CodexRouterHistoryAdapter,
  type CodexRouteHistoryEntry,
} from '../packages/cli/src/renderer/codex-router-history.js'

function route(roomId: string): CodexRouteHistoryEntry {
  return Object.freeze({
    schemaVersion: 1,
    owner: 'chatroom',
    routeId: 'chatroom:room',
    outlet: 'main',
    path: `/main/chatroom/${roomId}`,
    params: Object.freeze({ roomId }),
  })
}

interface FakeLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly state: unknown
  readonly key: string
}

class FakeCodexNavigator {
  readonly entries: FakeLocation[]
  index = 0
  action = 'POP'
  listener: ((update: unknown) => void) | undefined
  sequence = 0

  constructor(pathname = '/local/thread-one', state: unknown = { native: true }) {
    this.entries = [{ pathname, search: '', hash: '', state, key: 'native-0' }]
  }

  get location(): FakeLocation {
    return this.entries[this.index]!
  }

  push(to: Pick<FakeLocation, 'pathname' | 'search' | 'hash'>, state?: unknown): void {
    this.action = 'PUSH'
    const location = { ...to, state, key: `native-${++this.sequence}` }
    this.index += 1
    this.entries.splice(this.index, this.entries.length, location)
    this.listener?.({ action: this.action, location, delta: 1 })
  }

  replace(to: Pick<FakeLocation, 'pathname' | 'search' | 'hash'>, state?: unknown): void {
    this.action = 'REPLACE'
    const location = { ...to, state, key: `native-${++this.sequence}` }
    this.entries[this.index] = location
    this.listener?.({ action: this.action, location, delta: 0 })
  }

  go(delta: number): void {
    this.action = 'POP'
    const next = Math.max(0, Math.min(this.entries.length - 1, this.index + delta))
    const actualDelta = next - this.index
    this.index = next
    this.listener?.({ action: this.action, location: this.location, delta: actualDelta })
  }

  listen(listener: (update: unknown) => void): () => void {
    this.listener = listener
    return () => { if (this.listener === listener) this.listener = undefined }
  }
}

function mountNavigator(dom: JSDOM, navigator: FakeCodexNavigator): void {
  dom.window.document.getElementById('root')?.remove()
  const root = dom.window.document.createElement('div')
  root.id = 'root'
  dom.window.document.body.append(root)
  Object.defineProperty(root, '__reactContainer$test', {
    configurable: true,
    enumerable: true,
    value: {
      child: {
        memoizedProps: { value: { basename: '/', navigator, static: false } },
      },
    },
  })
}

describe('CodexRouterHistoryAdapter', () => {
  it('fails closed when the Codex React Router Context navigator is absent', () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://codex.local/native' })
    const adapter = new CodexRouterHistoryAdapter(dom.window as unknown as Window)
    expect(adapter.snapshot()).toMatchObject({ available: false, reason: expect.stringContaining('Context navigator') })
    expect(() => adapter.push(route('one'))).toThrow(/Context navigator/)
    adapter.dispose()
    dom.window.close()
  })

  it('fails closed when the discovered navigator cannot be observed', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/native' })
    const navigator = new FakeCodexNavigator()
    Object.defineProperty(navigator, 'push', { configurable: true, writable: false, value: navigator.push })
    mountNavigator(dom, navigator)
    const adapter = new CodexRouterHistoryAdapter(dom.window as unknown as Window)
    expect(adapter.snapshot()).toMatchObject({ available: false, reason: expect.stringContaining('cannot be observed') })
    adapter.dispose()
    dom.window.close()
  })

  it('pushes and replaces in the existing Codex MemoryHistory without taking its React listener', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/index.html' })
    const navigator = new FakeCodexNavigator('/local/thread-one', { native: true })
    mountNavigator(dom, navigator)
    let reactUpdates = 0
    const reactListener = () => { reactUpdates += 1 }
    navigator.listen(reactListener)
    const originalPush = navigator.push
    const originalReplace = navigator.replace
    const originalGo = navigator.go
    const adapter = new CodexRouterHistoryAdapter(dom.window as unknown as Window)

    const pushed = adapter.push(route('one'))
    expect(pushed).toMatchObject({ available: true, index: 1, entry: { routeId: 'chatroom:room', params: { roomId: 'one' } } })
    expect(navigator.location).toMatchObject({ pathname: '/local/thread-one' })
    expect(navigator.location.state).toMatchObject({ native: true, __cordisxRouteV1: { params: { roomId: 'one' } } })
    expect(dom.window.history.length).toBe(1)
    expect(reactUpdates).toBe(1)
    expect(navigator.listener).toBe(reactListener)

    const replaced = adapter.replace(route('two'))
    expect(replaced).toMatchObject({ index: 1, entry: { path: '/main/chatroom/two', params: { roomId: 'two' } } })
    expect(navigator.entries).toHaveLength(2)
    expect(reactUpdates).toBe(2)

    adapter.replace()
    expect(adapter.snapshot().entry).toBeUndefined()
    expect(navigator.location.state).toEqual({ native: true })
    adapter.dispose()
    expect(navigator.push).toBe(originalPush)
    expect(navigator.replace).toBe(originalReplace)
    expect(navigator.go).toBe(originalGo)
    expect(Object.hasOwn(navigator, 'push')).toBe(false)
    expect(Object.hasOwn(navigator, 'replace')).toBe(false)
    expect(Object.hasOwn(navigator, 'go')).toBe(false)
    dom.window.close()
  })

  it('rolls back the current-only reload checkpoint when a native write fails', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/index.html' })
    const navigator = new FakeCodexNavigator()
    navigator.push = () => { throw new Error('native push failed') }
    mountNavigator(dom, navigator)
    const adapter = new CodexRouterHistoryAdapter(dom.window as unknown as Window)

    expect(() => adapter.push(route('one'))).toThrow('native push failed')
    expect(adapter.snapshot()).toMatchObject({ available: true, index: 0 })
    expect(adapter.snapshot().entry).toBeUndefined()
    expect(dom.window.history.state).toBeNull()
    adapter.dispose()
    dom.window.close()
  })

  it('reverse-projects distinct params after native back/forward without owning an entry stack', async () => {
    const dom = new JSDOM('', { url: 'https://codex.local/index.html' })
    const navigator = new FakeCodexNavigator()
    mountNavigator(dom, navigator)
    navigator.listen(() => {})
    const adapter = new CodexRouterHistoryAdapter(dom.window as unknown as Window)
    let changes = 0
    adapter.subscribe(() => { changes += 1 })
    adapter.push(route('one'))
    adapter.push(route('two'))

    navigator.go(-1)
    await Promise.resolve()
    expect(adapter.snapshot().entry?.params).toEqual({ roomId: 'one' })
    navigator.go(1)
    await Promise.resolve()
    expect(adapter.snapshot().entry?.params).toEqual({ roomId: 'two' })
    expect(changes).toBe(2)

    const nativeState = { native: 'next' }
    navigator.push({ pathname: '/local/thread-two', search: '?native=true', hash: '' }, nativeState)
    await Promise.resolve()
    expect(adapter.snapshot()).toMatchObject({ available: true, index: 3 })
    expect(adapter.snapshot().entry).toBeUndefined()
    expect(navigator.location.state).toBe(nativeState)
    adapter.dispose()
    dom.window.close()
  })

  it('restores only the current route checkpoint on reload and binds it to the native location', async () => {
    const dom = new JSDOM('', { url: 'https://codex.local/index.html' })
    const firstNavigator = new FakeCodexNavigator('/local/thread-one')
    mountNavigator(dom, firstNavigator)
    firstNavigator.listen(() => {})
    const first = new CodexRouterHistoryAdapter(dom.window as unknown as Window)
    first.push(route('one'))
    first.push(route('two'))
    expect(dom.window.history.state.__cordisxRouteReloadV1).toMatchObject({
      pathname: '/local/thread-one',
      entry: { params: { roomId: 'two' } },
    })
    first.dispose()

    const reloadedNavigator = new FakeCodexNavigator('/local/thread-one')
    mountNavigator(dom, reloadedNavigator)
    let reactUpdates = 0
    reloadedNavigator.listen(() => { reactUpdates += 1 })
    const restored = new CodexRouterHistoryAdapter(dom.window as unknown as Window)
    expect(restored.snapshot()).toMatchObject({ available: true, index: 0, entry: { params: { roomId: 'two' } } })
    expect(reloadedNavigator.entries).toHaveLength(1)
    expect(reactUpdates).toBe(1)

    reloadedNavigator.push({ pathname: '/local/thread-two', search: '', hash: '' }, { native: true })
    await Promise.resolve()
    expect(restored.snapshot().entry).toBeUndefined()
    expect(dom.window.history.state).toBeNull()
    restored.dispose()
    dom.window.close()
  })
})

describe('BrowserRouteHistoryAdapter', () => {
  it('initializes browser history only for the standalone Playground', () => {
    const dom = new JSDOM('', { url: 'https://playground.cordisx.local/playground/simulator/tasks/task-1' })
    const adapter = new BrowserRouteHistoryAdapter(dom.window as unknown as Window, true)
    expect(adapter.snapshot()).toMatchObject({ available: true, key: 'default', index: 0 })
    expect(adapter.push(route('one'))).toMatchObject({ index: 1, entry: { params: { roomId: 'one' } } })
    expect(dom.window.location.pathname).toBe('/')
    adapter.dispose()
    dom.window.close()
  })

  it('fails closed outside Playground when a browser key/index seam is absent', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/native' })
    const adapter = new BrowserRouteHistoryAdapter(dom.window as unknown as Window)
    expect(adapter.snapshot()).toMatchObject({ available: false, reason: expect.stringContaining('key and non-negative integer idx') })
    adapter.dispose()
    dom.window.close()
  })
})
