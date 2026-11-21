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
  readonly configuredGraphs?: readonly { readonly pluginId: string; readonly moduleGeneration: string }[]
  readonly bootstrapGate?: Promise<void>
  readonly importGate?: Promise<void>
  readonly startGate?: Promise<void>
  readonly loseAck?: boolean
  readonly resume?: boolean
  readonly issueResume?: boolean
  readonly controlledPoll?: boolean
  readonly holdBindings?: boolean
  readonly modelServices?: boolean
  readonly admissionGate?: Promise<void>
  readonly credentialFailure?: boolean
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `${origin}/?host=1${input.resume ? '' : `#${entryToken}`}`,
  })
  const win = dom.window
  let beforeUnload: ((event: BeforeUnloadEvent) => void) | undefined
  const addListener = win.addEventListener.bind(win)
  Object.defineProperty(win, 'addEventListener', {
    value: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
      if (type === 'beforeunload') beforeUnload = listener as (event: BeforeUnloadEvent) => void
      addListener(type, listener, options)
    },
  })
  if (input.resume) win.sessionStorage.setItem('cordisx-manager-resume-id', 'e'.repeat(64))
  const serviceWorker = new win.EventTarget()
  Object.defineProperty(win.navigator, 'serviceWorker', { value: serviceWorker })
  const unavailable = vi.fn()
  const registry = { stage: vi.fn(), publish: vi.fn(), retire: vi.fn(), dispose: vi.fn() }
  const runtime = {
    activePluginGeneration: vi.fn(() => activation),
    configuredPluginGraphGenerations: vi.fn(() => input.configuredGraphs ?? []),
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
  let resumes = 0
  let rejectPoll: ((error: Error) => void) | undefined
  let resolvePoll: ((response: Response) => void) | undefined
  let sessionCurrent = true
  const fetch = vi.fn((path: string, options: RequestInit): Promise<Response> => {
    if (path === '/api/session') {
      return Promise.resolve(
        response({ token: sessionToken, ...(input.issueResume ? { resumeId: 'f'.repeat(64) } : {}) }),
      )
    }
    if (path === `/api/session/resume/${'e'.repeat(64)}`) {
      if (resumes++ === 0) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'RESUME_PENDING' }), { status: 409 }))
      }
      return Promise.resolve(response({ token: sessionToken, resumeId: 'f'.repeat(64) }))
    }
    if (path === '/api/renderer/open') {
      return Promise.resolve(response({
        status: 'ok',
        rendererId,
        generation: 'owner-1',
        profileId: 'work',
        channels: [
          'config',
          ...(input.modelServices ? ['model-services'] : []),
          ...(input.credentialFailure ? ['channel-credentials'] : []),
        ],
        commands: true,
      }))
    }
    if (path === '/api/renderer/session') {
      checks++
      return Promise.resolve(
        response({ current: sessionCurrent && checks !== input.invalidSessionAt, rendererId, generation: 'owner-1' }),
      )
    }
    if (path === '/api/renderer/bootstrap') {
      const result = response({
        status: 'ok',
        bundleUrl: input.bundlePath ?? '/api/renderer/bundle.js',
        initialGraphs: input.graphs ?? [],
      })
      return input.bootstrapGate
        ? Promise.race([input.bootstrapGate.then(() => result), abortResponse(options.signal!)])
        : Promise.resolve(result)
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
      if (!input.controlledPoll) return abortResponse(options.signal!)
      return new Promise((resolve, reject) => {
        resolvePoll = resolve
        rejectPoll = reject
        options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
      })
    }
    if (path === '/api/renderer/admit') {
      return new Promise((resolve, reject) => {
        allowAdmission = () => {
          void Promise.resolve(input.admissionGate).then(() => resolve(response({ admitted: true })))
        }
        options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
      })
    }
    if (path === '/api/renderer/acknowledge') {
      if (input.loseAck) return Promise.reject(new Error('lost acknowledgement'))
      allowAdmission()
      return Promise.resolve(response({ accepted: true }))
    }
    if (path === '/api/renderer/close') return Promise.resolve(response({ closed: true }))
    if (path === '/api/renderer/binding' && input.credentialFailure) {
      return Promise.resolve(new Response('{}', { status: 503 }))
    }
    if (path === '/api/renderer/binding' && input.holdBindings) return abortResponse(options.signal!)
    throw new Error(`Unexpected request ${path}`)
  })
  Object.defineProperty(win, 'fetch', { value: fetch })
  const auth = {
    start: vi.fn(async () => true),
    isBound: vi.fn(async (): Promise<boolean | undefined> => true),
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
  return {
    dom,
    win,
    serviceWorker,
    manager,
    fetch,
    auth,
    start,
    importBundle,
    unavailable,
    runtime,
    registry,
    beforeUnload: () => beforeUnload?.({ isTrusted: true } as BeforeUnloadEvent),
    failPoll: () => rejectPoll?.(new Error('navigation interrupted the poll')),
    deliverPoll: (value: unknown) => resolvePoll?.(response({ command: value })),
    pollStarted: () => rejectPoll !== undefined,
    revokeSession: () => {
      sessionCurrent = false
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

it('reports an uncertain credential write when the Manager session is lost', async () => {
  const test = fixture({ credentialFailure: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const target = test.win as unknown as Record<string, any>
    target.__cordisxChannelCredentialReceiveV1 = vi.fn()
    target.__cordisxChannelCredentialRequestV1(JSON.stringify({ requestId: 'commit', operation: 'commit' }))
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('result-unknown'))
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('keeps a slow owner bootstrap alive while it builds the initial bundle', async () => {
  vi.useFakeTimers()
  const gate = deferred<void>()
  const test = fixture({ bootstrapGate: gate.promise })
  try {
    await vi.advanceTimersByTimeAsync(0)
    const request = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/bootstrap')
    expect(request).toBeDefined()
    await vi.advanceTimersByTimeAsync(21_000)
    expect(request![1].signal!.aborted).toBe(false)
    expect(test.unavailable).not.toHaveBeenCalled()
    gate.resolve()
    expect(await test.manager.ready).toBe(true)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('recovers a refreshed tab only after the old renderer is confirmed retired', async () => {
  const test = fixture({ resume: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const requests = test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))
    expect(requests).toHaveLength(2)
    expect(requests.every(([, options]) => options.credentials === 'same-origin')).toBe(true)
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/session')).toBe(false)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('preserves refresh authority if navigation aborts an idle poll before pagehide', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.beforeUnload()
    test.failPoll()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not preserve refresh authority while a possible write is in flight', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    Object.assign(test.win, { __cordisxConfigReceiveV1: vi.fn() })
    ;(test.win as unknown as { __cordisxConfigRequestV1(value: string): void }).__cordisxConfigRequestV1(
      JSON.stringify({ requestId: 'pending-write' }),
    )
    test.beforeUnload()
    test.failPoll()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({})
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
    expect(test.unavailable).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('revokes bindings and resources before acknowledging an owner quiescence command', async () => {
  const test = fixture({ controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.deliverPoll({ id: 'e'.repeat(64), sequence: 2, method: 'quiesce', payload: { fenceId: 'f'.repeat(64) } })
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledOnce())
    const acknowledgements = test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')
    expect(acknowledgements).toHaveLength(2)
    expect(JSON.parse(String(acknowledgements[1]![1].body))).toMatchObject({
      receipt: {
        ok: true,
        value: { fenceId: 'f'.repeat(64), rendererId, ownerGeneration: 'owner-1', quiesced: true },
      },
    })
    expect(test.auth.revokeLocal).toHaveBeenCalled()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
    expect(test.registry.dispose).toHaveBeenCalledOnce()
    expect((test.win as unknown as Record<string, unknown>).__cordisxConfigRequestV1).toBeUndefined()
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('refuses a positive quiescence receipt while a possible write is in flight', async () => {
  const test = fixture({ controlledPoll: true, holdBindings: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    Object.assign(test.win, { __cordisxConfigReceiveV1: vi.fn() })
    ;(test.win as unknown as { __cordisxConfigRequestV1(value: string): void }).__cordisxConfigRequestV1(
      JSON.stringify({ requestId: 'pending-write' }),
    )
    test.deliverPoll({ id: 'e'.repeat(64), sequence: 2, method: 'quiesce', payload: { fenceId: 'f'.repeat(64) } })
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledOnce())
    const acknowledgements = test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')
    expect(acknowledgements).toHaveLength(2)
    expect(JSON.parse(String(acknowledgements[1]![1].body))).toMatchObject({ receipt: { ok: false } })
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('admits a configured graph only when the actual runtime confirms its exact generation', async () => {
  const baseUrl = `${origin}/api/renderer/graphs/${'e'.repeat(64)}/`
  const graph = {
    leaseId: 'f'.repeat(64),
    pluginId: 'channel',
    moduleGeneration: 'channel-1',
    baseUrl,
    entryUrl: `${baseUrl}module.js`,
    initialStyleUrls: [`${baseUrl}style.css`],
  }
  for (
    const [configuredGraphs, ready] of [
      [[{ pluginId: 'channel', moduleGeneration: 'channel-1' }], true],
      [[{ pluginId: 'channel', moduleGeneration: 'other' }], false],
      [[], false],
    ] as const
  ) {
    const test = fixture({ graphs: [graph], configuredGraphs })
    try {
      expect(await test.manager.ready).toBe(ready)
      expect(test.runtime.configuredPluginGraphGenerations).toHaveBeenCalled()
      expect(test.unavailable).toHaveBeenCalledTimes(ready ? 0 : 1)
    } finally {
      await test.manager.close()
      test.dom.window.close()
    }
  }
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

it('holds model-service writes until the standalone owner acknowledges admission', async () => {
  const admission = deferred<void>()
  const test = fixture({ modelServices: true, admissionGate: admission.promise, holdBindings: true })
  try {
    const host = test.win as unknown as Record<string, unknown>
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/admit')).toBe(true))
    host.__cordisxModelServicesReceiveV1 = vi.fn()
    ;(host.__cordisxModelServicesRequestV1 as (payload: string) => void)(
      JSON.stringify({ requestId: 'early-save', operation: 'save' }),
    )
    await Promise.resolve()
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(false)
    admission.resolve()
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
  } finally {
    admission.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
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

it('recovers a worker binding only while the owner session remains current', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    test.auth.recover.mockImplementation(async () => {
      test.auth.isBound.mockResolvedValue(true)
      return true
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(test.unavailable).not.toHaveBeenCalled()
    expect(test.auth.recover).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).not.toHaveBeenCalled()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not rebind after the owner revokes the session', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    test.revokeSession()
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

it('does not rebind when the worker binding check has an uncertain result', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(15_000)
    await test.manager.close()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.auth.recover).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retires a renderer if its owner session is revoked during worker recovery', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    test.auth.recover.mockImplementation(async () => {
      test.auth.isBound.mockResolvedValue(true)
      test.revokeSession()
      return true
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await test.manager.close()
    expect(test.auth.recover).toHaveBeenCalledOnce()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
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
