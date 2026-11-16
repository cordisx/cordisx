import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuCardActionQueue } from '../packages/cli/src/launcher/feishu-card-action-queue.js'

const event = {
  messageId: 'om_card',
  chatId: 'oc_group',
  operator: { openId: 'ou_operator' },
  action: { tag: 'button', value: { channelApproval: 'opaque', decision: 'decline' } },
}
afterEach(() => vi.useRealTimers())

describe('Feishu card callback acknowledgement queue', () => {
  it('runs card updates after the SDK has acknowledged the callback, rather than retaining its old root', async () => {
    vi.useFakeTimers()
    let visible = 'pending'
    const phases: string[] = []
    const handle = vi.fn(async value => {
      expect(value).not.toHaveProperty('raw')
      phases.push('native-decision')
      visible = 'resolved'
    })
    const queue = new FeishuCardActionQueue(handle, vi.fn())
    // The real SDK awaits the handler before its dispatcher sends the ACK.
    await queue.enqueue({ ...event, raw: { privateTransportBody: true } })
    phases.push('sdk-ack')
    visible = 'pending' // ACK materializes the clicked card's original snapshot.
    expect(handle).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(phases).toEqual(['sdk-ack', 'native-decision'])
    expect(visible).toBe('resolved')
    expect(handle).toHaveBeenCalledTimes(1)
    await queue.dispose()
  })

  it('serializes clicks, reports failures, and waits for active work while discarding queued work on stop', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const active = new Promise<void>(resolve => {
      finish = resolve
    })
    const handle = vi.fn(async () => active)
    const failure = vi.fn()
    const queue = new FeishuCardActionQueue(handle, failure)
    queue.enqueue(event)
    queue.enqueue({ ...event, messageId: 'om_second' })
    await vi.advanceTimersByTimeAsync(0)
    expect(handle).toHaveBeenCalledTimes(1)
    let disposed = false
    const cleanup = queue.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish()
    await cleanup
    queue.enqueue(event)
    await vi.runAllTimersAsync()
    expect(handle).toHaveBeenCalledTimes(1)
    expect(failure).not.toHaveBeenCalled()

    const broken = new FeishuCardActionQueue(async () => {
      throw new Error('test-operation-failed')
    }, failure)
    broken.enqueue(event)
    await vi.runAllTimersAsync()
    expect(failure).toHaveBeenCalledExactlyOnceWith('card-action-failed', expect.any(Error))
    await broken.dispose()
  })

  it('bounds pending work and cancels a scheduled callback before generation disposal', async () => {
    vi.useFakeTimers()
    const handle = vi.fn(), failure = vi.fn()
    const queue = new FeishuCardActionQueue(handle, failure)
    for (let index = 0; index < 129; index++) queue.enqueue({ ...event, messageId: 'om_' + index })
    expect(failure).toHaveBeenCalledExactlyOnceWith('card-action-queue-full')
    await queue.dispose()
    await vi.runAllTimersAsync()
    expect(handle).not.toHaveBeenCalled()
  })
})
