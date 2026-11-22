import { rm } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { ManagedServiceLeaseV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import {
  reserveActiveManagedServiceClients,
  reserveManagedServiceClients,
} from '../packages/cli/src/launcher/managed-service-client-reservation.js'
import { declaration, deferred, definition, fixture, owner, runtime } from './managed-service-runtime-fixture.js'

const identity = { pluginId: 'borrow-plugin', pluginGeneration: 'generation-one', serviceId: 'gateway' }
const policy = {
  operations: ['models.list'],
  allows: (operation: string, value: unknown) => operation === 'models.list' && value === undefined,
}

async function setup(fetch?: typeof globalThis.fetch) {
  const { root, home } = await fixture()
  const host = runtime(home, fetch === undefined ? {} : { fetch })
  const plugin = host.bind({
    owner: owner(identity.pluginId, identity.pluginGeneration),
    source: 'https://plugins.example.test/borrow',
    declaration: declaration(identity.serviceId, identity.pluginId, [
      { pluginId: identity.pluginId, operations: ['models.list', 'models.other'] },
      { pluginId: 'other-plugin', operations: ['models.list'] },
    ]),
    artifactDirectory: root,
  }, new AbortController().signal)
  const other = host.bind({
    owner: owner('other-plugin', 'other-generation'),
    source: 'https://plugins.example.test/other',
    declaration: declaration('other-service', 'other-plugin', []),
    artifactDirectory: root,
  }, new AbortController().signal)
  const stale = host.bind({
    owner: owner(identity.pluginId, 'other-generation'),
    source: 'https://plugins.example.test/borrow',
    declaration: declaration('other-service', identity.pluginId, []),
    artifactDirectory: root,
  }, new AbortController().signal)
  const service = definition(identity.serviceId)
  const registration = await plugin.registry.register({
    ...service,
    operations: [...service.operations, { ...service.operations[0]!, operationId: 'models.other' }],
  }, { revision: 'sha256:8888888888888888888888888888888888888888888888888888888888888888' })
  if ((await registration.ensureReady()).status !== 'ready') throw new Error('fixture service failed to start')
  return {
    host,
    plugin,
    other,
    stale,
    registration,
    async close() {
      await stale.dispose()
      await other.dispose()
      await plugin.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

it('borrows only the owner service while other clients remain blocked', async () => {
  const f = await setup()
  const entered = deferred<void>()
  const proceed = deferred<void>()
  const late = deferred<void>()
  let lateResult!: Promise<string>
  let terminalCurrent = true
  const terminal = {
    isCurrent: () => terminalCurrent,
    release: () => {
      terminalCurrent = false
      return true
    },
    fence: () => {
      terminalCurrent = false
    },
  }
  const active = {
    record: { plugins: [{ id: identity.pluginId, enabled: true, moduleGeneration: identity.pluginGeneration }] },
    activation: { reserveServiceClients: () => f.host.reserveServiceClients(identity) },
  }
  try {
    const reservation = reserveManagedServiceClients(identity, [
      () => terminal,
      value => reserveActiveManagedServiceClients(active, value, () => true),
    ])!
    const action = reservation.runBorrowed!(policy, async () => {
      const acquired = await f.plugin.client.acquire(f.registration.binding.identity)
      if (acquired.status !== 'ready') throw new Error('borrowed lease unavailable')
      expect(acquired.lease.operations).toEqual(['models.list'])
      entered.resolve()
      await proceed.promise
      expect((await f.plugin.client.invoke(acquired.lease, 'models.list')).status).toBe('accepted')
      f.plugin.client.release(acquired.lease)
      lateResult = late.promise.then(async () =>
        (await f.plugin.client.acquire(f.registration.binding.identity)).status
      )
      return 'confirmed'
    })
    await entered.promise
    expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
    expect((await f.other.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
    proceed.resolve()
    expect(await action).toBe('confirmed')
    expect(reservation.release()).toBe(true)
    late.resolve()
    expect(await lateResult).toBe('unavailable')
    const resumed = await f.plugin.client.acquire(f.registration.binding.identity)
    expect(resumed.status).toBe('ready')
    if (resumed.status === 'ready') f.plugin.client.release(resumed.lease)
  } finally {
    proceed.resolve()
    late.resolve()
    await f.close()
  }
}, 20_000)

it.each(['other-plugin', 'other-generation'] as const)(
  'rejects %s even when that client normally has a consumer grant',
  async actor => {
    const f = await setup()
    try {
      const client = actor === 'other-plugin' ? f.other.client : f.stale.client
      const ordinary = await client.acquire(f.registration.binding.identity)
      if (ordinary.status !== 'ready') throw new Error('fixture grant unavailable')
      client.release(ordinary.lease)
      const reservation = f.host.reserveServiceClients(identity)!
      let observed = ''
      await expect(reservation.runBorrowed!(policy, async () => {
        observed = (await client.acquire(f.registration.binding.identity)).status
      })).rejects.toThrow('managed-service-borrow-uncertain')
      expect(observed).toBe('unavailable')
      expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
    } finally {
      await f.close()
    }
  },
  20_000,
)

it.each(['operation', 'value', 'materialization', 'repeat'] as const)(
  'fences a borrowed action that attempts an unauthorized %s',
  async violation => {
    let modelRequests = 0
    const f = await setup(async (input, init) => {
      if (new URL(String(input)).pathname === '/v1/models') modelRequests++
      return await globalThis.fetch(input, init)
    })
    try {
      const before = modelRequests
      const reservation = f.host.reserveServiceClients(identity)!
      let observed = ''
      await expect(reservation.runBorrowed!(policy, async () => {
        const acquired = await f.plugin.client.acquire(f.registration.binding.identity)
        if (acquired.status !== 'ready') throw new Error('borrowed lease unavailable')
        if (violation === 'repeat') {
          expect((await f.plugin.client.invoke(acquired.lease, 'models.list')).status).toBe('accepted')
        }
        const result = violation === 'materialization'
          ? await f.plugin.client.materialize({
            target: f.registration.binding,
            revision: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
            sources: [{ source: 'fixture', lease: acquired.lease }],
            bindings: [],
          })
          : await f.plugin.client.invoke(
            acquired.lease,
            violation === 'operation' ? 'models.other' : 'models.list',
            violation === 'value' ? { unexpected: true } : undefined,
          )
        observed = result.status
        f.plugin.client.release(acquired.lease)
      })).rejects.toThrow('managed-service-borrow-uncertain')
      expect(observed).toBe('unavailable')
      expect(modelRequests).toBe(before + (violation === 'repeat' ? 1 : 0))
      expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
    } finally {
      await f.close()
    }
  },
  20_000,
)

it('revokes an unreleased borrowed lease and keeps the service fenced', async () => {
  const f = await setup()
  let escaped!: ManagedServiceLeaseV1
  try {
    const reservation = f.host.reserveServiceClients(identity)!
    await expect(reservation.runBorrowed!(policy, async () => {
      const acquired = await f.plugin.client.acquire(f.registration.binding.identity)
      if (acquired.status !== 'ready') throw new Error('borrowed lease unavailable')
      escaped = acquired.lease
    })).rejects.toThrow('managed-service-borrow-uncertain')
    expect((await f.plugin.client.invoke(escaped, 'models.list')).status).toBe('stale-generation')
    expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
  } finally {
    await f.close()
  }
}, 20_000)

it('does not release a reservation while its owner action is still running', async () => {
  const f = await setup()
  const entered = deferred<void>()
  const proceed = deferred<void>()
  try {
    const reservation = f.host.reserveServiceClients(identity)!
    const action = reservation.runBorrowed!(policy, async () => {
      entered.resolve()
      await proceed.promise
    })
    await entered.promise
    expect(reservation.release()).toBe(false)
    proceed.resolve()
    await expect(action).rejects.toThrow('managed-service-borrow-uncertain')
    expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
  } finally {
    proceed.resolve()
    await f.close()
  }
}, 20_000)

it('stops a borrowed invocation when the active plugin generation changes', async () => {
  let modelRequests = 0
  const f = await setup(async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/models') modelRequests++
    return await globalThis.fetch(input, init)
  })
  const entered = deferred<void>()
  const proceed = deferred<void>()
  let active = true
  let observed = ''
  try {
    const state = {
      record: { plugins: [{ id: identity.pluginId, enabled: true, moduleGeneration: identity.pluginGeneration }] },
      activation: { reserveServiceClients: () => f.host.reserveServiceClients(identity) },
    }
    const reservation = reserveActiveManagedServiceClients(state, identity, () => active)!
    const action = reservation.runBorrowed!(policy, async () => {
      const acquired = await f.plugin.client.acquire(f.registration.binding.identity)
      if (acquired.status !== 'ready') throw new Error('borrowed lease unavailable')
      entered.resolve()
      await proceed.promise
      observed = (await f.plugin.client.invoke(acquired.lease, 'models.list')).status
      f.plugin.client.release(acquired.lease)
    })
    await entered.promise
    active = false
    proceed.resolve()
    await expect(action).rejects.toThrow('managed-service-borrow-uncertain')
    expect(observed).toBe('stale-generation')
    expect(modelRequests).toBe(0)
    expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
  } finally {
    proceed.resolve()
    await f.close()
  }
}, 20_000)

it('aborts and fences an invocation left running after the action returns', async () => {
  const entered = deferred<void>()
  const aborted = deferred<void>()
  const f = await setup(async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/models') {
      entered.resolve()
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error('missing abort signal')
        const stop = () => {
          aborted.resolve()
          reject(new Error('aborted'))
        }
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
      })
    }
    return await globalThis.fetch(input, init)
  })
  let pending!: Promise<unknown>
  try {
    const reservation = f.host.reserveServiceClients(identity)!
    await expect(reservation.runBorrowed!(policy, async () => {
      const acquired = await f.plugin.client.acquire(f.registration.binding.identity)
      if (acquired.status !== 'ready') throw new Error('borrowed lease unavailable')
      pending = f.plugin.client.invoke(acquired.lease, 'models.list')
      await entered.promise
      f.plugin.client.release(acquired.lease)
    })).rejects.toThrow('managed-service-borrow-uncertain')
    await aborted.promise
    await pending
    expect((await f.plugin.client.acquire(f.registration.binding.identity)).status).toBe('unavailable')
  } finally {
    await f.close()
  }
}, 20_000)

it('fences every source when a combined reservation becomes stale during a borrow', async () => {
  const states = [{ current: true, fenced: false }, { current: true, fenced: false }]
  const source = (index: number, borrow = false) => ({
    isCurrent: () => states[index]!.current,
    release: () => true,
    fence: () => {
      states[index]!.fenced = true
      states[index]!.current = false
    },
    ...(borrow ? { runBorrowed: async <T>(_policy: typeof policy, action: () => Promise<T>) => await action() } : {}),
  })
  const reservation = reserveManagedServiceClients(identity, [() => source(0), () => source(1, true)])!
  await expect(reservation.runBorrowed!(policy, async () => {
    states[0]!.current = false
  })).rejects.toThrow('managed-service-borrow-unavailable')
  expect(states.map(state => state.fenced)).toEqual([true, true])
})
