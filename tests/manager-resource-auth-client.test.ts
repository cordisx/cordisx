import { expect, it, vi } from 'vitest'
import { createManagerResourceAuthClient } from '../packages/cli/src/independent-manager/resource-auth-client.js'

function fixture() {
  const messages: Array<Record<string, unknown>> = []
  const register = vi.fn(async () => ({}))
  const worker = {
    scriptURL: 'http://127.0.0.1:43124/manager-resource-worker.js',
    postMessage(message: Record<string, unknown>, ports: MessagePort[]) {
      messages.push(message)
      ports[0]!.postMessage({ version: 1, ok: true })
      ports[0]!.close()
    },
  }
  const container = {
    controller: worker,
    register,
    ready: Promise.resolve({}),
  }
  const target = {
    location: { href: 'http://127.0.0.1:43124/' },
    navigator: { serviceWorker: container },
  } as unknown as Window
  return { target, messages, register, worker }
}

it('binds and explicitly recovers with the fixed worker, then erases its token on local revocation', async () => {
  const { target, messages, register } = fixture()
  const token = 'a'.repeat(64)
  const current = vi.fn(async () => true)
  const client = createManagerResourceAuthClient({ window: target, sessionToken: token, isSessionCurrent: current })
  expect(await client.start()).toBe(true)
  expect(register).toHaveBeenCalledWith('/manager-resource-worker.js', { scope: '/', updateViaCache: 'none' })
  expect(await client.isBound()).toBe(true)
  expect(await client.recover()).toBe(true)
  expect(await client.revokeLocal()).toBe(true)
  expect(await client.recover()).toBe(false)
  expect(messages).toEqual([
    { version: 1, kind: 'bind', token, sequence: 1 },
    { version: 1, kind: 'check' },
    { version: 1, kind: 'bind', token, sequence: 2 },
    { version: 1, kind: 'unbind', sequence: 3 },
  ])
  expect(current).toHaveBeenCalledTimes(2)
})

it('does not bind when server authority is unavailable or returns after local revocation', async () => {
  const { target, messages } = fixture()
  let resolve!: (value: boolean) => void
  const waiting = new Promise<boolean>(done => resolve = done)
  const check = vi.fn(async () => await waiting)
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'b'.repeat(64),
    isSessionCurrent: check,
  })
  const starting = client.start()
  await vi.waitFor(() => expect(check).toHaveBeenCalledOnce())
  expect(await client.revokeLocal()).toBe(true)
  resolve(true)
  expect(await starting).toBe(false)
  expect(messages).toEqual([{ version: 1, kind: 'unbind', sequence: 1 }])

  const other = fixture()
  const denied = createManagerResourceAuthClient({
    window: other.target,
    sessionToken: 'c'.repeat(64),
    isSessionCurrent: async () => false,
  })
  expect(await denied.start()).toBe(false)
  expect(other.messages).toEqual([])
})

it('rejects invalid session tokens without registering a worker', () => {
  const { target, register } = fixture()
  expect(() =>
    createManagerResourceAuthClient({ window: target, sessionToken: 'not-a-session', isSessionCurrent: () => true })
  ).toThrow('manager-resource-session-invalid')
  expect(register).not.toHaveBeenCalled()
})

it('never sends a session token to another controlling worker or a non-loopback origin', async () => {
  const { target, worker, messages } = fixture()
  worker.scriptURL = 'http://127.0.0.1:43124/unrelated-worker.js'
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'd'.repeat(64),
    isSessionCurrent: () => true,
  })
  expect(await client.start()).toBe(false)
  expect(messages).toEqual([])
  const remote = { location: { href: 'https://example.test/' }, navigator: {} } as unknown as Window
  expect(() =>
    createManagerResourceAuthClient({ window: remote, sessionToken: 'e'.repeat(64), isSessionCurrent: () => true })
  )
    .toThrow('manager-resource-origin-invalid')
})
