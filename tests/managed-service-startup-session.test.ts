import { describe, expect, it, vi } from 'vitest'
import { StartupSession } from '../packages/cli/src/launcher/managed-service-startup-session.js'

describe('startup session journal', () => {
  it('repairs snapshot-subscribe gaps and orders reentrant updates for every observer', () => {
    const session = new StartupSession('declared')
    const before = session.snapshot()
    session.update('registered')
    const first: number[] = []
    const second: number[] = []
    session.subscribe(snapshot => {
      first.push(snapshot.sequence)
      if (snapshot.value === 'preparing') session.update('ready')
    })
    session.subscribe(snapshot => second.push(snapshot.sequence))
    session.update('preparing')
    expect(before.sequence).toBe(0)
    expect(first).toEqual([1, 2, 3])
    expect(second).toEqual([1, 2, 3])
    expect(session.snapshot().value).toBe('ready')
  })

  it('cancels one waiter without cancelling preparation or another waiter', async () => {
    const session = new StartupSession('preparing')
    const controller = new AbortController()
    const cancelled = session.wait(value => value.value === 'ready', { signal: controller.signal })
    const ready = session.wait(value => value.value === 'ready')
    controller.abort(new Error('caller left'))
    await expect(cancelled).rejects.toThrow('caller left')
    session.update('ready')
    await expect(ready).resolves.toMatchObject({ sequence: 1, value: 'ready' })
    session.dispose()
  })

  it('isolates subscribers and fences updates after disposal', async () => {
    const session = new StartupSession(false)
    session.subscribe(() => {
      throw new Error('reader failed')
    })
    const listener = vi.fn()
    const stop = session.subscribe(listener)
    const pending = session.wait(snapshot => snapshot.value)
    session.dispose()
    session.update(true)
    await expect(pending).rejects.toThrow('disposed')
    expect(listener).toHaveBeenCalledOnce()
    expect(session.snapshot().value).toBe(false)
    stop()
  })

  it('does not retain synchronous successful waiters and times out independently', async () => {
    vi.useFakeTimers()
    try {
      const session = new StartupSession(true)
      const predicate = vi.fn(snapshot => snapshot.value)
      await session.wait(predicate)
      session.update(false)
      expect(predicate).toHaveBeenCalledOnce()
      const timed = session.wait(snapshot => snapshot.value, { timeoutMs: 10 })
      const rejection = expect(timed).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(10)
      await rejection
      session.update(true)
      expect(session.snapshot().value).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
