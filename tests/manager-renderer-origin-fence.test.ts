import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'

const secret = () => randomBytes(32).toString('hex')
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(dispatch: (value: string) => Promise<unknown>) {
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([['fixture', {
      prepare: value =>
        value === 'read'
          ? { mode: 'read' as const, dispatch: async () => 'read' }
          : { mode: 'write' as const, dispatch: async () => await dispatch(String(value)) },
    }]]),
  })
  const open = async () => {
    const browserSessionId = secret()
    const handle = await authority.open(gateway, browserSessionId)
    return handle && { gateway, browserSessionId, handle }
  }
  return { authority, open }
}

it('drains other writes while the originating renderer remains available for its receipt', async () => {
  const peerStarted = deferred<void>()
  const peerDone = deferred<void>()
  const originStarted = deferred<void>()
  const acquired = deferred<string>()
  const finish = deferred<void>()
  let authority!: ManagerRendererSessions
  const test = fixture(async value => {
    if (value === 'peer') {
      peerStarted.resolve()
      await peerDone.promise
      return 'peer complete'
    }
    originStarted.resolve()
    const fence = await authority.suspendMutationsForCurrentWrite()
    acquired.resolve(fence.rendererId)
    await finish.promise
    expect(fence.isCurrent()).toBe(true)
    expect(fence.release()).toBe(true)
    return 'origin complete'
  })
  authority = test.authority
  try {
    const peer = (await test.open())!
    const origin = (await test.open())!
    const peerWrite = authority.call(peer, 'fixture', 'peer')
    await peerStarted.promise
    const originWrite = authority.call(origin, 'fixture', 'origin')
    await originStarted.promise
    expect(authority.mutationAvailability()).toBe('busy')
    expect(await authority.call(peer, 'fixture', 'blocked')).toEqual({ status: 'unavailable' })
    expect(await authority.call(origin, 'fixture', 'read')).toEqual({ status: 'ok', value: 'read' })
    expect(await test.open()).toBeUndefined()
    let ready = false
    void acquired.promise.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    peerDone.resolve()
    expect(await peerWrite).toEqual({ status: 'ok', value: 'peer complete' })
    expect(await acquired.promise).toBe(origin.handle.rendererId)
    finish.resolve()
    expect(await originWrite).toEqual({ status: 'ok', value: 'origin complete' })
    expect(await test.open()).toBeDefined()
  } finally {
    peerDone.resolve()
    finish.resolve()
    authority.dispose()
  }
})

it('rejects a stale async context after its originating write has returned', async () => {
  const later = deferred<void>()
  let late!: Promise<unknown>
  let authority!: ManagerRendererSessions
  const test = fixture(async () => {
    late = later.promise.then(async () => await authority.suspendMutationsForCurrentWrite())
    return 'complete'
  })
  authority = test.authority
  try {
    const origin = (await test.open())!
    expect(await authority.call(origin, 'fixture', 'origin')).toEqual({ status: 'ok', value: 'complete' })
    const rejected = expect(late).rejects.toThrow('renderer-mutation-fence-unavailable')
    later.resolve()
    await rejected
    expect(authority.mutationAvailability()).toBe('available')
    expect(await test.open()).toBeDefined()
  } finally {
    later.resolve()
    authority.dispose()
  }
})

it('does not report success if the originating write leaves its fence unreleased', async () => {
  let authority!: ManagerRendererSessions
  const test = fixture(async () => {
    await authority.suspendMutationsForCurrentWrite()
    return 'possibly committed'
  })
  authority = test.authority
  try {
    const origin = (await test.open())!
    expect(await authority.call(origin, 'fixture', 'origin')).toEqual({ status: 'unknown' })
    expect(authority.mutationAvailability()).toBe('unavailable')
    expect(await test.open()).toBeUndefined()
  } finally {
    authority.dispose()
  }
})

