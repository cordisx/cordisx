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
