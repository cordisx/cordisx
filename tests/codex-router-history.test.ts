import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  BrowserCodexRouteHistoryAdapter,
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

describe('BrowserCodexRouteHistoryAdapter', () => {
  it('fails closed when the Codex React Router key/index seam is absent', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/native' })
    const adapter = new BrowserCodexRouteHistoryAdapter(dom.window as unknown as Window)
    expect(adapter.snapshot()).toMatchObject({ available: false, reason: expect.stringContaining('key and non-negative integer idx') })
    expect(() => adapter.push(route('one'))).toThrow(/React Router history state is unavailable/)
    adapter.dispose()
    dom.window.close()
  })

  it('fails closed when the renderer history methods cannot be observed', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/native' })
    dom.window.history.replaceState({ usr: null, key: 'native-key', idx: 0 }, '')
    Object.defineProperty(dom.window.history, 'pushState', {
      configurable: true,
      writable: false,
      value: dom.window.history.pushState,
    })
    const adapter = new BrowserCodexRouteHistoryAdapter(dom.window as unknown as Window)
    expect(adapter.snapshot()).toMatchObject({ available: false, reason: expect.stringContaining('cannot be observed') })
    adapter.dispose()
    dom.window.close()
  })

  it('projects PUSH/REPLACE into the existing Codex entry without changing its URL or usr state', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/thread/one?native=true' })
    dom.window.history.replaceState({ usr: { native: true }, key: 'native-key', idx: 4 }, '')
    const originalPush = dom.window.history.pushState
    const originalReplace = dom.window.history.replaceState
    let popstates = 0
    dom.window.addEventListener('popstate', () => { popstates += 1 })
    const adapter = new BrowserCodexRouteHistoryAdapter(dom.window as unknown as Window)

    const pushed = adapter.push(route('one'))
    expect(pushed).toMatchObject({ available: true, index: 5, entry: { routeId: 'chatroom:room', params: { roomId: 'one' } } })
    expect(pushed.key).not.toBe('native-key')
    expect(dom.window.location.href).toBe('https://codex.local/thread/one?native=true')
    expect(dom.window.history.state.usr).toEqual({ native: true })
    expect(popstates).toBe(1)
    const length = dom.window.history.length

    const replaced = adapter.replace(route('two'))
    expect(replaced).toMatchObject({ index: 5, entry: { path: '/main/chatroom/two', params: { roomId: 'two' } } })
    expect(replaced.key).not.toBe(pushed.key)
    expect(dom.window.history.length).toBe(length)
    expect(popstates).toBe(2)

    adapter.replace()
    expect(adapter.snapshot()).toMatchObject({ available: true, index: 5 })
    expect(adapter.snapshot().entry).toBeUndefined()
    adapter.dispose()
    expect(dom.window.history.pushState).toBe(originalPush)
    expect(dom.window.history.replaceState).toBe(originalReplace)
    dom.window.close()
  })

  it('observes native PUSH/REPLACE and restores distinct params through native back/forward', async () => {
    const dom = new JSDOM('', { url: 'https://codex.local/thread/one' })
    dom.window.history.replaceState({ usr: null, key: 'native-key', idx: 0 }, '')
    const adapter = new BrowserCodexRouteHistoryAdapter(dom.window as unknown as Window)
    let changes = 0
    adapter.subscribe(() => { changes += 1 })
    adapter.push(route('one'))
    adapter.push(route('two'))

    expect((await adapter.go(-1)).entry?.params).toEqual({ roomId: 'one' })
    expect((await adapter.go(1)).entry?.params).toEqual({ roomId: 'two' })

    dom.window.history.pushState({ usr: { native: 'next' }, key: 'native-next', idx: 3 }, '', '/thread/two')
    await Promise.resolve()
    expect(adapter.snapshot()).toMatchObject({ available: true, key: 'native-next', index: 3 })
    expect(adapter.snapshot().entry).toBeUndefined()
    expect(changes).toBeGreaterThanOrEqual(3)

    dom.window.history.replaceState({ usr: null, key: 'native-replace', idx: 3 }, '', '/thread/three')
    await Promise.resolve()
    expect(adapter.snapshot()).toMatchObject({ key: 'native-replace' })
    expect(adapter.snapshot().entry).toBeUndefined()
    adapter.dispose()
    dom.window.close()
  })
})
