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

function fixture(dispatch: (requestId: string) => Promise<unknown>, action: 'login' | 'logout' = 'login') {
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
  let clientsAvailable = true
  const reservations: Array<{ fenced: boolean; released: boolean }> = []
  const channel = coordinateManagerManagedServiceMutations({
    channel: {
      prepare: payload => ({
        mode: 'write',
        managedServiceAuthentication: {
          pluginId: 'fixture',
          pluginGeneration: 'plugin-1',
          serviceId: 'gateway',
          expectedSequence: 1,
          action,
        },
        dispatch: async () => await dispatch((JSON.parse(String(payload)) as { requestId: string }).requestId),
      }),
    },
    sessions: () => sessions,
    participants,
    lifecycle,
    reserveServiceClients: () => {
      if (!clientsAvailable) return undefined
      const state = { fenced: false, released: false }
      reservations.push(state)
      return {
        isCurrent: () => !state.fenced && !state.released,
        release: () => {
          state.released = true
          return true
        },
        fence: () => {
          state.fenced = true
        },
      }
    },
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
  return {
    lifecycle,
    participants,
    sessions,
    open,
    reservations,
    busy: () => {
      clientsAvailable = false
    },
  }
}

it.each(['login', 'logout'] as const)('reserves the Manager cohort around %s and waits for readback', async action => {
  const entered = deferred<void>()
  const finish = deferred<void>()
  const dispatch = vi.fn(async (requestId: string) => {
    entered.resolve()
    await finish.promise
    return { requestId, ok: true, value: { status: 'accepted', sequence: 2 } }
  })
  const f = fixture(dispatch, action)
  try {
    const first = await f.open()
    const firstAction = f.sessions.call(first, 'managed-service-ui', request('first'))
    await entered.promise
    expect(await f.sessions.open(gateway, secret())).toBeUndefined()
    expect(() => f.lifecycle.prepare('blocked')).toThrow('service renderer fence is active')
    finish.resolve()
    expect(await firstAction).toEqual({
      status: 'ok',
      value: { requestId: 'first', ok: true, value: { status: 'accepted', sequence: 2 } },
    })
    const second = await f.open()
    const peer = f.participants.peer(second.handle.rendererId)!
    const coordinated = f.sessions.call(first, 'managed-service-ui', request('second'))
    const before = (await peer.next())!
    expect(before).toMatchObject({
      method: 'managed-service-state',
      payload: { phase: 'prepare', sequence: 1, action },
    })
    expect(peer.acknowledge({
      id: before.id,
      sequence: before.sequence,
      ok: true,
      value: { ...before.payload as object, confirmed: true },
    })).toBe(true)
    const after = (await peer.next())!
    expect(after).toMatchObject({ method: 'managed-service-state', payload: { phase: 'confirm', sequence: 2, action } })
    expect(peer.acknowledge({
      id: after.id,
      sequence: after.sequence,
      ok: true,
      value: { ...after.payload as object, confirmed: true },
    })).toBe(true)
    expect(await coordinated).toMatchObject({ status: 'ok', value: { requestId: 'second', ok: true } })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const refused = f.sessions.call(first, 'managed-service-ui', request('third'))
    const stale = (await peer.next())!
    expect(peer.acknowledge({
      id: stale.id,
      sequence: stale.sequence,
      ok: true,
      value: { ...stale.payload as object, confirmed: false },
    })).toBe(true)
    expect(await refused).toEqual({
      status: 'ok',
      value: { requestId: 'third', ok: false, code: 'owner-unavailable' },
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(await f.sessions.close(second)).toBe(true)
  } finally {
    finish.resolve()
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('fences login when another Manager cannot confirm the resulting state', async () => {
  const f = fixture(async requestId => ({ requestId, ok: true, value: { status: 'accepted', sequence: 2 } }))
  try {
    const first = await f.open()
    const second = await f.open()
    const peer = f.participants.peer(second.handle.rendererId)!
    const action = f.sessions.call(first, 'managed-service-ui', request('uncertain'))
    const before = (await peer.next())!
    expect(peer.acknowledge({
      id: before.id,
      sequence: before.sequence,
      ok: true,
      value: { ...before.payload as object, confirmed: true },
    })).toBe(true)
    const after = (await peer.next())!
    expect(peer.acknowledge({
      id: after.id,
      sequence: after.sequence,
      ok: true,
      value: { ...after.payload as object, confirmed: false },
    })).toBe(true)
    expect(await action).toEqual({ status: 'unknown' })
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('does not dispatch logout while an affected terminal lease cannot be reserved', async () => {
  const dispatch = vi.fn(async () => ({ requestId: 'blocked', ok: true, value: { status: 'accepted', sequence: 2 } }))
  const f = fixture(dispatch, 'logout')
  try {
    const first = await f.open()
    f.busy()
    expect(await f.sessions.call(first, 'managed-service-ui', request('blocked'))).toEqual({
      status: 'ok',
      value: { requestId: 'blocked', ok: false, code: 'owner-unavailable' },
    })
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('keeps the terminal reservation fenced when a dispatched logout loses its receipt', async () => {
  const f = fixture(async () => {
    throw new Error('receipt lost')
  }, 'logout')
  try {
    const first = await f.open()
    expect(await f.sessions.call(first, 'managed-service-ui', request('uncertain-logout'))).toEqual({
      status: 'unknown',
    })
    expect(f.reservations).toEqual([{ fenced: true, released: false }])
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
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
    return { requestId: 'interrupted', ok: true, value: { status: 'accepted', sequence: 2 } }
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
