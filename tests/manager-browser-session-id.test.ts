import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  createManagerBrowserSessionIdIssuer,
  ManagerBrowserSessionTombstones,
} from '../packages/cli/src/cli/manager-browser-session-id.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'

const gateway = () => ({ pid: 42, processStartedAt: 'fixture', instanceToken: randomBytes(32).toString('hex') })
const openWindowMs = 8 * 60 * 60 * 1000

it('binds timed session IDs to the gateway and keeps legacy IDs one-use', () => {
  const proof = gateway()
  const issue = createManagerBrowserSessionIdIssuer(proof)
  const ids = new ManagerBrowserSessionTombstones()
  const first = issue()
  const other = issue()
  expect(first).toMatch(/^[a-f0-9]{64}$/u)
  expect(first).not.toBe(other)
  expect(ids.consume(proof, first)).toBe(true)
  expect(ids.canOpen(proof, first)).toBe(false)
  expect(ids.revoke(proof, first)).toBe(true)
  expect(ids.canOpen({ ...proof, pid: proof.pid + 1 }, other)).toBe(false)
  const altered = other.slice(0, -1) + (other.endsWith('0') ? '1' : '0')
  expect(ids.canOpen(proof, altered)).toBe(false)
  expect(ids.revoke(proof, altered)).toBe(false)
  const legacy = 'f'.repeat(64)
  expect(ids.consume(proof, legacy)).toBe(true)
  expect(ids.canOpen(proof, legacy)).toBe(false)
})

it('expires timed tombstones without reviving them after a clock rollback', () => {
  let now = 1_800_000_000_000
  const proof = gateway()
  const issue = createManagerBrowserSessionIdIssuer(proof, () => now)
  const ids = new ManagerBrowserSessionTombstones(() => now, 1)
  const old = issue()
  expect(ids.consume(proof, old)).toBe(true)
  now += openWindowMs + 61_000
  expect(ids.canOpen(proof, old)).toBe(false)
  const current = issue()
  expect(ids.consume(proof, current)).toBe(true)
  now -= openWindowMs + 61_000
  expect(ids.canOpen(proof, old)).toBe(false)
  expect(ids.revoke(proof, old)).toBe(true)
})

it('fences delayed opens if a revocation cannot be recorded at capacity', () => {
  let now = 1_800_000_000_000
  const proof = gateway()
  const issue = createManagerBrowserSessionIdIssuer(proof, () => now)
  const ids = new ManagerBrowserSessionTombstones(() => now, 2)
  expect(ids.consume(proof, issue())).toBe(true)
  expect(ids.consume(proof, issue())).toBe(true)
  now += 60_000
  const delayed = issue()
  expect(ids.revoke(proof, delayed)).toBe(false)
  now += openWindowMs - 59_000
  expect(ids.canOpen(proof, delayed)).toBe(false)
  expect(ids.canOpen(proof, issue())).toBe(false)
  now += 61_000
  expect(ids.canOpen(proof, delayed)).toBe(false)
  expect(ids.canOpen(proof, issue())).toBe(true)
})

it('remembers a future-dated revocation without blocking unrelated sessions', () => {
  let now = 1_800_000_000_000
  const proof = gateway()
  const ids = new ManagerBrowserSessionTombstones(() => now)
  const future = createManagerBrowserSessionIdIssuer(proof, () => now + 120_000)()
  expect(ids.revoke(proof, future)).toBe(true)
  expect(ids.canOpen(proof, createManagerBrowserSessionIdIssuer(proof, () => now)())).toBe(true)
  now += 120_000
  expect(ids.canOpen(proof, future)).toBe(false)
})

it('admits more than 4096 confirmed timed sessions without replaying an old one', async () => {
  const proof = gateway()
  const issue = createManagerBrowserSessionIdIssuer(proof)
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === proof.instanceToken,
  })
  const first = issue()
  try {
    for (let index = 0; index < 4097; index++) {
      const browserSessionId = index === 0 ? first : issue()
      const handle = await authority.open(proof, browserSessionId)
      expect(handle).toBeDefined()
      expect(await authority.close({ gateway: proof, browserSessionId, handle: handle! })).toBe(true)
    }
    expect(await authority.open(proof, first)).toBeUndefined()
    expect(await authority.open(proof, issue())).toBeDefined()
  } finally {
    authority.dispose()
  }
}, 15_000)

it('keeps a timed session revoked when open authentication completes late', async () => {
  const proof = gateway()
  const browserSessionId = createManagerBrowserSessionIdIssuer(proof)()
  let release!: (value: boolean) => void
  const pending = new Promise<boolean>(resolve => release = resolve)
  const authenticate = vi.fn().mockImplementationOnce(async () => await pending).mockResolvedValue(true)
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: authenticate,
  })
  try {
    const opening = authority.open(proof, browserSessionId)
    expect(await authority.revoke(proof, browserSessionId)).toBe(true)
    release(true)
    expect(await opening).toBeUndefined()
  } finally {
    release(true)
    authority.dispose()
  }
})

it('does not reopen after an unconfirmed timed-session retirement', async () => {
  const proof = gateway()
  const issue = createManagerBrowserSessionIdIssuer(proof)
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    waitForRetirement: async () => false,
  })
  const browserSessionId = issue()
  try {
    const handle = (await authority.open(proof, browserSessionId))!
    expect(await authority.close({ gateway: proof, browserSessionId, handle })).toBe(false)
    expect(await authority.revoke(proof, browserSessionId)).toBe(false)
    expect(await authority.open(proof, issue())).toBeUndefined()
  } finally {
    authority.dispose()
  }
})
