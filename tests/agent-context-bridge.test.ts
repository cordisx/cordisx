import { describe, expect, it } from 'vitest'
import { HostAgentContextBridge } from '../packages/cli/src/launcher/agent-context-bridge.js'
import { type ContextObservation, ContextObservations } from '../packages/cli/src/launcher/context-observations.js'

describe('authenticated agent context bridge core', () => {
  it('queues real crossings with a source-bound opaque handle and readback', async () => {
    const observations = new ContextObservations(() => 100), epoch = observations.open('session', 1)
    const bridge = new HostAgentContextBridge(observations, 10, () => 100)
    const opened = await bridge.open({ sessionId: 'session', thresholdRatio: 0.5 })
    expect(opened.status).toBe('open')
    if (opened.status !== 'open') throw new Error('unavailable')
    const sample: ContextObservation = {
      sessionId: 'session',
      sessionGeneration: 1,
      turnId: 'turn',
      usedTokens: 39_999,
      budget: { status: 'resolved', tokens: 80_000 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    }
    expect(observations.observe(sample)).toBe(true)
    const pending = bridge.next({ handle: opened.handle, cursor: 0 })
    expect(observations.observe({ ...sample, usedTokens: 40_000, sequence: 2 })).toBe(true)
    const result = await pending
    expect(result).toMatchObject({
      status: 'events',
      cursor: 1,
      events: [{ reason: 'crossed', sample: { usedTokens: 40_000, ratio: 0.5 } }],
    })
    expect(await bridge.read({ sessionId: 'session' })).toMatchObject({
      status: 'available',
      sample: { measurement: { kind: 'reported-snapshot', source: 'provider' } },
    })
    expect(await bridge.next({ handle: opened.handle, cursor: 0 })).toEqual({ status: 'closed', code: 'unavailable' })
    bridge.dispose()
    observations.dispose()
  })
  it('discards queued events after invalidation and unblocks a long poll on close', async () => {
    const observations = new ContextObservations(() => 100), epoch = observations.open('session', 1)
    const bridge = new HostAgentContextBridge(observations, 10, () => 100)
    const opened = await bridge.open({ sessionId: 'session', thresholdRatio: 0.9 })
    if (opened.status !== 'open') throw new Error('unavailable')
    observations.observe({
      sessionId: 'session',
      sessionGeneration: 1,
      usedTokens: 90,
      budget: { status: 'resolved', tokens: 100 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    })
    await Promise.resolve()
    observations.invalidate('session', 'config')
    expect(await bridge.next({ handle: opened.handle, cursor: 0 })).toEqual({ status: 'events', events: [], cursor: 0 })
    const pending = bridge.next({ handle: opened.handle, cursor: 0 })
    await bridge.close({ handle: opened.handle })
    expect(await pending).toEqual({ status: 'closed', code: 'unsubscribed' })
    bridge.dispose()
    observations.dispose()
  })
})
