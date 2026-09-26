import { describe, expect, it, vi } from 'vitest'
import type { CodexRouteHistorySnapshot } from '../packages/cli/src/renderer/codex-router-history.js'
import {
  nativeRouteIdentity,
  observeNativeRouteTransition,
} from '../packages/cli/src/renderer/manager/native-route-transition.js'

class RouteSource {
  private current: CodexRouteHistorySnapshot = {
    available: true,
    key: 'home',
    index: 0,
    nativeLocation: { pathname: '/', search: '', hash: '' },
  }
  private listeners = new Set<() => void>()

  snapshot(): CodexRouteHistorySnapshot {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  transition(next: CodexRouteHistorySnapshot): void {
    this.current = next
    for (const listener of this.listeners) listener()
  }
}

describe('Manager native route transition', () => {
  it('retains the pane across non-navigation interaction and closes once on a native route transition', () => {
    const source = new RouteSource()
    const close = vi.fn()
    const dispose = observeNativeRouteTransition(source, close)
    source.transition({ ...source.snapshot() }) // Help menu, focus, drag, or state refresh
    expect(close).not.toHaveBeenCalled()
    source.transition({
      available: true,
      key: 'help',
      index: 1,
      nativeLocation: { pathname: '/settings', search: '?tab=help', hash: '' },
    })
    expect(close).toHaveBeenCalledOnce()
    source.transition({ available: false })
    expect(close).toHaveBeenCalledOnce()
    dispose()
  })

  it('recognizes same-path history entries and a changed native location', () => {
    const initial: CodexRouteHistorySnapshot = {
      available: true,
      key: 'one',
      index: 0,
      nativeLocation: { pathname: '/local/thread', search: '', hash: '' },
    }
    expect(nativeRouteIdentity({ ...initial, entry: undefined })).toBe(nativeRouteIdentity(initial))
    expect(nativeRouteIdentity({ ...initial, key: 'two', index: 1 })).not.toBe(nativeRouteIdentity(initial))
    expect(nativeRouteIdentity({ ...initial, nativeLocation: { pathname: '/local/other', search: '', hash: '' } }))
      .not.toBe(nativeRouteIdentity(initial))
  })

  it('fails closed when the router observation seam becomes unavailable', () => {
    const source = new RouteSource()
    const close = vi.fn()
    const dispose = observeNativeRouteTransition(source, close)
    source.transition({ available: false, reason: 'navigator unavailable' })
    expect(close).toHaveBeenCalledOnce()
    dispose()
    expect(nativeRouteIdentity({ available: false })).toBeUndefined()
  })
})
