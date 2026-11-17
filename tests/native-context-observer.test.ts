import { describe, expect, it } from 'vitest'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'
import { NativeContextObserver } from '../packages/cli/src/launcher/native-context-observer.js'

describe('native context observation', () => {
  it('uses the last reported request snapshot and fences changes and disconnects', async () => {
    const observations = new ContextObservations(() => 100)
    const native = new NativeContextObserver(observations, () => 100, 50)
    native.track('thread', 1, { status: 'resolved', tokens: 80_000, rawWindow: 100_000, usableWindow: 95_000 })
    const events: string[] = []
    const watch = observations.watch('thread', 0.5, event => {
      events.push(event.reason)
    })
    const usage = (totalTokens: number, modelContextWindow = 95_000) => ({
      threadId: 'thread',
      turnId: 'turn',
      tokenUsage: { last: { totalTokens }, modelContextWindow },
    })
    native.notification('thread/tokenUsage/updated', usage(39_999))
    native.notification('thread/tokenUsage/updated', usage(40_000))
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['crossed'])
    expect(observations.read('thread')).toMatchObject({
      usedTokens: 40_000,
      budget: { tokens: 80_000 },
      expiresAt: 150,
    })
    native.notification('thread/tokenUsage/updated', usage(50_000, 100_000))
    expect(observations.read('thread')?.budget).toEqual({ status: 'unavailable', reason: 'unknown' })
    native.notification('thread/settings/updated', { threadId: 'thread' })
    native.notification('thread/tokenUsage/updated', usage(60_000))
    expect(observations.read('thread')?.budget).toEqual({ status: 'unavailable', reason: 'unknown' })
    native.disconnect()
    expect(await watch.closed).toEqual({ code: 'session-replaced' })
    expect(observations.read('thread')).toBeUndefined()
    native.dispose()
  })
})
