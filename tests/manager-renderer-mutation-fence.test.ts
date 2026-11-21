import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { fenceManagerConsumers } from '../packages/cli/src/cli/manager-consumer-fence.js'

const secret = () => randomBytes(32).toString('hex')
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(dispatch: () => Promise<unknown>) {
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([['fixture', {
      prepare: value =>
        value === 'write'
          ? { mode: 'write' as const, dispatch }
          : { mode: 'read' as const, dispatch: async () => 'read' },
    }]]),
  })
  const open = async () => {
    const browserSessionId = secret()
    const handle = await authority.open(gateway, browserSessionId)
    return handle && { gateway, browserSessionId, handle }
  }
  return { authority, open }
}

afterEach(() => vi.useRealTimers())

it('drains existing Manager writes and blocks new writes and admissions until release', async () => {
  const pending = deferred<unknown>()
  const dispatch = vi.fn(async () => await pending.promise)
  const { authority, open } = fixture(dispatch)
  try {
    const invocation = (await open())!
    const first = authority.call(invocation, 'fixture', 'write')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    let ready = false
    const fence = authority.suspendMutations().then(value => {
      ready = true
      return value
    })
    expect(await authority.call(invocation, 'fixture', 'write')).toEqual({ status: 'unavailable' })
    expect(await authority.call(invocation, 'fixture', 'read')).toEqual({ status: 'ok', value: 'read' })
    expect(await open()).toBeUndefined()
    expect(ready).toBe(false)
    pending.resolve('written')
    expect(await first).toEqual({ status: 'ok', value: 'written' })
    const lease = await fence
    expect(await open()).toBeUndefined()
    expect(lease.release()).toBe(true)
    expect(lease.release()).toBe(false)
    expect(await open()).toBeDefined()
    expect(await authority.call(invocation, 'fixture', 'write')).toEqual({ status: 'ok', value: 'written' })
  } finally {
    pending.resolve(undefined)
    authority.dispose()
  }
})

it('fails closed if a write becomes uncertain while draining', async () => {
  const pending = deferred<unknown>()
  const dispatch = vi.fn(async () => await pending.promise)
  const { authority, open } = fixture(dispatch)
  try {
    const invocation = (await open())!
    const write = authority.call(invocation, 'fixture', 'write')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    const fence = authority.suspendMutations()
    const rejected = expect(fence).rejects.toThrow('renderer-mutation-fence-unavailable')
    expect(await authority.close(invocation)).toBe(true)
    pending.resolve('possibly committed')
    expect(await write).toEqual({ status: 'unknown' })
    await rejected
    expect(await open()).toBeUndefined()
  } finally {
    pending.resolve(undefined)
    authority.dispose()
  }
})

it('blocks a write that was waiting for gateway authentication when the fence began', async () => {
  const auth = deferred<boolean>()
  const entered = deferred<void>()
  const dispatch = vi.fn(async () => 'written')
  let checks = 0
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => {
      if (++checks === 1) return true
      entered.resolve()
      return await auth.promise
    },
    channels: new Map([['fixture', { prepare: () => ({ mode: 'write', dispatch }) }]]),
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    const write = authority.call({ gateway, browserSessionId, handle }, 'fixture', 'write')
    await entered.promise
    const fence = await authority.suspendMutations()
    auth.resolve(true)
    expect(await write).toEqual({ status: 'unavailable' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(fence.release()).toBe(true)
  } finally {
    auth.resolve(false)
    authority.dispose()
  }
})

it('keeps the fence closed if an in-flight write cannot be drained', async () => {
  vi.useFakeTimers()
  const pending = deferred<unknown>()
  const entered = deferred<void>()
  const { authority, open } = fixture(async () => {
    entered.resolve()
    return await pending.promise
  })
  try {
    const invocation = (await open())!
    const write = authority.call(invocation, 'fixture', 'write')
    await entered.promise
    const rejected = expect(authority.suspendMutations(100)).rejects.toThrow('renderer-mutation-fence-unavailable')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(await open()).toBeUndefined()
    pending.resolve('possibly committed')
    expect(await write).toEqual({ status: 'unknown' })
  } finally {
    pending.resolve(undefined)
    authority.dispose()
  }
})

it('rejects a reentrant fence instead of waiting on its own write', async () => {
  let authority!: ManagerRendererSessions
  const test = fixture(async () => {
    await expect(authority.suspendMutations()).rejects.toThrow('renderer-mutation-fence-unavailable')
    return 'written'
  })
  authority = test.authority
  try {
    const invocation = (await test.open())!
    expect(await authority.call(invocation, 'fixture', 'write')).toEqual({ status: 'ok', value: 'written' })
    const fence = await authority.suspendMutations()
    expect(fence.release()).toBe(true)
  } finally {
    authority.dispose()
  }
})

it('keeps the Manager write fence closed when a consumer cannot confirm cleanup', async () => {
  const participants = new ServiceRendererParticipants({
    homeDigest: 'a'.repeat(64),
    ownerAppId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
  })
  participants.bind({
    snapshot: () => ({ active: { plugins: [] }, registryEpoch: 0 }) as never,
    attach: async () => {},
  })
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
  })
  try {
    const id = secret()
    const handle = (await authority.open(gateway, id))!
    const peer = participants.peer(handle.rendererId)!
    const pending = fenceManagerConsumers({ sessions: authority, participants })
    const rejected = expect(pending).rejects.toThrow('manager-consumer-fence-unavailable')
    const command = await peer.next()
    peer.acknowledge({ id: command!.id, sequence: command!.sequence, ok: false })
    await rejected
    expect(await authority.open(gateway, secret())).toBeUndefined()
    expect(await authority.call({ gateway, browserSessionId: id, handle }, 'fixture', 'write'))
      .toEqual({ status: 'unavailable' })
  } finally {
    authority.dispose()
    participants.close()
  }
})
