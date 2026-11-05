import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  type CodexRouteHistoryEntry,
  CodexRouterHistoryAdapter,
} from '../packages/cli/src/renderer/codex-router-history.js'
import { createHostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'

const entry: CodexRouteHistoryEntry = {
  schemaVersion: 1,
  owner: 'rooms',
  routeId: 'rooms:room',
  outlet: 'main',
  path: '/main/rooms/one',
  params: {},
}

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://codex.local/index.html' })
  const listeners = new Set<() => void>()
  const locations = [{ pathname: '/local/source', search: '', hash: '', key: 'source', state: { native: true } }]
  let index = 0
  let release: (() => void) | undefined
  let fail = false
  const native = {
    state: { historyAction: 'POP', location: locations[0]!, navigation: { state: 'idle' } },
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    navigate: vi.fn(async (to: any, options?: { state?: any; replace?: boolean }) => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      if (fail) throw Error('Native route rejected')
      if (typeof to === 'number') index = Math.max(0, Math.min(locations.length - 1, index + to))
      else {
        const location = { ...to, key: `location-${locations.length}`, state: options?.state }
        if (options?.replace) locations[index] = location
        else {
          index++
          locations.splice(index, locations.length, location)
        }
      }
      native.state = {
        historyAction: typeof to === 'number' ? 'POP' : options?.replace ? 'REPLACE' : 'PUSH',
        location: locations[index]!,
        navigation: { state: 'idle' },
      }
      for (const listener of listeners) listener()
    }),
  }
  const navigator = { push: vi.fn(), replace: vi.fn(), go: vi.fn() }
  const current = { child: { memoizedProps: { value: { router: native, navigator, static: false, basename: '/' } } } }
  // React's container may retain the previous tree; the committed tree is current.
  Object.defineProperty(dom.window.document.getElementById('root'), '__reactContainer$test', {
    enumerable: true,
    value: { stateNode: { current } },
  })
  return {
    dom,
    native,
    navigator,
    listeners,
    release: () => release!(),
    reject: () => {
      fail = true
    },
  }
}

describe('native data router history', () => {
  it('awaits accepted native navigation and observes native POP without inventing a history index', async () => {
    const f = fixture()
    const react = vi.fn()
    const unsubscribeReact = f.native.subscribe(react)
    const originalNavigate = f.native.navigate
    const browserPush = vi.spyOn(f.dom.window.history, 'pushState')
    const adapter = new CodexRouterHistoryAdapter(f.dom.window as unknown as Window)
    const changed = vi.fn()
    adapter.subscribe(changed)
    expect(adapter.snapshot()).toMatchObject({
      available: true,
      key: 'source',
      nativeLocation: { pathname: '/local/source' },
    })
    expect(adapter.snapshot()).not.toHaveProperty('index')
    expect(f.listeners.size).toBe(2)
    const push = adapter.push(entry)
    expect(adapter.snapshot().entry).toBeUndefined()
    f.release()
    await push
    expect(adapter.snapshot().entry).toEqual(entry)
    expect(f.native.state.location.pathname).toBe('/')
    const details = createHostAgentTaskDetailsNavigator(adapter, f.dom.window)
    const navigation = details.navigate({ target: 'host', url: 'app://-/local/destination' })
    expect(f.native.state.location.pathname).toBe('/')
    f.release()
    await navigation
    expect(f.native.state.location).toMatchObject({ pathname: '/local/destination', state: { native: true } })
    expect(adapter.snapshot().entry).toBeUndefined()
    expect(f.dom.window.history.state?.__cordisxRouteReloadV1).toBeUndefined()
    // Native actions bypass the Host wrapper, but the one native state subscription observes them.
    const pop = f.native.navigate(-1)
    f.release()
    await pop
    await Promise.resolve()
    expect(adapter.snapshot().entry).toEqual(entry)
    expect(f.dom.window.history.state.__cordisxRouteReloadV1.entry).toEqual(entry)
    expect(changed).toHaveBeenCalled()
    expect(react).toHaveBeenCalledTimes(3)
    expect(browserPush).not.toHaveBeenCalled()
    expect(f.native.navigate).toBe(originalNavigate)
    expect(f.navigator.push).not.toHaveBeenCalled()
    adapter.dispose()
    expect(f.listeners.size).toBe(1)
    unsubscribeReact()
    f.dom.window.close()
  })

  it('restores the current checkpoint after asynchronous native rejection without changing native location', async () => {
    const f = fixture()
    const adapter = new CodexRouterHistoryAdapter(f.dom.window as unknown as Window)
    f.reject()
    const push = adapter.push(entry)
    f.release()
    await expect(push).rejects.toThrow('Native route rejected')
    expect(adapter.snapshot()).toMatchObject({ key: 'source', nativeLocation: { pathname: '/local/source' } })
    expect(adapter.snapshot().entry).toBeUndefined()
    expect(f.dom.window.history.state).toBeNull()
    adapter.dispose()
    f.dom.window.close()
  })

  it('projects awaited plugin replace and Host back through the same native data router', async () => {
    const f = fixture()
    const adapter = new CodexRouterHistoryAdapter(f.dom.window as unknown as Window)
    const push = adapter.push(entry)
    f.release()
    await push
    const replace = adapter.replace({ ...entry, path: '/main/rooms/two' })
    f.release()
    await replace
    expect(adapter.snapshot().entry?.path).toBe('/main/rooms/two')
    const back = adapter.go(-1)
    f.release()
    await back
    expect(adapter.snapshot().nativeLocation?.pathname).toBe('/local/source')
    expect(adapter.snapshot().entry).toBeUndefined()
    adapter.dispose()
    f.dom.window.close()
  })
})
