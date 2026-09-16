import { describe, expect, it, vi } from 'vitest'
import { reloadAndWaitForBootstrap } from '../packages/cli/src/launcher/cdp-installation-support.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

function session(
  reload: () => Promise<Record<string, unknown>>,
  closed = false,
): CdpSession {
  return {
    send: vi.fn(reload),
    isClosed: () => closed,
  } as unknown as CdpSession
}

describe('CDP reload bootstrap acknowledgement', () => {
  it('accepts bootstrap completion when the reloaded document drops the Page.reload response', async () => {
    const target = session(async () => await new Promise<Record<string, unknown>>(() => {}))

    await expect(
      reloadAndWaitForBootstrap(target, { ignoreCache: true }, async () => {}),
    ).resolves.toBeUndefined()
    expect(target.send).toHaveBeenCalledWith('Page.reload', { ignoreCache: true }, expect.any(Number))
  })

  it('ignores only the Page.reload timeout while the target remains open', async () => {
    const target = session(async () => {
      throw new Error('CDP request timed out: Page.reload')
    })

    await expect(
      reloadAndWaitForBootstrap(target, {}, async () => {}),
    ).resolves.toBeUndefined()
  })

  it.each([
    { message: 'CDP -32000: fixture reload rejected', closed: false },
    { message: 'CDP connection closed', closed: true },
    { message: 'CDP request timed out: Page.reload', closed: true },
  ])('fails closed after $message when closed is $closed', async fixture => {
    const target = session(async () => {
      throw new Error(fixture.message)
    }, fixture.closed)

    await expect(
      reloadAndWaitForBootstrap(
        target,
        { ignoreCache: true },
        async () => await new Promise<void>(() => {}),
      ),
    ).rejects.toThrow(fixture.message)
  })
})
