import { expect, it, vi } from 'vitest'
import { createManagerResourceAuthClient } from '../packages/cli/src/independent-manager/resource-auth-client.js'

function fixture(origin = 'http://127.0.0.1:43124') {
  const messages: Array<Record<string, unknown>> = []
  const register = vi.fn(async () => ({}))
  const worker = {
    scriptURL: origin + '/manager-resource-worker.js',
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
    location: { href: origin + '/' },
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

it('asks the fixed active worker to claim a hard-reloaded document before binding', async () => {
  const messages: Array<Record<string, unknown>> = []
  const worker = {
    scriptURL: 'http://127.0.0.1:43124/manager-resource-worker.js',
    postMessage(message: Record<string, unknown>, ports?: MessagePort[]) {
      messages.push(message)
      if (message.kind === 'claim') container.controller = worker
      else {
        ports![0]!.postMessage({ version: 1, ok: true })
        ports![0]!.close()
      }
    },
  }
  const registration = { active: worker, scope: 'http://127.0.0.1:43124/' }
  const container = {
    controller: undefined as typeof worker | undefined,
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  }
  const target = {
    location: { href: 'http://127.0.0.1:43124/' },
    navigator: { serviceWorker: container },
  } as unknown as Window
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'd'.repeat(64),
    isSessionCurrent: () => true,
  })
  expect(await client.start()).toBe(true)
  expect(messages[0]).toEqual({ version: 1, kind: 'claim' })
  expect(messages[1]).toMatchObject({ kind: 'bind', sequence: 1 })
  expect(await client.revokeLocal()).toBe(true)
})

it('does not ask an unrelated active worker to claim the page', async () => {
  const postMessage = vi.fn()
  const registration = {
    active: { scriptURL: 'http://127.0.0.1:43124/unrelated-worker.js', postMessage },
    scope: 'http://127.0.0.1:43124/',
  }
  const target = {
    location: { href: 'http://127.0.0.1:43124/' },
    navigator: {
      serviceWorker: { controller: null, register: async () => registration, ready: Promise.resolve(registration) },
    },
  } as unknown as Window
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'e'.repeat(64),
    isSessionCurrent: () => true,
  })
  expect(await client.start()).toBe(false)
  expect(postMessage).not.toHaveBeenCalled()
})

it('rejects invalid session tokens without registering a worker', () => {
  const { target, register } = fixture()
  expect(() =>
    createManagerResourceAuthClient({ window: target, sessionToken: 'not-a-session', isSessionCurrent: () => true })
  ).toThrow('manager-resource-session-invalid')
  expect(register).not.toHaveBeenCalled()
})

it('distinguishes an invalid worker health response from a confirmed missing binding', async () => {
  const { target, worker } = fixture()
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'a'.repeat(64),
    isSessionCurrent: () => true,
  })
  expect(await client.start()).toBe(true)
  worker.postMessage = (_message, ports) => {
    ports[0]!.postMessage({ version: 1 })
    ports[0]!.close()
  }
  expect(await client.isBound()).toBeUndefined()
})

it('never sends a session token to an unrelated controlling worker or an opaque origin', async () => {
  const { target, worker, messages } = fixture()
  worker.scriptURL = 'http://127.0.0.1:43124/unrelated-worker.js'
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'd'.repeat(64),
    isSessionCurrent: () => true,
  })
  expect(await client.start()).toBe(false)
  expect(messages).toEqual([])
  const opaque = { location: { href: 'file:///manager.html' }, navigator: {} } as unknown as Window
  expect(() =>
    createManagerResourceAuthClient({ window: opaque, sessionToken: 'e'.repeat(64), isSessionCurrent: () => true })
  )
    .toThrow('manager-resource-origin-invalid')
})

it('binds a remote Manager only to its own fixed worker', async () => {
  const { target, worker, messages } = fixture('https://manager.example.test')
  const client = createManagerResourceAuthClient({
    window: target,
    sessionToken: 'f'.repeat(64),
    isSessionCurrent: () => true,
  })
  worker.scriptURL = 'https://other.example.test/manager-resource-worker.js'
  expect(await client.start()).toBe(false)
  expect(messages).toEqual([])
  worker.scriptURL = 'https://manager.example.test/manager-resource-worker.js'
  expect(await client.start()).toBe(true)
  expect(messages).toEqual([{ version: 1, kind: 'bind', token: 'f'.repeat(64), sequence: 2 }])
  expect(await client.revokeLocal()).toBe(true)
})
