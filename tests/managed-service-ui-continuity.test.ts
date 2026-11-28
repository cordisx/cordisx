import { describe, expect, it, vi } from 'vitest'
import { ManagedServiceUIContinuity } from '../packages/cli/src/launcher/managed-service-ui-continuity.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type { ManagedServiceUISourceSnapshot } from '../packages/cli/src/launcher/managed-service-ui-fence-sources.js'

function fixture() {
  let fence = 1
  let alive = true
  let failStop = false
  let onSubscribe: (() => void) | undefined
  const listeners = new Set<() => void>()
  const source = { snapshot: () => {}, readCatalog: () => {} }
  let sources: ManagedServiceUISourceSnapshot[] = [{
    source,
    webEntry: undefined,
    snapshot: source.snapshot,
    readCatalog: source.readCatalog,
    identity: 'fixture',
  }]
  let capabilities = [{ pluginId: 'provider', pluginGeneration: 'generation', token: 'private-owner-token' }]
  const activation = {
    subscribeSources(listener: () => void) {
      listeners.add(listener)
      onSubscribe?.()
      return () => {
        listeners.delete(listener)
        if (failStop) throw new Error('fixture unsubscribe failed')
      }
    },
  } as unknown as ManagedServiceNodeActivation
  const cleanupFailed = vi.fn()
  const continuity = new ManagedServiceUIContinuity({
    capture: () => alive ? { fence, sources, capabilities, activations: [activation] } : undefined,
    cleanupFailed,
  })
  return {
    continuity,
    listeners,
    cleanupFailed,
    advance: () => fence++,
    notify: () => {
      for (const listener of listeners) listener()
    },
    replaceSource: () => sources = [{ ...sources[0]!, source: {} }],
    replaceCapability: () => capabilities = [{ ...capabilities[0]!, token: 'replacement-token' }],
    disappear: () => alive = false,
    failStop: () => failStop = true,
    onSubscribe: (callback: () => void) => onSubscribe = callback,
  }
}

describe('managed service source continuity evidence', () => {
  it('confirms a newer settled fence only when source objects and owner capabilities remain unchanged', () => {
    const f = fixture()
    const reservation = f.continuity.reserve()
    expect(f.listeners.size).toBe(1)
    expect(() => f.continuity.reserve()).toThrow('managed-service-continuity-unavailable')
    f.advance()
    expect(reservation.finish()).toBe(2)
    expect(f.listeners.size).toBe(0)
    expect(reservation.finish()).toBeUndefined()
    expect(reservation.cancel()).toBe(false)
  })

  it('rejects an intervening source notification even after the original source and token return', () => {
    const f = fixture()
    const reservation = f.continuity.reserve()
    f.notify()
    f.advance()
    expect(reservation.finish()).toBeUndefined()
    expect(f.listeners.size).toBe(0)
  })

  it('rejects a route replacement and rollback even if the final capability token is identical', () => {
    const f = fixture()
    const original = new Map([['provider', {}]])
    const replacement = new Map([['provider', {}]])
    const reservation = f.continuity.reserve()
    f.continuity.observeRoutes(original, replacement)
    f.continuity.observeRoutes(replacement, original)
    f.advance()
    expect(reservation.finish()).toBeUndefined()
    expect(f.listeners.size).toBe(0)
  })

  it('rejects source replacement, capability replacement, missing owners and a non-advancing fence', () => {
    for (const change of ['source', 'capability', 'owner', 'unchanged'] as const) {
      const f = fixture()
      const reservation = f.continuity.reserve()
      if (change === 'source') f.replaceSource()
      if (change === 'capability') f.replaceCapability()
      if (change === 'owner') f.disappear()
      if (change !== 'unchanged') f.advance()
      expect(reservation.finish()).toBeUndefined()
      expect(f.listeners.size).toBe(0)
    }
  })

  it('rejects a source event during observer installation and removes its temporary observer', () => {
    const f = fixture()
    f.onSubscribe(() => f.notify())
    expect(() => f.continuity.reserve()).toThrow('managed-service-continuity-unavailable')
    expect(f.listeners.size).toBe(0)
  })

  it('keeps reentrant reservations out and fences an unconfirmed observer cleanup', () => {
    const f = fixture()
    f.onSubscribe(() => expect(() => f.continuity.reserve()).toThrow('managed-service-continuity-unavailable'))
    const reservation = f.continuity.reserve()
    f.failStop()
    f.advance()
    expect(reservation.finish()).toBeUndefined()
    expect(f.cleanupFailed).toHaveBeenCalledOnce()
  })

  it('retires the temporary observer on cancellation or owner disposal', () => {
    const first = fixture()
    expect(first.continuity.reserve().cancel()).toBe(true)
    expect(first.listeners.size).toBe(0)
    const second = fixture()
    const reservation = second.continuity.reserve()
    second.continuity.dispose()
    expect(second.listeners.size).toBe(0)
    expect(reservation.finish()).toBeUndefined()
    expect(() => second.continuity.reserve()).toThrow('managed-service-continuity-unavailable')
  })
})
