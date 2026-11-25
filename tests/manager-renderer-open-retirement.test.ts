import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'

const secret = () => randomBytes(32).toString('hex')

async function fixture(maxSessions?: number) {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let release!: (value: boolean) => void
  const retired = new Promise<boolean>(resolve => release = resolve)
  let gatewayLive = true
  let ownerLive = true
  const authenticate = vi.fn(async () => gatewayLive)
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => ownerLive,
    authenticateGateway: authenticate,
    waitForRetirement: async () => await retired,
    ...(maxSessions === undefined ? {} : { maxSessions }),
  })
  const browserSessionId = secret()
  const handle = (await authority.open(gateway, browserSessionId))!
  const closing = authority.close({ gateway, browserSessionId, handle })
  await vi.waitFor(() => expect(authority.mutationAvailability()).toBe('busy'))
  return {
    authority,
    gateway,
    authenticate,
    closing,
    release,
    setGatewayLive: (value: boolean) => gatewayLive = value,
    setOwnerLive: (value: boolean) => ownerLive = value,
  }
}

it('waits for a confirmed retirement before opening a new Manager session', async () => {
  const f = await fixture()
  let settled = false
  const opening = f.authority.open(f.gateway, secret()).then(value => {
    settled = true
    return value
  })
  try {
    await vi.waitFor(() => expect(f.authenticate).toHaveBeenCalledTimes(3))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    f.release(true)
    expect(await f.closing).toBe(true)
    expect(await opening).toBeDefined()
  } finally {
    f.release(true)
    await Promise.allSettled([f.closing, opening])
    f.authority.dispose()
  }
})

it('keeps a waiting page visible to owner coordination while its gateway is reauthenticated', async () => {
  const f = await fixture()
  let releaseAuthentication!: (value: boolean) => void
  const reauthentication = new Promise<boolean>(resolve => releaseAuthentication = resolve)
  f.authenticate.mockResolvedValueOnce(true).mockImplementationOnce(async () => await reauthentication)
  const opening = f.authority.open(f.gateway, secret())
  try {
    await vi.waitFor(() => expect(f.authenticate).toHaveBeenCalledTimes(3))
    f.release(true)
    expect(await f.closing).toBe(true)
    await vi.waitFor(() => expect(f.authenticate).toHaveBeenCalledTimes(4))
    expect(f.authority.hasLiveRenderers()).toBe(true)
    const fence = await f.authority.suspendMutations()
    releaseAuthentication(true)
    expect(await opening).toBeUndefined()
    expect(fence.release()).toBe(true)
    expect(await f.authority.open(f.gateway, secret())).toBeDefined()
  } finally {
    f.release(true)
    releaseAuthentication(true)
    await Promise.allSettled([f.closing, opening])
    f.authority.dispose()
  }
})

it('does not admit a pending open after revocation or an unconfirmed retirement', async () => {
  for (const outcome of ['revoked', 'failed', 'gateway-lost', 'owner-lost'] as const) {
    const f = await fixture()
    const browserSessionId = secret()
    let settled = false
    const opening = f.authority.open(f.gateway, browserSessionId).then(value => {
      settled = true
      return value
    })
    try {
      await vi.waitFor(() => expect(f.authenticate).toHaveBeenCalledTimes(3))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      if (outcome === 'revoked') expect(await f.authority.revoke(f.gateway, browserSessionId)).toBe(true)
      if (outcome === 'gateway-lost') f.setGatewayLive(false)
      if (outcome === 'owner-lost') f.setOwnerLive(false)
      f.release(outcome !== 'failed')
      expect(await opening).toBeUndefined()
    } finally {
      f.release(true)
      await Promise.allSettled([f.closing, opening])
      f.authority.dispose()
    }
  }
})

it('stops waiting when retirement is not confirmed in time', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  let settled = false
  const opening = f.authority.open(f.gateway, secret()).then(value => {
    settled = true
    return value
  })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await opening).toBeUndefined()
    f.release(true)
    expect(await f.closing).toBe(true)
    expect(await f.authority.open(f.gateway, secret())).toBeDefined()
  } finally {
    f.release(true)
    await Promise.allSettled([f.closing, opening])
    f.authority.dispose()
    vi.useRealTimers()
  }
})

it('bounds waiting opens and never allocates two sessions for the same page', async () => {
  const f = await fixture(2)
  const firstId = secret()
  const first = f.authority.open(f.gateway, firstId)
  const duplicate = f.authority.open(f.gateway, firstId)
  const second = f.authority.open(f.gateway, secret())
  const excess = f.authority.open(f.gateway, secret())
  try {
    expect(await duplicate).toBeUndefined()
    expect(await excess).toBeUndefined()
    f.release(true)
    expect(await first).toBeDefined()
    expect(await second).toBeDefined()
  } finally {
    f.release(true)
    await Promise.allSettled([f.closing, first, second, duplicate, excess])
    f.authority.dispose()
  }
})