it('fences the handoff if its originating renderer disconnects', async () => {
  const acquired = deferred<void>()
  const finish = deferred<void>()
  let authority!: ManagerRendererSessions
  const test = fixture(async () => {
    const fence = await authority.suspendMutationsForCurrentWrite()
    acquired.resolve()
    await finish.promise
    expect(fence.isCurrent()).toBe(false)
    expect(fence.release()).toBe(false)
    return 'possibly committed'
  })
  authority = test.authority
  try {
    const origin = (await test.open())!
    const write = authority.call(origin, 'fixture', 'origin')
    await acquired.promise
    const closing = authority.close(origin)
    finish.resolve()
    expect(await write).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    expect(await test.open()).toBeUndefined()
  } finally {
    finish.resolve()
    authority.dispose()
  }
})

it('stops waiting immediately when the origin disconnects during another write', async () => {
  const peerStarted = deferred<void>()
  const peerDone = deferred<void>()
  const originStarted = deferred<void>()
  let authority!: ManagerRendererSessions
  const test = fixture(async value => {
    if (value === 'peer') {
      peerStarted.resolve()
      await peerDone.promise
      return 'possibly committed'
    }
    originStarted.resolve()
    await authority.suspendMutationsForCurrentWrite()
    return 'unexpected'
  })
  authority = test.authority
  try {
    const peer = (await test.open())!
    const origin = (await test.open())!
    const peerWrite = authority.call(peer, 'fixture', 'peer')
    await peerStarted.promise
    const originWrite = authority.call(origin, 'fixture', 'origin')
    await originStarted.promise
    const closing = authority.close(origin)
    const result = await Promise.race([
      originWrite,
      new Promise(resolve => setTimeout(() => resolve('timed out'), 500)),
    ])
    expect(result).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    expect(await test.open()).toBeUndefined()
    peerDone.resolve()
    expect(await peerWrite).toEqual({ status: 'unknown' })
  } finally {
    peerDone.resolve()
    authority.dispose()
  }
})

it('fences the origin if another dispatched write has an uncertain result', async () => {
  const peerStarted = deferred<void>()
  const peerDone = deferred<void>()
  const originStarted = deferred<void>()
  let authority!: ManagerRendererSessions
  const test = fixture(async value => {
    if (value === 'peer') {
      peerStarted.resolve()
      await peerDone.promise
      throw new Error('lost result')
    }
    originStarted.resolve()
    await authority.suspendMutationsForCurrentWrite()
    return 'unexpected'
  })
  authority = test.authority
  try {
    const peer = (await test.open())!
    const origin = (await test.open())!
    const peerWrite = authority.call(peer, 'fixture', 'peer')
    await peerStarted.promise
    const originWrite = authority.call(origin, 'fixture', 'origin')
    await originStarted.promise
    peerDone.resolve()
    expect(await peerWrite).toEqual({ status: 'unknown' })
    expect(await originWrite).toEqual({ status: 'unknown' })
    expect(await test.open()).toBeUndefined()
  } finally {
    peerDone.resolve()
    authority.dispose()
  }
})

it('blocks admission of a previously opened renderer until the fence is released', async () => {
  const participants = new ServiceRendererParticipants({
    homeDigest: 'a'.repeat(64),
    ownerAppId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
  })
  const snapshot = { active: { plugins: [] }, registryEpoch: 0 } as never
  let attachments = 0
  participants.bind({
    snapshot: () => snapshot,
    attach: async () => {
      attachments++
    },
  })
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    participants.confirmBootstrap(handle.rendererId, snapshot)
    const invocation = { gateway, browserSessionId, handle }
    const fence = await authority.suspendMutations()
    expect(await authority.admit(invocation)).toEqual({ status: 'unavailable' })
    expect(attachments).toBe(0)
    expect(fence.release()).toBe(true)
    expect(await authority.admit(invocation)).toEqual({ status: 'ok', value: { admitted: true } })
    expect(attachments).toBe(1)
  } finally {
    authority.dispose()
    participants.close()
  }
})

