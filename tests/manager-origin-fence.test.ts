import { expect, it, vi } from 'vitest'
import { consumeReleasedManagerOriginFence, fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'

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

it('makes a successful release proof single-use, scoped, and valid only in the same turn', async () => {
  const create = async () => {
    const peer = { identity: { rendererId: 'renderer' }, onDisconnect: () => () => {} }
    const writes = { rendererId: 'renderer', isCurrent: () => true, release: () => true, fence: () => {} }
    const reservation = { isCurrent: () => true, release: () => true, fence: () => {} }
    const lifecycle = { reserveExternalMutation: () => reservation, terminal: () => {} }
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
    return { fence, participants: participants as never, lifecycle: lifecycle as never }
  }
  const first = await create()
  expect(consumeReleasedManagerOriginFence(first.fence, first.participants, first.lifecycle)).toBe(false)
  expect(first.fence.release()).toBe(true)
  expect(consumeReleasedManagerOriginFence(first.fence, {} as never, first.lifecycle)).toBe(false)
  expect(consumeReleasedManagerOriginFence(first.fence, first.participants, first.lifecycle)).toBe(true)
  expect(consumeReleasedManagerOriginFence(first.fence, first.participants, first.lifecycle)).toBe(false)
  const second = await create()
  expect(second.fence.release()).toBe(true)
  await Promise.resolve()
  expect(consumeReleasedManagerOriginFence(second.fence, second.participants, second.lifecycle)).toBe(false)
})
