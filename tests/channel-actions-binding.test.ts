import { afterEach, expect, it, vi } from 'vitest'
import { BrowserChannelActionsBridge } from '../packages/cli/src/renderer/channel-actions-binding.js'

afterEach(() => {
  globalThis.__cordisxChannelActionsRequestV1 = undefined
  globalThis.__cordisxChannelActionsReceiveV1 = undefined
  vi.useRealTimers()
})

it('waits for a coordinated connection write without retrying after the old five-second limit', async () => {
  vi.useFakeTimers()
  let requestId = ''
  const binding = vi.fn((payload: string) => {
    requestId = (JSON.parse(payload) as { requestId: string }).requestId
  })
  globalThis.__cordisxChannelActionsRequestV1 = binding
  const bridge = BrowserChannelActionsBridge.connect('fixture-token', true)
  const pending = bridge.run('disable', { ref: {}, expectedRevision: 1 })
  await vi.advanceTimersByTimeAsync(6_000)
  globalThis.__cordisxChannelActionsReceiveV1!(JSON.stringify({ requestId, ok: true, value: { status: 'applied' } }))
  await expect(pending).resolves.toEqual({ status: 'applied' })
  expect(binding).toHaveBeenCalledOnce()
})
