import { describe, expect, it, vi } from 'vitest'
import { waitForInitialDocument } from '../packages/cli/src/launcher/cdp-document-ready.js'

describe('initial native document before bootstrap reload', () => {
  it('waits through the initial navigation before allowing a reload', async () => {
    const send = vi.fn().mockResolvedValueOnce({ result: { value: false } })
      .mockResolvedValueOnce({ result: { value: true } })
    await waitForInitialDocument({ send }, 1000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[1].expression).toContain('document.readyState === "complete"')
  })
  it('does not permit reload when readiness expires or the launch is cancelled', async () => {
    const send = vi.fn().mockResolvedValue({ result: { value: false } })
    await expect(waitForInitialDocument({ send }, 1)).rejects.toThrow('did not finish loading')
    const controller = new AbortController()
    controller.abort()
    send.mockClear()
    await expect(waitForInitialDocument({ send }, 1000, controller.signal)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
