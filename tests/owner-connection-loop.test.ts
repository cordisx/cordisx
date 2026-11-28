import { describe, expect, it, vi } from 'vitest'
import { runOwnerConnectionLoop } from '../packages/cli/src/cli/owner-connection-loop.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('native owner reconnection', () => {
  it('waits for retirement before reconnecting, and closes the replacement on shutdown', async () => {
    const stop = new AbortController()
    const firstOwner = new AbortController()
    const secondOwner = new AbortController()
    const firstWatcher = deferred()
    const secondWatcher = deferred()
    const events: string[] = []
    const reconnect = vi.fn(async () => {
      events.push('reconnect')
      return {
        value: secondOwner.signal,
        close: async () => {
          events.push('close')
        },
      }
    })
    const start = vi.fn(() => {
      events.push('start')
      return secondWatcher.promise
    })
    const operation = runOwnerConnectionLoop({
      initial: firstOwner.signal,
      initialWatcher: firstWatcher.promise,
      signal: stop.signal,
      isReady: () => true,
      isDisconnected: signal => signal.aborted,
      cleanupConfirmed: () => true,
      start,
      reconnect,
      report: event => events.push(event),
    })
    firstOwner.abort()
    await Promise.resolve()
    expect(reconnect).not.toHaveBeenCalled()
    firstWatcher.resolve()
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(events).toEqual(['disconnected', 'reconnect', 'start'])
    stop.abort()
    secondWatcher.resolve()
    await operation
    expect(events).toEqual(['disconnected', 'reconnect', 'start', 'close'])
  })

  it('keeps the App open and refuses reconnection if renderer cleanup is uncertain', async () => {
    const stop = new AbortController()
    const owner = new AbortController()
    const watcher = deferred()
    const reconnect = vi.fn()
    const report = vi.fn()
    const operation = runOwnerConnectionLoop({
      initial: owner.signal,
      initialWatcher: watcher.promise,
      signal: stop.signal,
      isReady: () => true,
      isDisconnected: signal => signal.aborted,
      cleanupConfirmed: () => false,
      start: async () => {},
      reconnect,
      report,
    })
    owner.abort()
    watcher.reject(new Error('cleanup failed'))
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('cleanup-uncertain'))
    expect(reconnect).not.toHaveBeenCalled()
    stop.abort()
    await operation
  })

  it('can retry after an interrupted installation only when its cleanup was confirmed', async () => {
    const stop = new AbortController()
    const firstOwner = new AbortController()
    const secondOwner = new AbortController()
    const firstWatcher = deferred()
    const secondWatcher = deferred()
    const close = vi.fn(async () => {})
    const start = vi.fn(() => secondWatcher.promise)
    const operation = runOwnerConnectionLoop({
      initial: firstOwner.signal,
      initialWatcher: firstWatcher.promise,
      signal: stop.signal,
      isReady: () => true,
      isDisconnected: signal => signal.aborted,
      cleanupConfirmed: () => true,
      start,
      reconnect: async () => ({ value: secondOwner.signal, close }),
      report: () => {},
    })
    firstOwner.abort()
    firstWatcher.reject(new Error('installation was interrupted'))
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    stop.abort()
    secondWatcher.resolve()
    await operation
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not hide a startup failure or reconnect an unready App', async () => {
    const owner = new AbortController()
    owner.abort()
    const reconnect = vi.fn()
    await expect(runOwnerConnectionLoop({
      initial: owner.signal,
      initialWatcher: Promise.reject(new Error('startup failed')),
      signal: new AbortController().signal,
      isReady: () => false,
      isDisconnected: signal => signal.aborted,
      cleanupConfirmed: () => true,
      start: async () => {},
      reconnect,
      report: () => {},
    })).rejects.toThrow('startup failed')
    expect(reconnect).not.toHaveBeenCalled()
  })
})
