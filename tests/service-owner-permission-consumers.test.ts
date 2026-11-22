import { expect, it } from 'vitest'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { ServiceOwnerPermissionConsumers } from '../packages/cli/src/cli/service-owner-permission-consumers.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

async function fixture(loadPolicies: () => Promise<any[]>) {
  const peer = { identity: { rendererId: 'renderer' }, onDisconnect: () => () => {} }
  const writes = { rendererId: 'renderer', isCurrent: () => true, release: () => true, fence: () => {} }
  const lifecycle = {
    reserveExternalMutation: () => ({ isCurrent: () => true, release: () => true, fence: () => {} }),
    terminal: () => {},
  }
  const participants = {
    isBoundTo: () => true,
    ownerPeers: () => [peer],
    peer: () => peer,
    isLive: () => true,
  }
  const sessions = { suspendMutationsForCurrentWrite: async () => writes, hasAdmittedPeer: () => true }
  const origin = await fenceManagerOrigin({
    sessions: sessions as never,
    participants: participants as never,
    lifecycle: lifecycle as never,
  })
  const consumers = new ServiceOwnerPermissionConsumers({
    profileId: 'default',
    generation: 'owner-generation',
    channelSource: 'https://example.test/channel',
    participants: participants as never,
    lifecycle: lifecycle as never,
    ownerCurrent: () => true,
    loadPolicies,
  })
  const [record] = exactDomPermissionPolicies('default', [{
    id: 'channel',
    entry: '/fixture.js',
    pointIds: ['manager.content'],
  }])
  const update = {
    ...record!,
    key: {
      ...record!.key,
      identity: {
        pluginId: 'channel',
        source: 'https://example.test/channel',
      },
    },
  }
  const request = {
    profileId: 'default',
    ownerGeneration: 'owner-generation',
    requestId: 'fixture-request',
    expected: [],
    updates: [update],
    candidate: [update],
  }
  return { origin, consumers, request }
}

it('reads back the exact owner policy before releasing the service-only reservation', async () => {
  let persisted: any[] = []
  const f = await fixture(async () => persisted)
  expect(() => f.consumers.reserve({ ...f.origin })).toThrow('service-permission-consumers-unavailable')
  const reservation = f.consumers.reserve(f.origin)
  persisted = f.request.candidate
  const receipt = await reservation.adopt(f.request, new AbortController().signal)
  expect(receipt).toEqual({
    profileId: f.request.profileId,
    ownerGeneration: f.request.ownerGeneration,
    requestId: f.request.requestId,
    adopted: true,
    candidate: f.request.candidate,
  })
  expect(f.origin.release()).toBe(true)
  expect(reservation.release()).toBe(true)
  expect(reservation.isCurrent()).toBe(false)
  f.consumers.close()
})

it('rejects stale owner readback and a policy for another source', async () => {
  const stale = await fixture(async () => [])
  const staleReservation = stale.consumers.reserve(stale.origin)
  await expect(staleReservation.adopt(stale.request, new AbortController().signal))
    .rejects.toThrow('service-permission-consumers-unavailable')
  staleReservation.fence()
  expect(() => stale.consumers.reserve(stale.origin)).toThrow('service-permission-consumers-unavailable')
  stale.origin.fence()
  stale.consumers.close()

  let persisted: any[] = []
  const wrong = await fixture(async () => persisted)
  const reservation = wrong.consumers.reserve(wrong.origin)
  const update = {
    ...wrong.request.updates[0],
    key: {
      ...wrong.request.updates[0]!.key,
      identity: {
        pluginId: 'channel',
        source: 'https://example.test/other',
      },
    },
  }
  persisted = [update]
  await expect(
    reservation.adopt({ ...wrong.request, updates: [update], candidate: [update] }, new AbortController().signal),
  ).rejects.toThrow('service-permission-consumers-unavailable')
  reservation.fence()
  wrong.origin.fence()
  wrong.consumers.close()
})

it('cannot adopt after the origin is fenced while the owner readback is pending', async () => {
  let finish!: (records: any[]) => void
  const waiting = new Promise<any[]>(resolve => finish = resolve)
  const f = await fixture(async () => await waiting)
  const reservation = f.consumers.reserve(f.origin)
  const adoption = reservation.adopt(f.request, new AbortController().signal)
  f.origin.fence()
  finish(f.request.candidate)
  await expect(adoption).rejects.toThrow('service-permission-consumers-unavailable')
  expect(reservation.release()).toBe(false)
  f.consumers.close()
})

it.each([false, true])('rejects a missing or delayed origin release proof: %s', async delayed => {
  let persisted: any[] = []
  const f = await fixture(async () => persisted)
  const reservation = f.consumers.reserve(f.origin)
  persisted = f.request.candidate
  await reservation.adopt(f.request, new AbortController().signal)
  if (delayed) {
    expect(f.origin.release()).toBe(true)
    await Promise.resolve()
  }
  expect(reservation.release()).toBe(false)
  expect(() => f.consumers.reserve(f.origin)).toThrow('service-permission-consumers-unavailable')
  f.origin.fence()
  f.consumers.close()
})
