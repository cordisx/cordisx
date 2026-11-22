import { afterEach, expect, it, vi } from 'vitest'
import { ManagerBootstrapEntries } from '../packages/cli/src/cli/manager-bootstrap-entries.js'

const secret = (value: string) => value.repeat(64)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

it('serializes retries for the same attempt and retires each previous session', async () => {
  const retired = vi.fn(async () => true)
  const cleanupGate = deferred<void>()
  const cleanup = vi.fn(async () => await cleanupGate.promise)
  const entries = new ManagerBootstrapEntries(retired)
  const bootstrap = entries.issue(cleanup)
  const issue = vi.fn()
    .mockResolvedValueOnce({ token: secret('a'), resumeId: secret('b'), cookie: 'first' })
    .mockResolvedValueOnce({ token: secret('c'), resumeId: secret('d'), cookie: 'second' })
  const attempt = secret('e')
  try {
    const first = entries.exchange(bootstrap, attempt, issue)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    expect(await entries.exchange(bootstrap, secret('f'), issue)).toBeUndefined()
    expect(await entries.exchange(bootstrap, undefined, issue)).toBeUndefined()
    const second = entries.exchange(bootstrap, attempt, issue)
    expect(issue).not.toHaveBeenCalled()
    cleanupGate.resolve()
    expect(await first).toMatchObject({ token: secret('a') })
    expect(await second).toMatchObject({ token: secret('c'), previousResumeId: secret('b') })
    expect(retired).toHaveBeenCalledExactlyOnceWith(secret('a'))
    entries.finalizeSession(secret('c'))
    expect(await entries.exchange(bootstrap, attempt, issue)).toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()
  } finally {
    cleanupGate.resolve()
    await entries.close()
  }
})

it('does not issue a replacement after an uncertain retirement', async () => {
  const entries = new ManagerBootstrapEntries(async () => false)
  const bootstrap = entries.issue()
  const issue = vi.fn(async () => ({ token: secret('a'), resumeId: secret('b'), cookie: 'first' }))
  try {
    expect(await entries.exchange(bootstrap, secret('c'), issue)).toBeDefined()
    expect(await entries.exchange(bootstrap, secret('c'), issue)).toBeUndefined()
    expect(await entries.exchange(bootstrap, secret('c'), issue)).toBeUndefined()
    expect(issue).toHaveBeenCalledOnce()
  } finally {
    await entries.close()
  }
})

it('retires a session issued after its bootstrap expires', async () => {
  vi.useFakeTimers()
  const retired = vi.fn(async () => true)
  const entries = new ManagerBootstrapEntries(retired)
  const bootstrap = entries.issue()
  const issued = deferred<{ token: string }>()
  const issue = vi.fn(async () => await issued.promise)
  try {
    const pending = entries.exchange(bootstrap, secret('a'), issue)
    await vi.advanceTimersByTimeAsync(0)
    expect(issue).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_001)
    issued.resolve({ token: secret('b') })
    expect(await pending).toBeUndefined()
    expect(retired).toHaveBeenCalledExactlyOnceWith(secret('b'))
  } finally {
    issued.resolve({ token: secret('b') })
    await entries.close()
  }
})

it.each(['expired', 'closed'] as const)(
  'does not issue a legacy session if its entry is %s during cleanup',
  async state => {
    vi.useFakeTimers()
    const cleanup = deferred<void>()
    const entries = new ManagerBootstrapEntries(async () => true)
    const bootstrap = entries.issue(async () => await cleanup.promise)
    const issue = vi.fn(async () => ({ token: secret('a') }))
    try {
      const pending = entries.exchange(bootstrap, undefined, issue)
      await vi.advanceTimersByTimeAsync(0)
      if (state === 'expired') await vi.advanceTimersByTimeAsync(60_001)
      else await entries.close()
      cleanup.resolve()
      expect(await pending).toBeUndefined()
      expect(issue).not.toHaveBeenCalled()
    } finally {
      cleanup.resolve()
      await entries.close()
    }
  },
)
