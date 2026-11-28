import { expect, it, vi } from 'vitest'
import { ManagerObservationPolls } from '../packages/cli/src/cli/manager-observation-polls.js'

it('yields a browser connection without starting the owner observation twice', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const pending = new Promise<unknown>(resolve => {
    finish = resolve
  })
  const start = vi.fn(async () => await pending)
  const polls = new ManagerObservationPolls(50)
  try {
    const first = polls.poll('request', 'payload', start)
    await vi.advanceTimersByTimeAsync(50)
    expect(await first).toEqual({ status: 'pending' })
    const second = polls.poll('request', 'payload', start)
    expect(start).toHaveBeenCalledOnce()
    await expect(polls.poll('request', 'different', start)).rejects.toThrow('manager-observation-unavailable')
    finish({ status: 'ok' })
    expect(await second).toEqual({ status: 'complete', value: { status: 'ok' } })
    expect(await polls.poll('request', 'payload', start)).toEqual({ status: 'complete', value: { status: 'ok' } })
    expect(start).toHaveBeenCalledOnce()
  } finally {
    finish(undefined)
    polls.close()
    vi.useRealTimers()
  }
})
