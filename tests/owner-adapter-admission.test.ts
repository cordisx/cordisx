import { expect, it, vi } from 'vitest'
import { OwnerAdapterAdmission } from '../packages/cli/src/cli/owner-adapter-admission.js'

const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
const gateway = { pid: 123, processStartedAt: 'fixture', instanceToken: 'b'.repeat(64) }
const handle = { rendererId: 'c'.repeat(64), ownerGeneration: 'owner-1', grant: 'd'.repeat(64) }

it('uses only owner-issued, gateway-bound, single-use adapter identity', async () => {
  const attach = vi.fn(async () => {})
  const authority = new OwnerAdapterAdmission({ scope, attach })
  const adapter = { appId: 'fixture-app', adapterId: 'fixture-adapter' }
  const session = authority.issue(adapter, gateway)
  adapter.appId = 'spoofed'
  expect(() =>
    authority.participant.create({
      gateway: { ...gateway, instanceToken: 'e'.repeat(64) },
      browserSessionId: session,
      handle,
    })
  ).toThrow('unavailable')
  const peer = authority.participant.create({ gateway, browserSessionId: session, handle })
  expect(peer.identity).toEqual({
    appId: 'fixture-app',
    adapterId: 'fixture-adapter',
    rendererId: handle.rendererId,
    pid: gateway.pid,
    processStartedAt: gateway.processStartedAt,
  })
  expect(peer.scope).toEqual(scope)
  expect(() => authority.participant.create({ gateway, browserSessionId: session, handle })).toThrow('unavailable')
  await authority.participant.attach(peer)
  expect(attach).toHaveBeenCalledExactlyOnceWith(peer)
  authority.close()
  expect(peer.closed).toBe(true)
  await expect(authority.participant.attach(peer)).rejects.toThrow('unavailable')
})

it('rejects expired grants, stale owner generations and invalid owner identities', () => {
  let now = 10
  const authority = new OwnerAdapterAdmission({ scope, attach: async () => {}, now: () => now })
  expect(() => authority.issue({ appId: '../bad', adapterId: 'adapter' }, gateway)).toThrow('unavailable')
  const session = authority.issue({ appId: 'fixture', adapterId: 'adapter' }, gateway)
  expect(() =>
    authority.participant.create({
      gateway,
      browserSessionId: session,
      handle: { ...handle, ownerGeneration: 'stale' },
    })
  ).toThrow('unavailable')
  now += 60_001
  expect(() => authority.participant.create({ gateway, browserSessionId: session, handle })).toThrow('unavailable')
  authority.close()
  expect(() => authority.issue({ appId: 'fixture', adapterId: 'adapter' }, gateway)).toThrow('unavailable')
})

it('closes a peer if owner admission fails', async () => {
  const authority = new OwnerAdapterAdmission({
    scope,
    attach: async () => {
      throw new Error('stale')
    },
  })
  const browserSessionId = authority.issue({ appId: 'fixture', adapterId: 'adapter' }, gateway)
  const peer = authority.participant.create({ gateway, browserSessionId, handle })
  await expect(authority.participant.attach(peer)).rejects.toThrow('stale')
  expect(peer.closed).toBe(true)
  authority.close()
})

it('reserves only fully admitted adapters and blocks new grants until release', async () => {
  let now = 10
  const authority = new OwnerAdapterAdmission({ scope, attach: async () => {}, now: () => now })
  const adapter = { appId: 'fixture-app', adapterId: 'fixture-adapter' }
  const pending = authority.issue(adapter, gateway)
  expect(() => authority.reserve()).toThrow('adapter-reservation-unavailable')
  const peer = authority.participant.create({ gateway, browserSessionId: pending, handle })
  expect(() => authority.reserve()).toThrow('adapter-reservation-unavailable')
  await authority.participant.attach(peer)
  const reservation = authority.reserve()
  expect(reservation.peers).toEqual([peer])
  expect(reservation.isCurrent()).toBe(true)
  expect(() => authority.issue(adapter, gateway)).toThrow('adapter-admission-unavailable')
  expect(reservation.release()).toBe(true)
  expect(reservation.isCurrent()).toBe(false)
  const next = authority.issue(adapter, gateway)
  expect(() => authority.reserve()).toThrow('adapter-reservation-unavailable')
  now += 60_001
  const afterExpiry = authority.reserve()
  expect(afterExpiry.peers).toEqual([peer])
  expect(() => authority.participant.create({ gateway, browserSessionId: next, handle }))
    .toThrow('adapter-admission-unavailable')
  expect(afterExpiry.release()).toBe(true)
  const cancelled = authority.issue(adapter, gateway)
  expect(authority.revokeGrant(cancelled)).toBe(true)
  expect(authority.revokeGrant(cancelled)).toBe(false)
  expect(authority.reserve().release()).toBe(true)
  authority.close()
})

it('does not reserve a peer whose attachment is still in flight', async () => {
  let finish!: () => void
  const waiting = new Promise<void>(resolve => finish = resolve)
  const authority = new OwnerAdapterAdmission({ scope, attach: async () => await waiting })
  const session = authority.issue({ appId: 'fixture', adapterId: 'adapter' }, gateway)
  const peer = authority.participant.create({ gateway, browserSessionId: session, handle })
  const attaching = authority.participant.attach(peer)
  expect(() => authority.reserve()).toThrow('adapter-reservation-unavailable')
  finish()
  await attaching
  const reservation = authority.reserve()
  expect(reservation.release()).toBe(true)
  authority.close()
})

it('fences the remaining adapters when a reserved peer disconnects', async () => {
  const authority = new OwnerAdapterAdmission({ scope, attach: async () => {} })
  const peers = []
  for (const [index, digit] of ['a', 'b'].entries()) {
    const session = authority.issue({ appId: `fixture-${index}`, adapterId: 'adapter' }, gateway)
    const peer = authority.participant.create({
      gateway,
      browserSessionId: session,
      handle: { ...handle, rendererId: digit.repeat(64) },
    })
    await authority.participant.attach(peer)
    peers.push(peer)
  }
  const reservation = authority.reserve()
  const invalidated = vi.fn()
  reservation.onInvalidated(invalidated)
  peers[0]!.close()
  expect(reservation.isCurrent()).toBe(false)
  expect(invalidated).toHaveBeenCalledOnce()
  expect(peers[1]!.closed).toBe(true)
  expect(reservation.release()).toBe(false)
  expect(() => authority.issue({ appId: 'fixture', adapterId: 'adapter' }, gateway))
    .toThrow('adapter-admission-unavailable')
  authority.close()
})

it('does not let a released reservation fence a later adapter', async () => {
  const authority = new OwnerAdapterAdmission({ scope, attach: async () => {} })
  const reservation = authority.reserve()
  expect(reservation.release()).toBe(true)
  const session = authority.issue({ appId: 'fixture', adapterId: 'adapter' }, gateway)
  const peer = authority.participant.create({ gateway, browserSessionId: session, handle })
  await authority.participant.attach(peer)
  reservation.fence()
  expect(peer.closed).toBe(false)
  expect(authority.reserve().release()).toBe(true)
  authority.close()
})
