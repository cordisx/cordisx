import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { CodexNativeRouteObserver } from '../packages/cli/src/renderer/adapter/native-route-observer.js'
import { observeNativeRouteTransition } from '../packages/cli/src/renderer/manager/native-route-transition.js'

describe('26.924 native route observation', () => {
  it('reads Data Router location and ignores menu state updates until the route changes', () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'app://-/index.html' })
    const root = dom.window.document.getElementById('root')!
    const listeners = new Set<() => void>()
    const router = {
      state: { location: { pathname: '/', search: '', hash: '', key: 'home' } },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    Object.defineProperty(root, '__reactContainer$test', {
      enumerable: true,
      value: { child: { memoizedProps: { value: { router } } } },
    })
    const legacy = { snapshot: () => ({ available: false }), subscribe: () => () => {} }
    const source = new CodexNativeRouteObserver(dom.window.document, legacy)
    expect(source.snapshot()).toMatchObject({
      available: true,
      key: 'home',
      nativeLocation: { pathname: '/', search: '', hash: '' },
    })
    const close = vi.fn()
    const dispose = observeNativeRouteTransition(source, close)
    for (const listener of listeners) listener() // Help popover state update
    expect(close).not.toHaveBeenCalled()
    router.state.location = { pathname: '/settings', search: '', hash: '', key: 'settings' }
    for (const listener of listeners) listener()
    expect(close).toHaveBeenCalledOnce()
    dispose()
    expect(listeners.size).toBe(0)
    dom.window.close()
  })

  it('fails closed when the native router root is replaced', () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'app://-/index.html' })
    const root = dom.window.document.getElementById('root')!
    const router = {
      state: { location: { pathname: '/', search: '', hash: '', key: 'home' } },
      subscribe: () => () => {},
    }
    Object.defineProperty(root, '__reactContainer$test', {
      enumerable: true,
      value: { child: { memoizedProps: { value: { router } } } },
    })
    const source = new CodexNativeRouteObserver(dom.window.document, {
      snapshot: () => ({ available: false }),
      subscribe: () => () => {},
    })
    expect(source.snapshot().available).toBe(true)
    root.remove()
    expect(source.snapshot().available).toBe(false)
    dom.window.close()
  })
})
