import { expect, it, vi } from 'vitest'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'

it('fences both authorities when lifecycle release cannot be confirmed', async () => {
  const peer = { identity: { rendererId: 'renderer' }, onDisconnect: () => () => {} }
  const writes = { rendererId: 'renderer', isCurrent: () => true, release: vi.fn(() => true), fence: vi.fn() }
  const reservation = { isCurrent: () => true, release: vi.fn(() => false), fence: vi.fn() }
  const lifecycle = { reserveExternalMutation: () => reservation, terminal: vi.fn() }
  const participants = {
    isBoundTo: () => true,
    ownerPeers: () => [peer],
    peer: () => peer,
    isLive: () => true,
  }
  const sessions = { suspendMutationsForCurrentWrite: async () => writes, hasAdmittedPeer: () => true }
  const fence = await fenceManagerOrigin({
    sessions: sessions as never,
    participants: participants as never,
    lifecycle: lifecycle as never,
  })
  expect(fence.release()).toBe(false)
  expect(reservation.fence).toHaveBeenCalledOnce()
  expect(writes.fence).toHaveBeenCalledOnce()
  expect(writes.release).not.toHaveBeenCalled()
})
