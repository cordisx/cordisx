import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { fenceManagerConsumers } from '../packages/cli/src/cli/manager-consumer-fence.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'

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

it('waits for renderer cleanup before acknowledging revocation or admitting another session', async () => {
  const cleanup = deferred<boolean>()
  const waitForRetirement = vi.fn(async () => await cleanup.promise)
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    waitForRetirement,
    channels: new Map([['fixture', {
      prepare: value =>
        value === 'write'
          ? { mode: 'write' as const, dispatch: async () => 'written' }
          : { mode: 'read' as const, dispatch: async () => 'read' },
    }]]),
  })
  const browserSessionId = secret()
  try {
    expect(await authority.open(gateway, browserSessionId)).toBeDefined()
    const secondId = secret()
    const secondHandle = (await authority.open(gateway, secondId))!
    const second = { gateway, browserSessionId: secondId, handle: secondHandle }
    const first = authority.revoke(gateway, browserSessionId)
    const duplicate = authority.revoke(gateway, browserSessionId)
    await vi.waitFor(() => expect(waitForRetirement).toHaveBeenCalledOnce())
    expect(authority.hasLiveRenderers()).toBe(true)
    let opened = false
    const opening = authority.open(gateway, secret()).then(value => {
      opened = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(opened).toBe(false)
    expect(await authority.call(second, 'fixture', 'read')).toEqual({ status: 'ok', value: 'read' })
    expect(await authority.call(second, 'fixture', 'write')).toEqual({ status: 'unavailable' })
    await expect(authority.suspendMutations()).rejects.toThrow('renderer-mutation-fence-unavailable')
    cleanup.resolve(true)
    expect(await first).toBe(true)
    expect(await duplicate).toBe(true)
    expect(await opening).toBeDefined()
    expect(await authority.call(second, 'fixture', 'write')).toEqual({ status: 'ok', value: 'written' })
    expect(await authority.open(gateway, secret())).toBeDefined()
  } finally {
    cleanup.resolve(false)
    authority.dispose()
  }
})

it('keeps renderer admission closed when cleanup cannot be confirmed', async () => {
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    waitForRetirement: async () => false,
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    expect(await authority.close({ gateway, browserSessionId, handle })).toBe(false)
    expect(authority.mutationAvailability()).toBe('unavailable')
    expect(await authority.open(gateway, secret())).toBeUndefined()
  } finally {
    authority.dispose()
  }
})

it('waits for resource retirement after a Manager quiescence receipt', async () => {
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
  const cleanup = deferred<boolean>()
  const waitForRetirement = vi.fn(async () => await cleanup.promise)
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    waitForRetirement,
  })
  try {
    const id = secret()
    const handle = (await authority.open(gateway, id))!
    const peer = participants.peer(handle.rendererId)!
    const fencing = fenceManagerConsumers({ sessions: authority, participants })
    const command = (await peer.next())!
    const payload = command.payload as { fenceId: string }
    peer.acknowledge({
      id: command.id,
      sequence: command.sequence,
      ok: true,
      value: { fenceId: payload.fenceId, rendererId: handle.rendererId, ownerGeneration: 'owner-1', quiesced: true },
    })
    peer.close()
    await vi.waitFor(() => expect(waitForRetirement).toHaveBeenCalledOnce())
    let ready = false
    void fencing.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    cleanup.resolve(true)
    const fence = await fencing
    expect(fence.release()).toBe(true)
  } finally {
    cleanup.resolve(false)
    authority.dispose()
    participants.close()
  }
})

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
    const closing = authority.close(invocation)
    pending.resolve('possibly committed')
    expect(await write).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    await rejected
    expect(await open()).toBeUndefined()
  } finally {
    pending.resolve(undefined)
    authority.dispose()
  }
})

it('retires other sessions after a dispatched write loses its result', async () => {
  const pending = deferred<unknown>()
  const dispatch = vi.fn(async () => await pending.promise)
  const { authority, open } = fixture(dispatch)
  try {
    const first = (await open())!
    const second = (await open())!
    const write = authority.call(first, 'fixture', 'write')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    const closing = authority.close(first)
    pending.resolve('possibly committed')
    expect(await write).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    expect(await authority.call(second, 'fixture', 'read')).toEqual({ status: 'unavailable' })
    expect(await authority.call(second, 'fixture', 'write')).toEqual({ status: 'unavailable' })
    expect(await open()).toBeUndefined()
  } finally {
    pending.resolve(undefined)
    authority.dispose()
  }
})

it('does not acknowledge retirement while a dispatched write is unresolved', async () => {
  const pending = deferred<unknown>()
  const dispatch = vi.fn(async () => await pending.promise)
  const cleanupStarted = deferred<void>()
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    waitForRetirement: async () => {
      cleanupStarted.resolve()
      return true
    },
    channels: new Map([['fixture', {
      prepare: () => ({ mode: 'write', dispatch }),
    }]]),
  })
  const open = async () => {
    const browserSessionId = secret()
    const handle = await authority.open(gateway, browserSessionId)
    return handle && { gateway, browserSessionId, handle }
  }
  try {
    const first = (await open())!
    const second = (await open())!
    const write = authority.call(first, 'fixture', {})
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    let closed = false
    const closing = authority.close(first).then(result => {
      closed = true
      return result
    })
    await cleanupStarted.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(await authority.call(second, 'fixture', {})).toEqual({ status: 'unavailable' })
    let opened = false
    const opening = open().then(value => {
      opened = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(opened).toBe(false)
    pending.resolve('possibly committed')
    expect(await write).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    expect(await opening).toBeUndefined()
    expect(await open()).toBeUndefined()
  } finally {
    pending.resolve(undefined)
    authority.dispose()
  }
})

it('does not acknowledge retirement while a dispatched read still owns resources', async () => {
  const pending = deferred<unknown>()
  const entered = deferred<void>()
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([['fixture', {
      prepare: () => ({
        mode: 'read',
        dispatch: async () => {
          entered.resolve()
          return await pending.promise
        },
      }),
    }]]),
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    const invocation = { gateway, browserSessionId, handle }
    const reading = authority.call(invocation, 'fixture', {})
    await entered.promise
    let closed = false
    const closing = authority.close(invocation).then(result => {
      closed = true
      return result
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    let opened = false
    const opening = authority.open(gateway, secret()).then(value => {
      opened = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(opened).toBe(false)
    pending.resolve('read complete')
    expect(await reading).toEqual({ status: 'unavailable' })
    expect(await closing).toBe(true)
    expect(await opening).toBeDefined()
    expect(await authority.open(gateway, secret())).toBeDefined()
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

it('rejects a mismatched lifecycle without freezing an unrelated Manager authority', async () => {
  const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
  const participants = new ServiceRendererParticipants(scope)
  participants.bind({
    snapshot: () => ({ active: { plugins: [] }, registryEpoch: 0 }) as never,
    attach: async () => {},
  })
  const lifecycle = new ServiceRendererLifecycle({ scope })
  const { authority, open } = fixture(async () => 'written')
  try {
    await expect(fenceManagerConsumers({ sessions: authority, participants, lifecycle }))
      .rejects.toThrow('manager-consumer-fence-scope-invalid')
    expect(await open()).toBeDefined()
  } finally {
    authority.dispose()
    participants.close()
    await lifecycle.close()
  }
})
