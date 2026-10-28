import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForChromeDebugPort } from './fixtures/chrome-debug-port.js'

const running = { exitCode: null, signalCode: null }
afterEach(() => vi.useRealTimers())
describe('Chrome debug port readiness', () => {
  it('waits through absent, empty and partial port files before accepting a complete endpoint', async () => {
    vi.useFakeTimers()
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('45123')
      .mockResolvedValueOnce('45123\n/devtools/browser/fixture\n')
    const result = waitForChromeDebugPort(running, read, () => '')
    await vi.advanceTimersByTimeAsync(150)
    await expect(result).resolves.toBe(45123)
    expect(read).toHaveBeenCalledTimes(4)
  })
  it.each(['0\n/devtools/browser/fixture', '65536\n/devtools/browser/fixture', '45123\n'])(
    'does not accept invalid endpoint %j',
    async contents => {
      vi.useFakeTimers()
      const result = waitForChromeDebugPort(running, async () => contents, () => 'launch diagnostics', 100)
      const rejected = expect(result).rejects.toThrow('within 100ms: launch diagnostics')
      await vi.advanceTimersByTimeAsync(100)
      await rejected
    },
  )
  it('reports a Chrome startup exit immediately instead of waiting out the deadline', async () => {
    const read = vi.fn()
    await expect(waitForChromeDebugPort({ exitCode: 1, signalCode: null }, read, () => 'startup failed'))
      .rejects.toThrow('code=1, signal=null): startup failed')
    expect(read).not.toHaveBeenCalled()
  })
})
