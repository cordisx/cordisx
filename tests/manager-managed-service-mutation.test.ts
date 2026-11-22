import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { coordinateManagerManagedServiceMutations } from '../packages/cli/src/cli/manager-managed-service-mutation.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const secret = () => randomBytes(32).toString('hex')
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
const request = (requestId: string) => JSON.stringify({ requestId, operation: 'authenticate' })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

function fixture(dispatch: () => Promise<unknown>) {
  const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
  const lifecycle = new ServiceRendererLifecycle({
    scope,
    projectMutation: async () => {
      throw new Error('unused')
    },
  })
  lifecycle.initialize({
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: scope.profileId,
    runtimeGeneration: scope.generation,
    revision: 0,
    lastGoodRevision: 0,
    plugins: [],
  })
  const participants = new ServiceRendererParticipants(scope)
  participants.bind(lifecycle)
  let sessions!: ManagerRendererSessions
  const channel = coordinateManagerManagedServiceMutations({
    channel: { prepare: () => ({ mode: 'write', dispatch }) },
    sessions: () => sessions,
    participants,
    lifecycle,
  })
  sessions = new ManagerRendererSessions({
    profileId: scope.profileId,
    ownerGeneration: scope.generation,
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    channels: new Map([['managed-service-ui', channel]]),
  })
  const open = async () => {
    const browserSessionId = secret()
    const handle = (await sessions.open(gateway, browserSessionId))!
    const invocation = { gateway, browserSessionId, handle }
    participants.confirmBootstrap(handle.rendererId, lifecycle.snapshot())
    const admission = sessions.admit(invocation)
    const peer = participants.peer(handle.rendererId)!
    const synchronize = (await peer.next())!
    expect(peer.acknowledge({
      id: synchronize.id,
      sequence: synchronize.sequence,
      ok: true,
      value: synchronize.payload,
    })).toBe(true)
    expect(await admission).toMatchObject({ status: 'ok' })
    return invocation
  }
  return { lifecycle, participants, sessions, open }
}

it('reserves a single Manager for login and refuses a second Manager before dispatch', async () => {
  const entered = deferred<void>()
  const finish = deferred<void>()
  const dispatch = vi.fn(async () => {
    entered.resolve()
    await finish.promise
    return { requestId: 'first', ok: true }
  })
  const f = fixture(dispatch)
  try {
    const first = await f.open()
    const action = f.sessions.call(first, 'managed-service-ui', request('first'))
    await entered.promise
    expect(await f.sessions.open(gateway, secret())).toBeUndefined()
    expect(() => f.lifecycle.prepare('blocked')).toThrow('service renderer fence is active')
    finish.resolve()
    expect(await action).toEqual({ status: 'ok', value: { requestId: 'first', ok: true } })
    const second = await f.open()
    expect(await f.sessions.call(first, 'managed-service-ui', request('second'))).toEqual({
      status: 'ok',
      value: { requestId: 'second', ok: false, code: 'owner-unavailable' },
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(await f.sessions.close(second)).toBe(true)
  } finally {
    finish.resolve()
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('fences an uncertain login if its originating Manager disconnects', async () => {
  const entered = deferred<void>()
  const finish = deferred<void>()
  const f = fixture(async () => {
    entered.resolve()
    await finish.promise
    return { requestId: 'interrupted', ok: true }
  })
  try {
    const first = await f.open()
    const action = f.sessions.call(first, 'managed-service-ui', request('interrupted'))
    await entered.promise
    const closing = f.sessions.close(first)
    finish.resolve()
    expect(await action).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
    finish.resolve()
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('does not dispatch writes without an owner lifecycle reservation', async () => {
  const dispatch = vi.fn()
  const channel = coordinateManagerManagedServiceMutations({
    channel: { prepare: () => ({ mode: 'write', dispatch }) },
    sessions: () => {
      throw new Error('unused')
    },
  })
  const prepared = channel.prepare(request('blocked'), {
    profileId: 'work',
    rendererId: secret(),
    ownerGeneration: 'owner-1',
    signal: new AbortController().signal,
  })
  expect(prepared.mode).toBe('read')
  expect(await prepared.dispatch()).toEqual({ requestId: 'blocked', ok: false, code: 'unsupported' })
  expect(dispatch).not.toHaveBeenCalled()
})
