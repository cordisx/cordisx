import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagerPaneRecapture } from '../packages/cli/src/renderer/manager/manager-pane-recapture.js'
import { nativeRouteIdentity } from '../packages/cli/src/renderer/manager/native-route-transition.js'

function fixture() {
  const dom = new JSDOM('<body><nav></nav><main></main><main id="other"></main></body>', { pretendToBeVisual: true })
  const document = dom.window.document
  const rail = document.querySelector<HTMLElement>('nav')!
  const main = document.querySelector<HTMLElement>('main')!
  const route = {
    available: true,
    key: 'home',
    nativeLocation: { pathname: '/', search: '', hash: '' },
  }
  const schedule = vi.fn()
  const recapture = new ManagerPaneRecapture({ snapshot: () => route, subscribe: () => () => {} }, schedule)
  const identity = { route: nativeRouteIdentity(route), rail, main }
  const seat = { rail, main: { anchor: main } }
  return { dom, document, route, schedule, recapture, identity, seat }
}

describe('bounded Manager split recapture', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits through a temporarily missing seat and stops retries after restoration', () => {
    const f = fixture()
    try {
      const activate = vi.fn(() => true)
      expect(f.recapture.canRetain(f.identity, undefined)).toBe(true)
      f.recapture.start(f.identity)
      expect(f.recapture.resume(undefined, activate)).toBe('waiting')
      expect(activate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(25)
      expect(f.schedule).toHaveBeenCalledTimes(1)
      expect(f.recapture.resume(f.seat, activate)).toBe('restored')
      vi.advanceTimersByTime(1000)
      expect(f.schedule).toHaveBeenCalledTimes(1)
    } finally {
      f.recapture.dispose()
      f.dom.window.close()
    }
  })

  it('retains the original deadline when a failed activation cancels the old native lease', () => {
    const f = fixture()
    try {
      const activate = vi.fn(() => {
        f.recapture.cancel()
        return false
      })
      f.recapture.start(f.identity)
      expect(f.recapture.resume(f.seat, activate)).toBe('waiting')
      vi.advanceTimersByTime(25)
      expect(f.schedule).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(975)
      expect(f.recapture.resume(f.seat, activate)).toBe('lost')
      expect(activate).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.recapture.dispose()
      f.dom.window.close()
    }
  })

  it('restores a valid same-page seat when native background throttling delays the retry', () => {
    const f = fixture()
    try {
      const activate = vi.fn(() => true)
      f.recapture.start(f.identity)
      vi.advanceTimersByTime(1200)
      expect(f.recapture.resume(f.seat, activate)).toBe('restored')
      expect(activate).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.recapture.dispose()
      f.dom.window.close()
    }
  })

  it('waits for actual paint in an offscreen renderer and restores without polling stale geometry', () => {
    const f = fixture()
    try {
      let paint: FrameRequestCallback | undefined
      Object.defineProperty(f.document, 'visibilityState', { configurable: true, value: 'hidden' })
      const request = vi.spyOn(f.dom.window, 'requestAnimationFrame').mockImplementation(callback => {
        paint = callback
        return 1
      })
      const cancel = vi.spyOn(f.dom.window, 'cancelAnimationFrame').mockImplementation(() => {})
      const activate = vi.fn(() => false)
      f.recapture.start(f.identity)
      expect(f.recapture.resume(f.seat, activate)).toBe('waiting')
      vi.advanceTimersByTime(5000)
      expect(f.schedule).not.toHaveBeenCalled()
      expect(f.recapture.resume(f.seat, activate)).toBe('waiting')
      expect(request).toHaveBeenCalledTimes(1)
      paint!(5000)
      expect(f.schedule).toHaveBeenCalledTimes(1)
      activate.mockReturnValue(true)
      expect(f.recapture.resume(f.seat, activate)).toBe('restored')
      f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'))
      expect(f.schedule).toHaveBeenCalledTimes(1)
      expect(cancel).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.recapture.dispose()
      f.dom.window.close()
    }
  })

  it('resumes the foreground deadline and still revokes a changed page while waiting for paint', () => {
    const f = fixture()
    try {
      let visibility = 'hidden'
      Object.defineProperty(f.document, 'visibilityState', { get: () => visibility })
      vi.spyOn(f.dom.window, 'requestAnimationFrame').mockReturnValue(1)
      const cancel = vi.spyOn(f.dom.window, 'cancelAnimationFrame').mockImplementation(() => {})
      const activate = vi.fn(() => false)
      f.recapture.start(f.identity)
      vi.advanceTimersByTime(5000)
      visibility = 'visible'
      f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'))
      expect(f.schedule).toHaveBeenCalledTimes(1)
      expect(f.recapture.resume(f.seat, activate)).toBe('waiting')
      vi.advanceTimersByTime(1000)
      expect(f.recapture.resume(f.seat, activate)).toBe('lost')
      expect(cancel).toHaveBeenCalledWith(1)

      visibility = 'hidden'
      f.recapture.start(f.identity)
      f.route.key = 'other-thread'
      expect(f.recapture.resume(undefined, activate)).toBe('lost')
      expect(cancel).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.recapture.dispose()
      f.dom.window.close()
    }
  })

  it.each(['route', 'unknown-route', 'replacement', 'detached'])(
    'revokes a pending page immediately on %s without activating another page',
    change => {
      const f = fixture()
      try {
        const activate = vi.fn(() => true)
        f.recapture.start(f.identity)
        if (change === 'route') f.route.key = 'different'
        if (change === 'unknown-route') f.route.available = false
        if (change === 'detached') f.identity.main.remove()
        const seat = change === 'replacement'
          ? { rail: f.identity.rail, main: { anchor: f.document.querySelector<HTMLElement>('#other')! } }
          : undefined
        expect(f.recapture.resume(seat, activate)).toBe('lost')
        expect(activate).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1000)
        expect(f.schedule).not.toHaveBeenCalled()
      } finally {
        f.recapture.dispose()
        f.dom.window.close()
      }
    },
  )

  it('never resurrects a canceled or disposed page', () => {
    const f = fixture()
    try {
      const activate = vi.fn(() => true)
      f.recapture.start(f.identity)
      f.recapture.cancel()
      expect(f.recapture.resume(f.seat, activate)).toBe('idle')
      f.recapture.start(f.identity)
      f.recapture.dispose()
      f.recapture.start(f.identity)
      vi.advanceTimersByTime(1000)
      expect(f.schedule).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.dom.window.close()
    }
  })
})
