import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { startStandaloneManager } from '../packages/cli/src/independent-manager/standalone-client.js'

const entryToken = 'a'.repeat(64)
const sessionToken = 'b'.repeat(64)
const rendererId = 'c'.repeat(64)
const commandId = 'd'.repeat(64)
const origin = 'http://127.0.0.1:43123'
const activation = {
  recordKind: 'active',
  profileId: 'work',
  runtimeGeneration: 'owner-1',
  revision: 0,
  lastGoodRevision: 0,
  plugins: [],
}
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

function abortResponse(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error('closed'))
    signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(input: {
  readonly invalidSessionAt?: number
  readonly bundlePath?: string
  readonly graphs?: readonly unknown[]
  readonly importGate?: Promise<void>
  readonly startGate?: Promise<void>
  readonly loseAck?: boolean
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${origin}/?host=1#${entryToken}` })
  const win = dom.window
  const serviceWorker = new win.EventTarget()
  Object.defineProperty(win.navigator, 'serviceWorker', { value: serviceWorker })
  const unavailable = vi.fn()
  const registry = { stage: vi.fn(), publish: vi.fn(), retire: vi.fn(), dispose: vi.fn() }
  const runtime = {
    activePluginGeneration: vi.fn(() => activation),
    pluginRegistryEpoch: vi.fn(() => 3),
    settleRegistryProjection: vi.fn(async () => {}),
    adoptRecoveredActivation: vi.fn(),
    stagePluginMutation: vi.fn(),
    publishPluginMutation: vi.fn(),
    completePluginMutation: vi.fn(),
    finalizePluginMutation: vi.fn(),
    rollbackPluginMutation: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
  let allowAdmission!: () => void
  let checks = 0
  let polls = 0
  const fetch = vi.fn((path: string, options: RequestInit): Promise<Response> => {
    if (path === '/api/session') return Promise.resolve(response({ token: sessionToken }))
    if (path === '/api/renderer/open') {
      return Promise.resolve(response({
        status: 'ok',
        rendererId,
        generation: 'owner-1',
        profileId: 'work',
        channels: ['config'],
        commands: true,
      }))
    }
    if (path === '/api/renderer/session') {
      checks++
      return Promise.resolve(
        response({ current: checks !== input.invalidSessionAt, rendererId, generation: 'owner-1' }),
      )
    }
    if (path === '/api/renderer/bootstrap') {
      return Promise.resolve(
        response({
          status: 'ok',
          bundleUrl: input.bundlePath ?? '/api/renderer/bundle.js',
          initialGraphs: input.graphs ?? [],
        }),
      )
    }
    if (path === '/api/renderer/poll') {
      if (polls++ === 0) {
        return Promise.resolve(response({
          command: {
            id: commandId,
            sequence: 1,
            method: 'synchronize',
            payload: { active: activation, registryEpoch: 3 },
          },
        }))
      }
      return abortResponse(options.signal!)
    }
    if (path === '/api/renderer/admit') {
      return new Promise((resolve, reject) => {
        allowAdmission = () => resolve(response({ admitted: true }))
        options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
      })
    }
    if (path === '/api/renderer/acknowledge') {
      if (input.loseAck) return Promise.reject(new Error('lost acknowledgement'))
      allowAdmission()
      return Promise.resolve(response({ accepted: true }))
    }
    if (path === '/api/renderer/close') return Promise.resolve(response({ closed: true }))
    throw new Error(`Unexpected request ${path}`)
  })
  Object.defineProperty(win, 'fetch', { value: fetch })
  const auth = {
    start: vi.fn(async () => true),
    isBound: vi.fn(async () => true),
    recover: vi.fn(async () => true),
    revokeLocal: vi.fn(async () => true),
  }
  const createResourceAuth = vi.fn((config: { isSessionCurrent: () => Promise<boolean> }) => {
    auth.start.mockImplementation(async () => await config.isSessionCurrent())
    return auth
  })
  const start = vi.fn(async () => {
    await input.startGate
    Object.assign(win, { __cordisxRuntime: runtime, __cordisxPluginGenerationResourcesV1: registry })
    return runtime
  })
  const importBundle = vi.fn(async () => {
    await input.importGate
    return { startStandaloneManagerComposition: start }
  })
  const manager = startStandaloneManager({
    window: win as unknown as Window,
    onUnavailable: unavailable,
    createResourceAuth: createResourceAuth as never,
    importBundle: importBundle as never,
  })
  return { dom, win, serviceWorker, manager, fetch, auth, start, importBundle, unavailable, runtime, registry }
}

afterEach(() => {
  vi.useRealTimers()
})

it('authenticates once and admits the existing runtime after synchronizing its actual snapshot', async () => {
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    expect(test.win.location.href).toBe(`${origin}/?host=1`)
    expect(test.start).toHaveBeenCalledOnce()
    expect(typeof (test.win as unknown as Record<string, unknown>).__cordisxConfigRequestV1).toBe('function')
    const paths = test.fetch.mock.calls.map(call => call[0])
    expect(paths.indexOf('/api/renderer/poll')).toBeLessThan(paths.indexOf('/api/renderer/admit'))
    const ack = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/acknowledge')!
    expect(JSON.parse(String(ack[1].body))).toEqual({
      receipt: {
        id: commandId,
        sequence: 1,
        ok: true,
        value: { active: activation, registryEpoch: 3 },
      },
    })
    expect(test.runtime.activePluginGeneration).toHaveBeenCalled()
    expect(test.runtime.pluginRegistryEpoch).toHaveBeenCalled()
    expect(test.importBundle).toHaveBeenCalledWith('/api/renderer/bundle.js')
    for (const [path, options] of test.fetch.mock.calls) {
      expect(path).not.toContain(sessionToken)
      expect(String(options.body)).not.toContain(sessionToken)
      if (path !== '/api/session') {
        expect(options.headers).toMatchObject({ authorization: `Bearer ${sessionToken}` })
      }
    }
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
  expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
  expect(test.runtime.dispose).toHaveBeenCalledOnce()
  expect(test.registry.dispose).toHaveBeenCalledOnce()
  expect(test.unavailable).not.toHaveBeenCalled()
})

it('does not start the imported composition after owner authority changes', async () => {
  const test = fixture({ invalidSessionAt: 2 })
  try {
    expect(await test.manager.ready).toBe(false)
    await test.manager.close()
    expect(test.importBundle).toHaveBeenCalledOnce()
    expect(test.start).not.toHaveBeenCalled()
    expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/close')).toHaveLength(1)
    expect(test.unavailable).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('closes during import without allowing a late module to start', async () => {
  const gate = deferred<void>()
  const test = fixture({ importGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.importBundle).toHaveBeenCalledOnce())
    await test.manager.close()
    gate.resolve()
    expect(await test.manager.ready).toBe(false)
    expect(test.start).not.toHaveBeenCalled()
    expect(test.unavailable).not.toHaveBeenCalled()
    expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('disposes a composition that completes after the session was closed', async () => {
  const gate = deferred<void>()
  const test = fixture({ startGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledOnce())
    await test.manager.close()
    gate.resolve()
    expect(await test.manager.ready).toBe(false)
    await vi.waitFor(() => expect(test.runtime.dispose).toHaveBeenCalledOnce())
    expect(test.registry.dispose).toHaveBeenCalledOnce()
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/admit')).toBe(false)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retires the document on a worker controller change without replay or rebind', async () => {
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.serviceWorker.dispatchEvent(new test.win.Event('controllerchange'))
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
    expect(test.auth.recover).not.toHaveBeenCalled()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retires the document if a worker loses its in-memory binding', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(15_000)
    await test.manager.close()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.auth.recover).not.toHaveBeenCalled()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('rejects alternate bundle URLs and mismatched owner-projected graphs', async () => {
  const forged = fixture({ bundlePath: '/other.js' })
  const badGraph = {
    leaseId: 'e'.repeat(64),
    pluginId: 'unknown-plugin',
    moduleGeneration: 'v1',
    baseUrl: `${origin}/api/renderer/graphs/${'f'.repeat(64)}/`,
    entryUrl: `${origin}/api/renderer/graphs/${'f'.repeat(64)}/index.js`,
    initialStyleUrls: [],
  }
  const mismatch = fixture({ graphs: [badGraph] })
  try {
    expect(await forged.manager.ready).toBe(false)
    expect(forged.importBundle).not.toHaveBeenCalled()
    expect(await mismatch.manager.ready).toBe(false)
    await mismatch.manager.close()
    expect(mismatch.runtime.dispose).toHaveBeenCalledOnce()
    expect(mismatch.fetch.mock.calls.some(call => call[0] === '/api/renderer/admit')).toBe(false)
  } finally {
    await forged.manager.close()
    await mismatch.manager.close()
    forged.dom.window.close()
    mismatch.dom.window.close()
  }
})

it('does not replay a lifecycle command when acknowledgement is lost', async () => {
  const test = fixture({ loseAck: true })
  try {
    expect(await test.manager.ready).toBe(false)
    await test.manager.close()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(1)
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})
