import { describe, expect, it } from 'vitest'
import { type ContextObservation, ContextObservations } from '../packages/cli/src/launcher/context-observations.js'

describe('current context threshold observations', () => {
  it('emits only real crossings and rejects stale epoch or duplicate events', async () => {
    let now = 100
    const context = new ContextObservations(() => now)
    let epoch = context.open('s', 1)
    const events: string[] = []
    const watch = context.watch('s', 0.5, event => {
      events.push(event.reason)
    })
    const sample = (sequence: number, usedTokens: number, overrides: Partial<ContextObservation> = {}) => ({
      sessionId: 's',
      sessionGeneration: 1,
      usedTokens,
      budget: { status: 'resolved' as const, tokens: 80_000 },
      observedAt: now,
      expiresAt: now + 10,
      sequence,
      ...epoch,
      ...overrides,
    })
    expect(context.observe(sample(1, 39_999))).toBe(true)
    expect(context.observe(sample(1, 40_000))).toBe(false)
    expect(context.observe(sample(2, 40_000))).toBe(true)
    expect(context.observe(sample(3, 42_000))).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['crossed'])
    now = 111
    expect(context.read('s')).toBeUndefined()
    expect(context.observe(sample(4, 42_000))).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual(['crossed', 'epoch-initial'])
    expect(context.observe(sample(5, 30_000))).toBe(true)
    expect(context.observe(sample(6, 40_000))).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['crossed', 'epoch-initial', 'crossed'])
    const prior = epoch
    epoch = context.invalidate('s', 'config')!
    expect(context.observe(sample(7, 50_000, prior))).toBe(false)
    expect(context.observe(sample(8, 50_000))).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['crossed', 'epoch-initial', 'crossed', 'epoch-initial'])
    await watch.unsubscribe()
    expect(await watch.closed).toEqual({ code: 'unsubscribed' })
    context.dispose()
  })
  it('does not emit for unknown budgets, invalid ratios or a disposed subscription', async () => {
    const context = new ContextObservations(() => 100), epoch = context.open('s', 1)
    expect(() => context.watch('s', 0.99, () => {})).toThrow('invalid')
    const events: string[] = []
    const watch = context.watch('s', 0.9, event => {
      events.push(event.reason)
    })
    expect(context.observe({
      sessionId: 's',
      sessionGeneration: 1,
      usedTokens: 100,
      budget: { status: 'unavailable', reason: 'unknown' },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    })).toBe(true)
    await watch.unsubscribe()
    expect(context.observe({
      sessionId: 's',
      sessionGeneration: 1,
      usedTokens: 100,
      budget: { status: 'resolved', tokens: 100 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 2,
      ...epoch,
    })).toBe(true)
    await Promise.resolve()
    expect(events).toEqual([])
    context.dispose()
  })
  it('fences queued old-epoch events and closes observers that fail', async () => {
    const context = new ContextObservations(() => 100), epoch = context.open('s', 1)
    const events: string[] = []
    const old = context.watch('s', 0.9, event => {
      events.push(event.reason)
    })
    const value: ContextObservation = {
      sessionId: 's',
      sessionGeneration: 1,
      usedTokens: 90,
      budget: { status: 'resolved', tokens: 100 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    }
    expect(context.observe(value)).toBe(true)
    context.invalidate('s', 'config')
    await Promise.resolve()
    expect(events).toEqual([])
    await old.unsubscribe()
    const next = context.open('s', 1)
    const failing = context.watch('s', 0.9, () => {
      throw new Error('observer failed')
    })
    expect(context.observe({ ...value, sequence: 2, ...next })).toBe(true)
    expect(await failing.closed).toEqual({ code: 'observer-failed' })
    context.dispose()
  })
  it('invalidates rather than combines a new budget with an old config epoch', () => {
    const context = new ContextObservations(() => 100), epoch = context.open('s', 1)
    const value: ContextObservation = {
      sessionId: 's',
      sessionGeneration: 1,
      usedTokens: 40,
      budget: { status: 'resolved', tokens: 80 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    }
    expect(context.observe(value)).toBe(true)
    expect(context.observe({ ...value, sequence: 2, budget: { status: 'resolved', tokens: 60 } })).toBe(false)
    expect(context.read('s')).toBeUndefined()
    expect(context.open('s', 1).configEpoch).not.toBe(epoch.configEpoch)
    context.dispose()
  })
})