it('drains an admission already in flight before the fence becomes usable', async () => {
  const participants = new ServiceRendererParticipants({
    homeDigest: 'a'.repeat(64),
    ownerAppId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
  })
  const snapshot = { active: { plugins: [] }, registryEpoch: 0 } as never
  const entered = deferred<void>()
  const finish = deferred<void>()
  participants.bind({
    snapshot: () => snapshot,
    attach: async () => {
      entered.resolve()
      await finish.promise
    },
  })
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    participants.confirmBootstrap(handle.rendererId, snapshot)
    const admission = authority.admit({ gateway, browserSessionId, handle })
    await entered.promise
    let ready = false
    const pending = authority.suspendMutations().then(fence => {
      ready = true
      return fence
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(await authority.open(gateway, secret())).toBeUndefined()
    finish.resolve()
    expect(await admission).toEqual({ status: 'unavailable' })
    const fence = await pending
    expect(fence.isCurrent()).toBe(true)
    expect(fence.release()).toBe(true)
  } finally {
    finish.resolve()
    authority.dispose()
    participants.close()
  }
})

it('does not wait on its own retirement if the origin disappears during peer cleanup', async () => {
  const participants = new ServiceRendererParticipants({
    homeDigest: 'a'.repeat(64),
    ownerAppId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
  })
  const snapshot = { active: { plugins: [] }, registryEpoch: 0 } as never
  const entered = deferred<void>()
  const finishAdmission = deferred<void>()
  const cleanupStarted = deferred<void>()
  const finishCleanup = deferred<boolean>()
  let peerRenderer = ''
  participants.bind({
    snapshot: () => snapshot,
    attach: async peer => {
      if (peer.identity.rendererId === peerRenderer) {
        entered.resolve()
        await finishAdmission.promise
      }
    },
  })
  let authority!: ManagerRendererSessions
  authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    waitForRetirement: async rendererId => {
      if (rendererId !== peerRenderer) return true
      cleanupStarted.resolve()
      return await finishCleanup.promise
    },
    channels: new Map([['fixture', {
      prepare: () => ({
        mode: 'write' as const,
        dispatch: async () => {
          await authority.suspendMutationsForCurrentWrite()
          return 'unexpected'
        },
      }),
    }]]),
  })
  try {
    const peerId = secret()
    const peer = (await authority.open(gateway, peerId))!
    peerRenderer = peer.rendererId
    participants.confirmBootstrap(peer.rendererId, snapshot)
    const originId = secret()
    const origin = (await authority.open(gateway, originId))!
    participants.confirmBootstrap(origin.rendererId, snapshot)
    expect(await authority.admit({ gateway, browserSessionId: originId, handle: origin }))
      .toEqual({ status: 'ok', value: { admitted: true } })
    const admission = authority.admit({ gateway, browserSessionId: peerId, handle: peer })
    await entered.promise
    const invocation = { gateway, browserSessionId: originId, handle: origin }
    const write = authority.call(invocation, 'fixture', 'origin')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(authority.mutationAvailability()).toBe('busy')
    finishAdmission.resolve()
    expect(await admission).toEqual({ status: 'unavailable' })
    await cleanupStarted.promise
    const closing = authority.close(invocation)
    const result = await Promise.race([write, new Promise(resolve => setTimeout(() => resolve('timed out'), 500))])
    expect(result).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    finishCleanup.resolve(true)
  } finally {
    finishAdmission.resolve()
    finishCleanup.resolve(false)
    authority.dispose()
    participants.close()
  }
})

it('does not give a handoff fence to an unadmitted renderer', async () => {
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
  let authority!: ManagerRendererSessions
  authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    channels: new Map([['fixture', {
      prepare: () => ({
        mode: 'write' as const,
        dispatch: async () => {
          await expect(authority.suspendMutationsForCurrentWrite()).rejects.toThrow(
            'renderer-mutation-fence-unavailable',
          )
          return 'not dispatched'
        },
      }),
    }]]),
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    expect(await authority.call({ gateway, browserSessionId, handle }, 'fixture', 'origin'))
      .toEqual({ status: 'ok', value: 'not dispatched' })
    expect(authority.mutationAvailability()).toBe('available')
  } finally {
    authority.dispose()
    participants.close()
  }
})
