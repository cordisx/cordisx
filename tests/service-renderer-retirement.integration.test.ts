import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

it('retires a failed bootstrap before accepting new reads or renderer sessions', async () => {
  const entered = defer<void>()
  const release = defer<void>()
  let reads = 0
  const f = await fixture({
    protectProfileInputs: true,
    readDispatch: async () => {
      reads++
      if (reads === 1) {
        entered.resolve()
        await release.promise
      }
      return 'read complete'
    },
  })
  let opening: ReturnType<typeof f.sessions.open> | undefined
  try {
    expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
    const reading = f.sessions.call(f.invocation, 'fixture-read', {})
    await entered.promise
    expect(await f.call({ action: 'complete', managerOrigin: origin, graphs: [{}] })).toEqual({
      status: 'unavailable',
    })
    expect(await f.sessions.call(f.invocation, 'fixture-read', {})).toEqual({ status: 'unavailable' })
    expect(reads).toBe(1)
    const browserSessionId = secret()
    let opened = false
    opening = f.sessions.open(f.gateway, browserSessionId).then(value => {
      opened = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(opened).toBe(false)
    release.resolve()
    expect(await reading).toEqual({ status: 'unavailable' })
    expect(await f.sessions.revoke(f.gateway, f.invocation.browserSessionId)).toBe(true)
    const handle = await opening
    expect(handle).toBeDefined()
    const next = { gateway: f.gateway, browserSessionId, handle: handle! }
    expect(await f.sessions.call(next, 'manager-bootstrap', { action: 'prepare' })).toMatchObject({ status: 'ok' })
  } finally {
    release.resolve()
    await opening?.catch(() => undefined)
    await f.close()
  }
}, 30_000)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'waits for a late bootstrap and profile locks before acknowledging renderer retirement',
  async () => {
    const f = await fixture({ delayLease: true, protectProfileInputs: true })
    let opening: ReturnType<typeof f.sessions.open> | undefined
    try {
      expect(await f.install('late-protected-lease')).toMatchObject({ outcome: 'applied' })
      const pending = f.call({ action: 'prepare' })
      const lease = await f.leaseReady.promise
      const closing = f.sessions.close(f.invocation)
      await vi.waitFor(() => expect(f.sessions.hasLiveRenderers()).toBe(true))
      let opened = false
      opening = f.sessions.open(f.gateway, secret()).then(value => {
        opened = true
        return value
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(opened).toBe(false)
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      f.releaseLease.resolve()
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(await closing).toBe(true)
      expect((await fetch(lease.entryUrl)).status).toBe(404)
      expect(await opening).toBeDefined()
    } finally {
      f.releaseLease.resolve()
      await opening?.catch(() => undefined)
      await f.close()
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'retains profile locks until a disconnected renderer write has finished',
  async () => {
    const started = defer<void>()
    const finish = defer<void>()
    const f = await fixture({
      protectProfileInputs: true,
      writeDispatch: async () => {
        started.resolve()
        await finish.promise
        return 'possibly committed'
      },
    })
    const addPlugin = async () =>
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)
    let opening: ReturnType<typeof f.sessions.open> | undefined
    try {
      expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
      const write = f.sessions.call(f.invocation, 'fixture-write', {})
      await started.promise
      const closing = f.sessions.close(f.invocation)
      await new Promise<void>(resolve => setImmediate(resolve))
      await expect(addPlugin()).rejects.toThrow('plugin configuration is in use')
      let opened = false
      opening = f.sessions.open(f.gateway, secret()).then(value => {
        opened = true
        return value
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(opened).toBe(false)
      finish.resolve()
      expect(await write).toEqual({ status: 'unknown' })
      expect(await closing).toBe(false)
      expect(await opening).toBeUndefined()
      await addPlugin()
      expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
    } finally {
      finish.resolve()
      await opening?.catch(() => undefined)
      await f.close()
    }
  },
  30_000,
)
